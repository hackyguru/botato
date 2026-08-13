//! Per-bot sandbox desktops.
//!
//! One Linux container per bot, driven entirely through the `docker` CLI — no
//! shell, no platform-specific scripting — so macOS, Linux, and Windows hosts
//! all take the same path. Ports are published on the host loopback only.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

const IMAGE: &str = "botcage/desktop:1";
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// Bots whose desktop is mid-launch, so a double click can't start two.
#[derive(Default)]
pub struct Sandboxes(Mutex<HashSet<String>>);

/* -------------------------------------------------------------- docker CLI */

#[cfg(windows)]
const DOCKER_EXE: &str = "docker.exe";
#[cfg(not(windows))]
const DOCKER_EXE: &str = "docker";

/// Keep Windows from flashing a console window for every docker call.
#[cfg(windows)]
fn quiet(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn quiet(_cmd: &mut Command) {}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// GUI apps inherit a minimal PATH on macOS and Windows, so probe the places
/// Docker Desktop, OrbStack, Colima, and distro packages actually install to.
fn locate_docker() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("DOCKER_BIN") {
        let explicit = PathBuf::from(raw);
        if explicit.is_file() {
            return Some(explicit);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(DOCKER_EXE)));
    }
    candidates.extend(
        [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/usr/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
            r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        ]
        .iter()
        .map(PathBuf::from),
    );
    candidates.push(home().join(".docker/bin/docker"));
    candidates.push(home().join(".orbstack/bin/docker"));
    candidates.push(home().join(".rd/bin/docker"));

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn docker(args: &[&str]) -> Result<Output, String> {
    let bin = locate_docker().ok_or("Docker CLI not found")?;
    let mut cmd = Command::new(bin);
    cmd.args(args);
    quiet(&mut cmd);
    cmd.output().map_err(|e| format!("docker {}: {e}", args.join(" ")))
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn stderr_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerInfo {
    path: Option<String>,
    /// Server version — present only when the daemon is actually reachable.
    version: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub fn docker_info() -> DockerInfo {
    let Some(bin) = locate_docker() else {
        return DockerInfo {
            path: None,
            version: None,
            error: Some("Docker not found — install Docker Desktop, OrbStack, or docker.io".into()),
        };
    };

    match docker(&["version", "--format", "{{.Server.Version}}"]) {
        Ok(out) if out.status.success() => DockerInfo {
            path: Some(bin.display().to_string()),
            version: Some(stdout_of(&out)),
            error: None,
        },
        Ok(_) => DockerInfo {
            path: Some(bin.display().to_string()),
            version: None,
            error: Some("Docker is installed but the daemon isn't running — start it and retry".into()),
        },
        Err(err) => DockerInfo { path: Some(bin.display().to_string()), version: None, error: Some(err) },
    }
}

/* ------------------------------------------------------------------ events */

fn emit_log(app: &AppHandle, bot_id: &str, text: &str) {
    let _ = app.emit(
        "sandbox-event",
        json!({ "botId": bot_id, "kind": "log", "text": text }),
    );
}

fn emit_state(app: &AppHandle, bot_id: &str, state: &str, vnc: Option<u16>, control: Option<u16>) {
    let _ = app.emit(
        "sandbox-event",
        json!({
            "botId": bot_id,
            "kind": "state",
            "state": state,
            "vncPort": vnc,
            "controlPort": control,
        }),
    );
}

/* ----------------------------------------------------------------- helpers */

/// Container and volume names have a restricted charset; bot ids are generated
/// but sanitise anyway so a hand-edited store can't produce an invalid name.
fn slug(bot_id: &str) -> String {
    bot_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect()
}

fn container_of(bot_id: &str) -> String {
    format!("botcage-{}", slug(bot_id))
}

/// `Some(true)` running, `Some(false)` exists but stopped, `None` no container.
fn container_running(name: &str) -> Option<bool> {
    let out = docker(&["inspect", "-f", "{{.State.Running}}", name]).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(stdout_of(&out) == "true")
}

/// The control API port for a bot whose desktop is running, if it is.
pub fn control_port_for(bot_id: &str) -> Option<u16> {
    let name = container_of(bot_id);
    match container_running(&name) {
        Some(true) => published_port(&name, "6081/tcp"),
        _ => None,
    }
}

/// Host port a container port is published on.
fn published_port(name: &str, container_port: &str) -> Option<u16> {
    let out = docker(&["port", name, container_port]).ok()?;
    stdout_of(&out)
        .lines()
        .next()?
        .rsplit(':')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// A bind mount keeps host ownership, and the desktop user inside the container
/// is uid 1000. Where the host user has a different uid and Docker doesn't remap
/// it (plain Linux, unlike Docker Desktop on macOS/Windows), the bot couldn't
/// write to its own workspace — so widen that one directory. It lives inside the
/// app's data dir and is only ever used by this user's bots.
#[cfg(unix)]
fn share_with_container(dir: &Path) {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let Ok(meta) = std::fs::metadata(dir) else { return };
    if meta.uid() == 1000 {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o777));
}

#[cfg(not(unix))]
fn share_with_container(_dir: &Path) {}

/// Ask the OS for a free port, then hand it to docker. A racing process could
/// take it in between; the caller surfaces the docker error if that happens.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

/// Docker's port proxy answers a TCP connection before anything inside the
/// container is listening, so readiness has to be a real request that the
/// desktop itself answers.
fn health_ok(port: u16) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.into(), Duration::from_millis(700)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(2000)));
    if stream
        .write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200")
}

fn wait_for_health(port: u16, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if health_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    false
}

fn wait_for_port(port: u16, deadline: Instant) -> bool {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr.into(), Duration::from_millis(500)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// The image build context: bundled next to the app in a release build, or the
/// repo's `sandbox/` directory during development.
fn sandbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("sandbox"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("sandbox"));
        candidates.push(cwd.join("../sandbox"));
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("Dockerfile").is_file())
        .ok_or_else(|| "could not find the sandbox/ build context".to_string())
}

fn image_exists() -> bool {
    docker(&["image", "inspect", IMAGE]).map(|o| o.status.success()).unwrap_or(false)
}

/// Build the image, streaming progress out as log events — first run pulls a
/// Debian base and installs a desktop, so this takes minutes.
fn build_image(app: &AppHandle, bot_id: &str, dir: &Path) -> Result<(), String> {
    let bin = locate_docker().ok_or("Docker CLI not found")?;
    let mut cmd = Command::new(bin);
    cmd.args(["build", "--progress", "plain", "-t", IMAGE, "."])
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    quiet(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("docker build: {e}"))?;
    let stderr = child.stderr.take().ok_or("no stderr on docker build")?;
    let app_handle = app.clone();
    let bot = bot_id.to_string();
    // Build progress goes to stderr; keep only step lines so the UI stays readable.
    let pump = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if line.starts_with("#") && line.contains("DONE") || line.contains("ERROR") {
                emit_log(&app_handle, &bot, &line);
            }
        }
    });

    if let Some(stdout) = child.stdout.take() {
        for _ in BufReader::new(stdout).lines().map_while(Result::ok) {}
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = pump.join();

    if status.success() {
        Ok(())
    } else {
        Err("building the sandbox image failed — see the log above".into())
    }
}

/* --------------------------------------------------------------- commands */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxState {
    state: String,
    vnc_port: Option<u16>,
    control_port: Option<u16>,
}

#[tauri::command]
pub fn sandbox_status(sandboxes: tauri::State<Sandboxes>, bot_id: String) -> SandboxState {
    if sandboxes.0.lock().unwrap().contains(&bot_id) {
        return SandboxState { state: "starting".into(), vnc_port: None, control_port: None };
    }
    let name = container_of(&bot_id);
    match container_running(&name) {
        Some(true) => SandboxState {
            state: "running".into(),
            vnc_port: published_port(&name, "6080/tcp"),
            control_port: published_port(&name, "6081/tcp"),
        },
        _ => SandboxState { state: "stopped".into(), vnc_port: None, control_port: None },
    }
}

/// How a bot's desktop should present itself: its own identity, and the host's
/// timezone and language, so the sandbox agrees with the machine it runs on
/// rather than sitting in UTC/en-US wherever the user actually is.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotBrand {
    name: Option<String>,
    color: Option<String>,
    timezone: Option<String>,
    locale: Option<String>,
}

/// Only pass values that look like what they claim to be — these become
/// environment variables and a symlink target inside the container.
fn sane(value: &Option<String>, extra: &[char]) -> String {
    value
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || extra.contains(c))
        .take(64)
        .collect()
}

#[tauri::command]
pub fn sandbox_start(
    app: AppHandle,
    sandboxes: tauri::State<Sandboxes>,
    bot_id: String,
    brand: Option<BotBrand>,
) -> Result<(), String> {
    if !sandboxes.0.lock().unwrap().insert(bot_id.clone()) {
        return Ok(()); // already coming up
    }

    let brand = brand.unwrap_or_default();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let result = launch(&app_handle, &bot_id, &brand);
        app_handle.state::<Sandboxes>().0.lock().unwrap().remove(&bot_id);

        match result {
            Ok((vnc, control)) => emit_state(&app_handle, &bot_id, "running", Some(vnc), Some(control)),
            Err(err) => {
                emit_log(&app_handle, &bot_id, &err);
                emit_state(&app_handle, &bot_id, "error", None, None);
            }
        }
    });

    Ok(())
}

fn launch(app: &AppHandle, bot_id: &str, brand: &BotBrand) -> Result<(u16, u16), String> {
    let info = docker_info();
    if let Some(err) = info.error {
        return Err(err);
    }

    let name = container_of(bot_id);

    if !image_exists() {
        emit_state(app, bot_id, "building", None, None);
        emit_log(app, bot_id, "Building the sandbox image (first run takes a few minutes)…");
        let dir = sandbox_dir(app)?;
        build_image(app, bot_id, &dir)?;
    }

    emit_state(app, bot_id, "starting", None, None);

    let (vnc, control) = match container_running(&name) {
        Some(true) => (
            published_port(&name, "6080/tcp").ok_or("container is running but port 6080 isn't published")?,
            published_port(&name, "6081/tcp").ok_or("container is running but port 6081 isn't published")?,
        ),
        Some(false) => {
            emit_log(app, bot_id, "Waking the existing desktop…");
            let out = docker(&["start", &name])?;
            if !out.status.success() {
                return Err(stderr_of(&out));
            }
            (
                published_port(&name, "6080/tcp").ok_or("port 6080 isn't published")?,
                published_port(&name, "6081/tcp").ok_or("port 6081 isn't published")?,
            )
        }
        None => {
            emit_log(app, bot_id, "Creating a fresh desktop…");
            let vnc = free_port()?;
            let control = free_port()?;
            let volume = format!("{}:/home/bot", name);
            let vnc_map = format!("127.0.0.1:{vnc}:6080");
            let control_map = format!("127.0.0.1:{control}:6081");

            // The bot's Claude Code workspace becomes ~/work on its desktop, so
            // both halves of the bot see one set of files.
            let host_work = crate::workspace(app, bot_id)?;
            share_with_container(&host_work);
            let work_map = format!("{}:/home/bot/work", host_work.display());

            // Drawn into the wallpaper inside the container, so a screenshot
            // always says whose desktop it is.
            let bot_name = format!("BOT_NAME={}", brand.name.clone().unwrap_or_default());
            let bot_color = format!("BOT_COLOR={}", brand.color.clone().unwrap_or_default());
            let tz = format!("TZ={}", sane(&brand.timezone, &['/', '_', '-', '+']));
            let lang = format!("BROWSER_LANG={}", sane(&brand.locale, &['-']));

            let out = docker(&[
                "run", "-d",
                "--name", &name,
                "--label", "botcage=1",
                "--shm-size", "512m",
                // A desktop idles at ~130MB and ~3% CPU, but a browser that
                // wanders into a spin will happily eat a core, and a runaway
                // process should never be able to starve the host.
                "--cpus", "2",
                "--memory", "3g",
                "--pids-limit", "512",
                "-e", &bot_name,
                "-e", &bot_color,
                "-e", &tz,
                "-e", &lang,
                "-v", &volume,
                "-v", &work_map,
                "-p", &vnc_map,
                "-p", &control_map,
                IMAGE,
            ])?;
            if !out.status.success() {
                return Err(stderr_of(&out));
            }
            (vnc, control)
        }
    };

    let deadline = Instant::now() + READY_TIMEOUT;
    if !wait_for_port(vnc, deadline) {
        return Err("the container started but its ports never opened".into());
    }
    // Only the control API answering proves the desktop is actually up.
    if !wait_for_health(control, deadline) {
        return Err(format!(
            "the container is running but its desktop never came up — try `docker logs {name}`"
        ));
    }

    Ok((vnc, control))
}

#[tauri::command]
pub fn sandbox_stop(app: AppHandle, bot_id: String) -> Result<(), String> {
    let name = container_of(&bot_id);
    let out = docker(&["stop", "-t", "6", &name])?;
    if !out.status.success() {
        let err = stderr_of(&out);
        if !err.contains("No such container") {
            return Err(err);
        }
    }
    emit_state(&app, &bot_id, "stopped", None, None);
    Ok(())
}

/// Discard a bot's desktop entirely, volume included. Used when a bot is deleted.
#[tauri::command]
pub fn sandbox_destroy(bot_id: String) -> Result<(), String> {
    let name = container_of(&bot_id);
    let _ = docker(&["rm", "-f", &name]);
    let _ = docker(&["volume", "rm", "-f", &name]);
    Ok(())
}

/// Best-effort: leave no desktops running after the app quits.
pub fn stop_all() {
    let Ok(out) = docker(&["ps", "-q", "--filter", "label=botcage=1"]) else { return };
    let ids: Vec<String> = stdout_of(&out).lines().map(str::to_string).collect();
    if ids.is_empty() {
        return;
    }
    let mut args = vec!["stop", "-t", "6"];
    args.extend(ids.iter().map(String::as_str));
    let _ = docker(&args);
}
