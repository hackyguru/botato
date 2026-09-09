//! Per-bot sandbox desktops.
//!
//! One Linux container per bot, driven entirely through the `docker` CLI — no
//! shell, no platform-specific scripting — so macOS, Linux, and Windows hosts
//! all take the same path. Ports are published on the host loopback only.

use std::collections::{HashMap, HashSet};
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

/// What the image was built from, written onto the image as a label and checked
/// before it is reused.
///
/// The tag alone cannot answer "is this image current". It is `:1` and has been
/// since the first commit, while the build context has changed three times
/// since — so every machine that built a desktop before one of those changes
/// kept running the old one for ever, and nothing said so. The only way out was
/// a Rebuild button you would press only if you already suspected.
///
/// So the stamp is the content: a hash of every file the build reads. Change
/// the Dockerfile, change the stamp, and the next desktop that starts rebuilds
/// itself. Nobody has to remember to bump anything, which is the part a
/// hand-kept version number gets wrong.
const LAYER_LABEL: &str = "com.botcage.desktop-layer";

/// Bumped by hand only to force a rebuild the build context cannot explain —
/// a new `debian:bookworm-slim` under the same tag being the likely reason.
const LAYER_EPOCH: u32 = 1;
const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// Minutes of disuse before a desktop stops itself; 0 disables reaping. Bots
/// may switch their own machines on, so something has to switch them off.
static IDLE_MINUTES: Mutex<u64> = Mutex::new(20);

#[tauri::command]
pub fn set_idle_limit(minutes: u64) {
    *IDLE_MINUTES.lock().unwrap() = minutes;
}

/// Bots whose desktop is mid-launch, so a double click can't start two.
#[derive(Default)]
pub struct Sandboxes(Mutex<HashSet<String>>);

/// When each desktop was last wanted — by a turn, the panel, or a start.
static LAST_USED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

pub fn touch(bot_id: &str) {
    let mut guard = LAST_USED.lock().unwrap();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(bot_id.to_string(), Instant::now());
}

/// The panel calls this while it is connected, so a desktop you are watching is
/// never reaped out from under you.
#[tauri::command]
pub fn sandbox_keepalive(bot_id: String) {
    touch(&bot_id);
}

fn idle_for(bot_id: &str) -> Duration {
    let mut guard = LAST_USED.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    match map.get(bot_id) {
        Some(seen) => seen.elapsed(),
        None => {
            // First sighting: give it a full window rather than reaping at once.
            map.insert(bot_id.to_string(), Instant::now());
            Duration::ZERO
        }
    }
}

/// Stop desktops nobody has touched for a while. Started once, runs for the
/// life of the app.
pub fn start_reaper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let Ok(out) = docker(&[
            "ps",
            "--format",
            "{{.Names}}",
            "--filter",
            "label=botcage=1",
        ]) else {
            continue;
        };
        for name in stdout_of(&out).lines() {
            let Some(bot) = name.strip_prefix("botcage-") else {
                continue;
            };
            let limit = *IDLE_MINUTES.lock().unwrap();
            if limit > 0 && idle_for(bot) > Duration::from_secs(limit * 60) {
                let _ = docker(&["stop", "-t", "6", name]);
            }
        }
    });
}

/* -------------------------------------------------------------- docker CLI */

#[cfg(windows)]
#[cfg(not(windows))]

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
/// Any of these will do. botcage issues about a dozen ordinary subcommands —
/// run, ps, start, stop, rm, exec, build, port, inspect, volume — which podman
/// and nerdctl implement with the same syntax, so Docker Desktop is one option
/// rather than the requirement. Ordered by what is likeliest to already be set
/// up, not by preference.
#[cfg(not(target_os = "windows"))]
const ENGINES: &[&str] = &["docker", "podman", "nerdctl"];
#[cfg(target_os = "windows")]
const ENGINES: &[&str] = &["docker.exe", "podman.exe", "nerdctl.exe"];

/// Set once the app is up, so the sandbox layer can reach the engine botcage
/// installed without every call needing an AppHandle.
static MANAGED: Mutex<Option<(PathBuf, Option<String>)>> = Mutex::new(None);

/// Remember botcage's own engine, and where its socket lives. Called at startup
/// and after an install, so a fresh install is used without a restart.
pub fn use_managed_engine(client: Option<PathBuf>, host: Option<String>) {
    *MANAGED.lock().unwrap() = client.map(|path| (path, host));
    // The engine chosen a moment ago was chosen without this one existing.
    *CHOSEN.lock().unwrap() = None;
}

/// Does this engine actually answer?
///
/// A client on disk is not an engine. Docker Desktop leaves its CLI installed
/// whether or not anything is running behind it, so choosing by "the file
/// exists" picks a dead one — and then the only thing left to tell somebody is
/// to go and start Docker, which is the one thing this app exists not to ask.
fn answers(bin: &Path) -> bool {
    served_by(bin).is_some()
}

/// Ask an engine what version it is serving, in the two shapes engines answer.
///
/// `{{.Server.Version}}` is Docker's, and it is the right first question — but
/// it is Docker's alone. The engine botcage installs on Linux is rootless
/// podman, which has no daemon at all and fills `.Server` only when it is
/// talking to a service, so the same call against a perfectly healthy podman
/// can come back empty or fail. Asked only that way, Linux would report its own
/// working engine as one that had stopped answering, and go on reporting it for
/// ever.
///
/// So: Docker's question, then podman's, then the plain one. `Some("")` means
/// it answered without naming a version, which is still an engine that is
/// there — the caller wants to know whether to talk to it, not what to print.
fn served_by(bin: &Path) -> Option<String> {
    let ask = |args: &[&str]| -> Option<String> {
        let mut cmd = Command::new(bin);
        cmd.args(args);
        with_socket(&mut cmd);
        quiet(&mut cmd);
        let out = cmd.output().ok()?;
        out.status.success().then(|| stdout_of(&out))
    };

    for args in [
        &["version", "--format", "{{.Server.Version}}"][..],
        &["info", "--format", "{{.Version.Version}}"][..],
        &["info", "--format", "{{.ServerVersion}}"][..],
    ] {
        if let Some(said) = ask(args) {
            if !said.is_empty() {
                return Some(said);
            }
        }
    }
    // Answered, but would not name itself. Rare, and not a reason to call a
    // running engine dead.
    ask(&["info"]).map(|_| String::new())
}

/// The engine chosen for this run, so the probe above is paid for once rather
/// than on every command. Cleared when botcage installs one of its own.
static CHOSEN: Mutex<Option<PathBuf>> = Mutex::new(None);

fn locate_docker() -> Option<PathBuf> {
    if let Some(chosen) = CHOSEN.lock().unwrap().clone() {
        if chosen.is_file() {
            return Some(chosen);
        }
    }
    let found = pick_engine();
    *CHOSEN.lock().unwrap() = found.clone();
    found
}

fn pick_engine() -> Option<PathBuf> {
    // botcage's own engine first: if the user let us install one, that is the
    // one they expect to be running, whatever else happens to be on PATH — and
    // if it is not running botcage can start it, which is not true of anyone
    // else's.
    if let Some((path, _)) = MANAGED.lock().unwrap().clone() {
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(raw) = std::env::var_os("DOCKER_BIN") {
        let explicit = PathBuf::from(raw);
        if explicit.is_file() {
            return Some(explicit);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(ENGINES.iter().map(|engine| dir.join(engine)));
        }
    }
    // A Finder-launched app inherits almost no PATH, so probe the usual homes of
    // each engine as well.
    candidates.extend(
        [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/usr/bin/docker",
            "/usr/local/bin/podman",
            "/opt/homebrew/bin/podman",
            "/usr/bin/podman",
            "/usr/local/bin/nerdctl",
            "/opt/homebrew/bin/nerdctl",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
            r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        ]
        .iter()
        .map(PathBuf::from),
    );
    candidates.push(home().join(".docker/bin/docker"));
    candidates.push(home().join(".orbstack/bin/docker"));
    candidates.push(home().join(".rd/bin/docker"));

    // Only one that answers. Somebody else's stopped engine is not a reason to
    // ask the person to start it — it is a reason to look past it and let
    // botcage set up the machine it carries. Nothing answering returns nothing,
    // and nothing is what makes the window offer its own.
    candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .find(|candidate| answers(candidate))
}

/// A docker command, pointed at the engine botcage manages.
///
/// The only place a docker process is constructed. It used not to be: the
/// image build assembled its own, and so ran against whatever daemon the CLI
/// defaults to — Docker Desktop, usually — while every other call went to the
/// managed engine in its VM. On a machine with only one daemon those are the
/// same thing and nothing looks wrong. On a machine with both, the image is
/// built into one engine and looked for in another, which fails as "pull
/// access denied for botcage/desktop" — a message about a registry, for a
/// local image that exists a few hundred megabytes away.
fn docker_cmd(args: &[&str]) -> Result<Command, String> {
    let bin = locate_docker().ok_or("Docker CLI not found")?;
    let mut cmd = Command::new(bin);
    // The policy goes straight after the subcommand, where podman expects a
    // flag and where docker would never see one — it is only ever added when
    // the bundled policy.json is actually there, which only the podman bundle
    // has.
    match (args.first().copied(), signature_policy()) {
        (Some(sub @ ("build" | "pull")), Some(policy)) => {
            cmd.arg(sub);
            cmd.arg(format!("--signature-policy={}", policy.display()));
            cmd.args(&args[1..]);
        }
        _ => {
            cmd.args(args);
        }
    }
    with_socket(&mut cmd);
    quiet(&mut cmd);
    Ok(cmd)
}

fn docker(args: &[&str]) -> Result<Output, String> {
    docker_cmd(args)?
        .output()
        .map_err(|e| format!("docker {}: {e}", args.join(" ")))
}

/// Sign the bot's CLI in, or sign it out, inside a container that is already
/// running. Baking the credential in at creation could not answer the ordinary
/// case — granting a service to a bot that already has a desktop — and left a
/// revoked grant still working until the container was recreated.
pub fn sync_github(bot_id: &str, token: Option<&str>) {
    let name = container_of(bot_id);
    if container_running(&name) != Some(true) {
        // Nothing to do: a stopped desktop is signed in when it next starts.
        return;
    }

    match token {
        Some(token) => {
            // Written straight to gh's config rather than through
            // `gh auth login --with-token`, which validates scopes and refuses
            // any token without `repo` — including the public-only ones this
            // app deliberately offers.
            let config =
                format!("github.com:\n    oauth_token: {token}\n    git_protocol: https\n");
            let _ = docker_stdin(
                &[
                    "exec",
                    "-i",
                    "-u",
                    "bot",
                    &name,
                    "sh",
                    "-c",
                    "mkdir -p ~/.config/gh && cat > ~/.config/gh/hosts.yml \
                     && chmod 600 ~/.config/gh/hosts.yml",
                ],
                &config,
            );
            // So `git push` works too, not only `gh`.
            let _ = docker(&[
                "exec",
                "-u",
                "bot",
                &name,
                "git",
                "config",
                "--global",
                "credential.helper",
                "!gh auth git-credential",
            ]);
        }
        None => {
            let _ = docker(&[
                "exec",
                "-u",
                "bot",
                &name,
                "sh",
                "-c",
                "rm -f ~/.config/gh/hosts.yml",
            ]);
        }
    }
}

/// Same as `docker`, but feeds the process stdin — used for credentials, which
/// would otherwise sit in the argument list where any process can read them.
fn docker_stdin(args: &[&str], input: &str) -> Result<Output, String> {
    let mut cmd = docker_cmd(args)?;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("docker {}: {e}", args.join(" ")))?;
    if let Some(mut pipe) = child.stdin.take() {
        use std::io::Write;
        pipe.write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    child.wait_with_output().map_err(|e| e.to_string())
}

/// On macOS the engine lives in a VM, so the client needs telling where its
/// socket is; on Linux podman talks to nothing and this does nothing.
/// A docker config of our own, beside the engine we installed.
///
/// The CLI reads `~/.docker/config.json` whoever starts it. On any machine
/// that has met Docker Desktop that file says `credsStore: desktop`, so every
/// build shells out to `docker-credential-desktop` — for a public base image
/// that needs no credentials at all. An app bundle launched by LaunchServices
/// gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, which is not where that helper
/// lives, so the build dies on the first pull with an error about credentials.
///
/// It also carries `currentContext: desktop-linux`, pointing at a daemon that
/// is not ours.
///
/// botcage installed its own engine; it keeps its own config next to it, and
/// then none of the above is our business. Written once and left alone: an
/// empty object is the whole file.
/// The directory botcage unpacked its engine into, worked back from the client
/// inside it: macOS puts docker at `<engine>/bin/docker`, the Linux podman
/// bundle puts podman at `<engine>/usr/local/bin/podman`. Told apart by the
/// shape of the path rather than by a cfg, so either can be exercised from a
/// test on either platform.
fn engine_root(client: &Path) -> Option<PathBuf> {
    let up = if client.ends_with("usr/local/bin/podman") {
        4
    } else {
        2
    };
    let mut dir = client.to_path_buf();
    for _ in 0..up {
        dir = dir.parent()?.to_path_buf();
    }
    Some(dir)
}

fn managed_root() -> Option<PathBuf> {
    let (client, _) = MANAGED.lock().unwrap().clone()?;
    engine_root(&client)
}

/// podman, told where its own parts are.
///
/// The static bundle ships conmon at `<engine>/usr/local/lib/podman/conmon`,
/// but podman looks for it at absolute system paths — `/usr/libexec/podman`,
/// `/usr/local/lib/podman` and so on. botcage does not install to `/`, so on a
/// machine with no podman of its own every `podman info` fails with "could not
/// find a working conmon binary". That is the first rung of `served_by`, so
/// `answers()` says no, `pick_engine` walks past the engine botcage just
/// installed, and the app reports it has none.
///
/// Written once beside the engine. Storage is deliberately not configured: the
/// bundled storage.conf points at `/var/lib/containers`, which is the rootful
/// location, and podman's own rootless defaults under the user's home are
/// right.
fn containers_conf(root: &Path) -> Option<PathBuf> {
    let conmon = root.join("usr/local/lib/podman/conmon");
    if !conmon.is_file() {
        return None; // not the podman bundle — nothing to point anywhere
    }
    let path = root.join("botcage-containers.conf");
    if !path.is_file() {
        let helpers = root.join("usr/local/lib/podman");
        let bin = root.join("usr/local/bin");
        let body = format!(
            "[engine]\n\
             cgroup_manager = \"cgroupfs\"\n\
             conmon_path = [\"{}\"]\n\
             helper_binaries_dir = [\"{}\", \"{}\"]\n\
             runtime = \"crun\"\n\
             \n\
             [engine.runtimes]\n\
             crun = [\"{}\"]\n\
             runc = [\"{}\"]\n",
            conmon.display(),
            helpers.display(),
            bin.display(),
            bin.join("crun").display(),
            bin.join("runc").display(),
        );
        std::fs::write(&path, body).ok()?;
    }
    Some(path)
}

fn managed_config(client: &Path) -> Option<PathBuf> {
    let dir = engine_root(client)?.join("docker-config");
    if !dir.join("config.json").is_file() {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(dir.join("config.json"), "{}\n").ok()?;
    }
    Some(dir)
}

fn with_socket(cmd: &mut Command) {
    let managed = MANAGED.lock().unwrap().clone();
    let Some((client, host)) = managed else {
        return;
    };
    if let Some(host) = host {
        cmd.env("DOCKER_HOST", host);
    }
    if let Some(dir) = managed_config(&client) {
        cmd.env("DOCKER_CONFIG", dir);
    }

    // And the same for podman, which needs three things pointed at the bundle
    // rather than at the machine. Docker ignores all of them, so there is no
    // need to ask which engine this is.
    if let Some(root) = engine_root(&client) {
        if let Some(conf) = containers_conf(&root) {
            cmd.env("CONTAINERS_CONF", conf);
        }
        // Without this, `FROM debian:bookworm-slim` is refused: podman will not
        // guess that an unqualified name means Docker Hub, and says so as
        // "short-name did not resolve to an alias".
        let registries = root.join("etc/containers/registries.conf");
        if registries.is_file() {
            cmd.env("CONTAINERS_REGISTRIES_CONF", registries);
        }
    }
}

/// podman refuses to build or pull without a signature policy and looks for one
/// only in `~/.config/containers` and `/etc/containers`. The bundle ships a
/// perfectly good one; this is the path to it, when the engine in use is that
/// bundle. There is no environment variable for it, so it goes on the command.
fn signature_policy() -> Option<PathBuf> {
    let path = managed_root()?.join("etc/containers/policy.json");
    path.is_file().then_some(path)
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
    // Once more if the engine we had chosen has since stopped: the first look
    // forgets it, the second picks again with it out of the way. Without this
    // the answer to "is there an engine" is a report about the one that just
    // died, when the useful answer is that botcage can supply one.
    let first = docker_look();
    if first.version.is_none() && CHOSEN.lock().unwrap().is_none() {
        return docker_look();
    }
    first
}

fn docker_look() -> DockerInfo {
    let Some(bin) = locate_docker() else {
        return DockerInfo {
            path: None,
            version: None,
            // Not a list of things to go and install. botcage carries its own
            // engine and the pane beside this offers to set it up — telling
            // somebody to fetch Docker Desktop instead is asking them to solve
            // a problem this app already solved, in vocabulary they may have no
            // reason to know.
            error: Some(
                "No machine for bots to work on yet. botcage can set one up — nothing else \
                 needs installing."
                    .into(),
            ),
        };
    };

    // Ours, or something that happened to be on the machine. The difference
    // decides what there is to say when it does not answer.
    let ours = MANAGED
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|(managed, _)| *managed == bin);
    let engine = bin
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "engine".into());

    match served_by(&bin) {
        Some(version) => DockerInfo {
            path: Some(bin.display().to_string()),
            version: Some(format!("{engine} {version}").trim_end().to_string()),
            error: None,
        },
        // Chosen because it answered, and it has since stopped — a laptop that
        // slept, or Docker Desktop quit while botcage was open. Rare, and it
        // still does not ask anybody to go and start anything: the engine is
        // forgotten so the next attempt picks again, and picking again with
        // nothing running is what offers botcage's own.
        None => {
            *CHOSEN.lock().unwrap() = None;
            DockerInfo {
                path: Some(bin.display().to_string()),
                version: None,
                // Which engine this is decides what to offer. botcage's own is
                // installed and asleep, and the answer is to wake it; anybody
                // else's is theirs to start, and offering to install ours is
                // the useful thing left to say.
                error: Some(if ours {
                    "botcage's engine is asleep. Starting it…".to_string()
                } else {
                    format!(
                        "{engine} is not answering. botcage can set up a machine of its own — \
                         it needs nothing else installed."
                    )
                }),
            }
        }
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
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
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
    let Ok(meta) = std::fs::metadata(dir) else {
        return;
    };
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
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.into(), Duration::from_millis(700))
    else {
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
        // Where the bundler puts it when the resource is declared as a bare
        // glob rather than mapped: `../sandbox/*` climbs out of `src-tauri`,
        // and Tauri preserves that by rebuilding the path under `_up_`. The
        // config now maps it to `sandbox/` so this is not needed, and it stays
        // because the failure it caused is invisible until somebody switches on
        // a desktop in a shipped build — the dev fallback below hides it, which
        // is exactly how it shipped in the first place.
        candidates.push(resources.join("_up_").join("sandbox"));
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
    docker(&["image", "inspect", IMAGE])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A stamp for the build context: every file in it, by name and by content.
///
/// Sorted, and with the name hashed alongside the bytes, so that renaming a
/// file or swapping two of them is a different stamp rather than the same one.
/// Directories are not walked: the context is flat and a nested one would be a
/// change to this function, not something to guess at.
fn context_stamp(dir: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read the build context: {e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();

    let mut hasher = Sha256::new();
    hasher.update(LAYER_EPOCH.to_le_bytes());
    for path in &files {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("unreadable name in the build context: {}", path.display()))?;
        let body = std::fs::read(path).map_err(|e| format!("cannot read {name}: {e}"))?;
        hasher.update(name.as_bytes());
        // The length, so that two files cannot be concatenated into the same
        // digest as one longer file with the same bytes.
        hasher.update(u64::try_from(body.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(&body);
    }
    // Half of it. This identifies a build context, and 128 bits is far past the
    // point where two of ours collide.
    Ok(hex(&hasher.finalize()[..16]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The stamp on the image that is actually installed, if there is one.
///
/// An image built before this existed carries no label, which reads as `None`
/// and so as stale — which is right: those are exactly the old desktops this
/// was written to notice.
fn image_stamp() -> Option<String> {
    let out = docker(&[
        "image",
        "inspect",
        IMAGE,
        "-f",
        &format!("{{{{index .Config.Labels \"{LAYER_LABEL}\"}}}}"),
    ])
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let stamp = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // `docker inspect` prints "<no value>" for a label that is not there, and
    // podman prints an empty line. Neither is a stamp.
    if stamp.is_empty() || stamp == "<no value>" {
        None
    } else {
        Some(stamp)
    }
}

/// The stamp on one bot's existing desktop, if it has one.
///
/// Read from the container rather than from the image it names, because the two
/// come apart: rebuilding replaces the tag, and anything already created from
/// the old image goes on running it. A desktop made before this existed carries
/// no label and so counts as stale, which is the case worth catching.
fn container_stamp(name: &str) -> Option<String> {
    let out = docker(&[
        "inspect",
        "-f",
        &format!("{{{{index .Config.Labels \"{LAYER_LABEL}\"}}}}"),
        name,
    ])
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let stamp = stdout_of(&out);
    if stamp.is_empty() || stamp == "<no value>" {
        None
    } else {
        Some(stamp)
    }
}

/// Whether the installed image was built from the build context we have.
///
/// A context we cannot read is not a reason to throw away a working desktop, so
/// that answers "current" and leaves the image alone.
fn image_is_current(dir: &Path) -> bool {
    if !image_exists() {
        return false;
    }
    match context_stamp(dir) {
        Ok(want) => image_stamp().is_some_and(|have| have == want),
        Err(_) => true,
    }
}

/// Build the image, streaming progress out as log events — first run pulls a
/// Debian base and installs a desktop, so this takes minutes.
fn build_image(bot_id: &str, dir: &Path) -> Result<(), String> {
    // No `--progress plain`: that flag belongs to buildx, and buildx is a CLI
    // plugin we do not ship. On a machine with Docker Desktop it is there and
    // the build used BuildKit; on a machine without one, the same command died
    // with "unknown flag: --progress" — so this only ever worked for people who
    // already had Docker Desktop installed, which is not who the managed engine
    // is for. Plain `docker build` uses BuildKit where the plugin exists and
    // falls back to the legacy builder where it does not.
    // The stamp goes on at build time, so what the image says about itself is
    // what it was actually built from. Computed before the build rather than
    // after, so a context that changes underneath a running build cannot leave
    // an image labelled with something it does not contain.
    let stamp = context_stamp(dir)?;
    let label = format!("{LAYER_LABEL}={stamp}");
    let mut cmd = docker_cmd(&["build", "-t", IMAGE, "--label", &label, "."])?;
    cmd.current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("docker build: {e}"))?;
    let out = child.stdout.take().ok_or("no stdout on docker build")?;
    let err = child.stderr.take().ok_or("no stderr on docker build")?;
    let _ = bot_id;

    // Both streams, because which one carries the progress depends on which
    // builder answered: BuildKit narrates on stderr, the legacy builder puts
    // its steps on stdout. Reading only one is how a failed build produced
    // "see the log above" with nothing above it.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let pump = |src: Box<dyn std::io::Read + Send>, tx: std::sync::mpsc::Sender<String>| {
        std::thread::spawn(move || {
            for line in BufReader::new(src).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
    };
    let a = pump(Box::new(out), tx.clone());
    let b = pump(Box::new(err), tx);

    // The last few lines, kept only so a failure can name itself. Nothing here
    // reaches the window: hiding the build's narration in the UI was not
    // enough, because it piled up in the log and appeared the moment the state
    // stopped being "building" — so a desktop that came up and then dropped
    // showed the entire build underneath the error. The pane says one sentence
    // for the whole wait; this is for the sentence after it, if it fails.
    let mut tail: Vec<String> = Vec::new();
    for line in rx {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        tail.push(line);
        if tail.len() > 12 {
            tail.remove(0);
        }
    }
    let _ = a.join();
    let _ = b.join();

    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }

    // Say what went wrong here rather than pointing at a log that may have
    // filtered the reason away.
    let why = tail
        .iter()
        .rev()
        .find(|l| l.contains("ERROR") || l.contains("error"))
        .or_else(|| tail.last())
        .cloned()
        .unwrap_or_default();
    Err(if why.is_empty() {
        "building the sandbox image failed".into()
    } else {
        format!("building the sandbox image failed: {why}")
    })
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
        return SandboxState {
            state: "starting".into(),
            vnc_port: None,
            control_port: None,
        };
    }
    let name = container_of(&bot_id);
    match container_running(&name) {
        Some(true) => SandboxState {
            state: "running".into(),
            vnc_port: published_port(&name, "6080/tcp"),
            control_port: published_port(&name, "6081/tcp"),
        },
        _ => SandboxState {
            state: "stopped".into(),
            vnc_port: None,
            control_port: None,
        },
    }
}

/// How a bot's desktop should present itself: its own identity, and the host's
/// timezone and language, so the sandbox agrees with the machine it runs on
/// rather than sitting in UTC/en-US wherever the user actually is.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotBrand {
    name: Option<String>,
    color: Option<String>,
    timezone: Option<String>,
    locale: Option<String>,
    /// "full" (default), "no-lan", or "offline".
    network: Option<String>,
    /// "1440x900" and so on; the image defaults when absent.
    pub screen: Option<String>,
    /// How many cores the desktop reports. Set with a cpuset rather than a quota:
    /// `--cpus` throttles without changing what the machine says it has, so a
    /// page still sees every core the host owns.
    #[serde(default)]
    pub cores: Option<u32>,
    /// The browser window, which is not the same thing as the screen and differs
    /// between real people.
    #[serde(default)]
    pub window: Option<String>,
    /// Which font families exist. Enumeration and text metrics are among the
    /// heavier fingerprint signals, so this is a real difference between bots.
    #[serde(default)]
    pub fonts: Option<String>,
    /// Which browser engine the desktop runs. The single largest honest
    /// difference between two bots: a different engine differs in canvas, font
    /// metrics, JS behaviour and even TLS handshake.
    #[serde(default)]
    pub browser: Option<String>,
    /// Antialiasing, hinting and subpixel order. Ordinary display settings, and
    /// each combination rasterises text differently — which is what a canvas
    /// fingerprint is measuring.
    #[serde(default)]
    pub rendering: Option<String>,
    /// Whether this bot was granted GitHub. The token itself is fetched from the
    /// keychain here rather than carried through the frontend and the brand.
    #[serde(default)]
    pub github: Option<bool>,
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
        let result = (|| {
            let work = crate::workspace(&app_handle, &bot_id)?;
            let context = sandbox_dir(&app_handle).ok();
            let logger = |state: &str, line: &str| {
                emit_state(&app_handle, &bot_id, state, None, None);
                if !line.is_empty() {
                    emit_log(&app_handle, &bot_id, line);
                }
            };
            ensure_desktop(&bot_id, &brand, &work, context.as_deref(), &logger)
        })();
        touch(&bot_id);
        app_handle
            .state::<Sandboxes>()
            .0
            .lock()
            .unwrap()
            .remove(&bot_id);

        match result {
            Ok((vnc, control)) => {
                emit_state(&app_handle, &bot_id, "running", Some(vnc), Some(control))
            }
            Err(err) => {
                emit_log(&app_handle, &bot_id, &err);
                emit_state(&app_handle, &bot_id, "error", None, None);
            }
        }
    });

    Ok(())
}

/// Bring a bot's desktop up, creating the container if it has none. Usable
/// from the app and from the MCP server process, which has no window: the
/// caller supplies where to log and where the workspace lives.
pub fn ensure_desktop(
    bot_id: &str,
    brand: &BotBrand,
    work_dir: &Path,
    build_context: Option<&Path>,
    log: &dyn Fn(&str, &str),
) -> Result<(u16, u16), String> {
    let info = docker_info();
    if let Some(err) = info.error {
        return Err(err);
    }

    let name = container_of(bot_id);

    // Missing, or built from a build context this botcage no longer ships. The
    // second case used to be invisible: the tag never changes, so an image from
    // an older version answered "yes, present" for ever and the desktop people
    // got was the one their first install happened to build.
    // What this botcage would build right now. None when the context cannot be
    // read, which is never a reason to disturb a desktop that works.
    let want = build_context.and_then(|dir| context_stamp(dir).ok());

    let stale = match build_context {
        Some(dir) => !image_is_current(dir),
        None => !image_exists(),
    };
    if stale {
        // State only, no text: the window shows its own line for this, and two
        // sentences saying the same thing is one more than the wait needs.
        log("building", "");
        let dir =
            build_context.ok_or("the sandbox image is missing and this process cannot build it")?;
        build_image(bot_id, dir)?;
    }

    // The image is current; this bot's desktop may still not be. Rebuilding
    // moves the tag and leaves every container made from the old one alone, so
    // without this the bot keeps the desktop it has had since it was created.
    //
    // Safe to throw away: /home/bot is a named volume and ~/work is the host
    // workspace, so both outlive the container. What is lost is whatever was
    // only ever in the container's own layer, which is the stale part.
    if let Some(want) = &want {
        if container_running(&name).is_some() && container_stamp(&name).as_ref() != Some(want) {
            log("building", "Rebuilding this desktop on the new image…");
            let _ = docker(&["rm", "-f", &name]);
        }
    }

    log("starting", "");

    let (vnc, control) = match container_running(&name) {
        Some(true) => (
            published_port(&name, "6080/tcp")
                .ok_or("container is running but port 6080 isn't published")?,
            published_port(&name, "6081/tcp")
                .ok_or("container is running but port 6081 isn't published")?,
        ),
        Some(false) => {
            log("starting", "Waking the existing desktop…");
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
            log("starting", "Creating a fresh desktop…");
            let vnc = free_port()?;
            let control = free_port()?;
            // Which build context this desktop was made from, so the next
            // start can tell whether it is still the one botcage ships.
            let container_label = format!(
                "{LAYER_LABEL}={}",
                want.clone().unwrap_or_else(|| "unknown".to_string())
            );
            let volume = format!("{}:/home/bot", name);
            let vnc_map = format!("127.0.0.1:{vnc}:6080");
            let control_map = format!("127.0.0.1:{control}:6081");

            // The bot's Claude Code workspace becomes ~/work on its desktop, so
            // both halves of the bot see one set of files.
            share_with_container(work_dir);
            let work_map = format!("{}:/home/bot/work", work_dir.display());

            // Drawn into the wallpaper inside the container, so a screenshot
            // always says whose desktop it is.
            let bot_name = format!("BOT_NAME={}", brand.name.clone().unwrap_or_default());
            let bot_color = format!("BOT_COLOR={}", brand.color.clone().unwrap_or_default());
            let tz = format!("TZ={}", sane(&brand.timezone, &['/', '_', '-', '+']));
            let lang = format!("BROWSER_LANG={}", sane(&brand.locale, &['-']));
            // Pinning to a range is what makes the count visible inside; a quota
            // does not. Clamped because an out-of-range cpuset refuses to start.
            let cores = brand.cores.unwrap_or(2).clamp(1, 8);
            let cpuset = format!("0-{}", cores - 1);
            let window = format!("BROWSER_WINDOW={}", sane(&brand.window, &['x']));
            let fonts = format!("FONT_SET={}", sane(&brand.fonts, &['-']));
            let engine = format!("BROWSER_ENGINE={}", sane(&brand.browser, &['-']));
            let render = format!("TEXT_RENDER={}", sane(&brand.rendering, &['-']));

            let screen = match sane(&brand.screen, &['x']).as_str() {
                "" => "SCREEN=1440x900x24".to_string(),
                size => format!("SCREEN={size}x24"),
            };

            // Offline cuts the desktop off entirely; no-lan keeps the internet
            // but drops the private ranges, so it can't reach the home network.
            let policy = match brand.network.as_deref() {
                Some("offline") => "offline",
                Some("no-lan") => "no-lan",
                _ => "full",
            };
            let policy_env = format!("NETWORK_POLICY={policy}");
            let mut args: Vec<&str> = vec![
                "run",
                "-d",
                "--name",
                &name,
                "--label",
                "botcage=1",
                "--label",
                &container_label,
                "--shm-size",
                "512m",
                // A desktop idles at ~130MB and ~3% CPU, but a browser that
                // wanders into a spin will happily eat a core, and a runaway
                // process should never be able to starve the host.
                "--memory",
                "3g",
                "--pids-limit",
                "512",
                "-e",
                &bot_name,
                "-e",
                &bot_color,
                "-e",
                &tz,
                "-e",
                &lang,
                "-e",
                &screen,
                "-v",
                &volume,
                "-v",
                &work_map,
                "-p",
                &vnc_map,
                "-p",
                &control_map,
            ];
            args.extend(["--cpuset-cpus", &cpuset]);
            args.extend(["-e", &window]);
            args.extend(["-e", &fonts]);
            args.extend(["-e", &engine]);
            args.extend(["-e", &render]);
            args.extend(["-e", &policy_env]);
            if policy != "full" {
                // Needed to install its own egress rules, and nothing more.
                args.extend(["--cap-add", "NET_ADMIN"]);
            }
            args.push(IMAGE);

            let out = docker(&args)?;
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

    // Whatever brought the desktop up, leave it signed in to match the grant as
    // it stands right now.
    sync_github(
        bot_id,
        brand
            .github
            .unwrap_or(false)
            .then(|| crate::connectors::github_token(Some(bot_id)))
            .flatten()
            .as_deref(),
    );

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

/// Replace the container while keeping the home volume, so a new image or a
/// changed network policy takes effect without losing the bot's files.
#[tauri::command]
pub fn sandbox_rebuild(
    app: AppHandle,
    sandboxes: tauri::State<Sandboxes>,
    bot_id: String,
    brand: Option<BotBrand>,
) -> Result<(), String> {
    let _ = docker(&["rm", "-f", &container_of(&bot_id)]);
    emit_state(&app, &bot_id, "stopped", None, None);
    sandbox_start(app, sandboxes, bot_id, brand)
}

/// Called when a grant changes, so a desktop that is already running picks the
/// change up without being rebuilt.
#[tauri::command]
pub fn sandbox_sync_tools(bot_id: String, github: bool) -> Result<(), String> {
    let token = github
        .then(|| crate::connectors::github_token(Some(&bot_id)))
        .flatten();
    sync_github(&bot_id, token.as_deref());
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

/* ------------------------------------------------------- what it is holding */
// Read by the storage panel. Sizes come from the engine rather than from the
// disk: on macOS everything here lives inside the VM's own disk image, where
// the host filesystem can see one enormous file and nothing about what is in
// it. The engine can say, so it is asked.
//
// Line comments rather than a block: rustfmt reflows a multi-line /* */ to the
// left margin, and the hanging indent is the only thing making this read as
// one paragraph under the section rule above it.

/// The image every desktop is built from, by name.
#[must_use]
pub fn image_name() -> &'static str {
    IMAGE
}

/// What the desktop image occupies, or zero if there is no engine or no image.
#[must_use]
pub fn image_bytes() -> u64 {
    docker(&["image", "inspect", IMAGE, "-f", "{{.Size}}"])
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| stdout_of(&out).lines().next()?.trim().parse().ok())
        .unwrap_or(0)
}

/// Throw the image away. The next desktop to start builds it again.
pub fn remove_image() -> Result<(), String> {
    let out = docker(&["image", "rm", "-f", IMAGE])?;
    if out.status.success() {
        Ok(())
    } else {
        Err(stderr_of(&out))
    }
}

/// Every desktop that exists, running or not, as (container, bot id, bytes).
///
/// The bytes are the writable layer alone — what this desktop has added since
/// it was built. Counting the image in each would report the same few
/// gigabytes once per bot, and it is listed on its own row instead.
#[must_use]
pub fn desks() -> Vec<(String, u64)> {
    // Without `--size` here: it makes the engine measure every container to
    // print a column this does not read, and each one is measured below by
    // name anyway.
    let Ok(out) = docker(&[
        "ps",
        "-a",
        "--filter",
        "label=botcage=1",
        "--format",
        "{{.Names}}",
    ]) else {
        return Vec::new();
    };
    stdout_of(&out)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| {
            let size = docker(&["inspect", "--size", "-f", "{{.SizeRw}}", name])
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| stdout_of(&out).lines().next()?.trim().parse().ok())
                .unwrap_or(0);
            (name.to_string(), size)
        })
        .collect()
}

/// Which bot a container belongs to, given the ids of the bots there are.
/// Containers left behind by a bot that has since been deleted match nothing,
/// which is exactly the case worth showing.
#[must_use]
pub fn bot_of(container: &str, bots: &[String]) -> Option<String> {
    bots.iter()
        .find(|id| container_of(id) == container)
        .cloned()
}

/// Discard one desktop by container name, volume included.
pub fn remove_desk(container: &str) {
    let _ = docker(&["rm", "-f", container]);
    let _ = docker(&["volume", "rm", "-f", container]);
}

/// Rebuild the sandbox image on demand — the usual reason is that the image
/// changed and existing desktops should be recreated from the new one.
#[tauri::command]
pub fn rebuild_image(app: AppHandle) -> Result<(), String> {
    let dir = sandbox_dir(&app)?;
    let app_handle = app.clone();
    std::thread::spawn(move || match build_image("app", &dir) {
        Ok(()) => emit_log(&app_handle, "app", "Sandbox image rebuilt."),
        Err(err) => emit_log(&app_handle, "app", &format!("Image build failed: {err}")),
    });
    Ok(())
}

/// Best-effort: leave no desktops running after the app quits.
pub fn stop_all() {
    let Ok(out) = docker(&["ps", "-q", "--filter", "label=botcage=1"]) else {
        return;
    };
    let ids: Vec<String> = stdout_of(&out).lines().map(str::to_string).collect();
    if ids.is_empty() {
        return;
    }
    let mut args = vec!["stop", "-t", "6"];
    args.extend(ids.iter().map(String::as_str));
    let _ = docker(&args);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both of these set the one global that says which engine botcage
    /// manages, and cargo runs tests in parallel — so without this they take
    /// each other's socket and fail on the other one's expectation.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    fn socket_of(cmd: &Command) -> Option<String> {
        cmd.get_envs().find_map(|(key, value)| {
            (key == "DOCKER_HOST").then(|| value.unwrap_or_default().to_string_lossy().into_owned())
        })
    }

    /// A build context, written to a fresh directory of its own. Named, because
    /// cargo runs these in parallel and a shared path is a shared answer.
    fn context(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botcage-context-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        for (file, body) in files {
            std::fs::write(dir.join(file), body).expect("write");
        }
        dir
    }

    /// The bug all of this exists for. The tag is `botcage/desktop:1` and has
    /// never changed, while the build context has changed three times — so an
    /// image built by an older botcage answered "present" for ever and the
    /// desktop somebody got was whichever one their first install happened to
    /// build. The stamp has to move when the Dockerfile does.
    #[test]
    fn changing_the_dockerfile_changes_the_stamp() {
        let before = context(
            "edit-before",
            &[("Dockerfile", "FROM debian:bookworm-slim\n")],
        );
        let after = context(
            "edit-after",
            &[(
                "Dockerfile",
                "FROM debian:bookworm-slim\nRUN apt-get update\n",
            )],
        );
        assert_ne!(
            context_stamp(&before).expect("a stamp"),
            context_stamp(&after).expect("a stamp"),
        );
    }

    /// The other half: an unchanged context must not rebuild. A stamp that
    /// moved on its own would rebuild the desktop on every launch, which is
    /// minutes of waiting for nothing.
    #[test]
    fn an_unchanged_context_keeps_its_stamp() {
        let files: &[(&str, &str)] = &[
            ("Dockerfile", "FROM debian:bookworm-slim\n"),
            ("entrypoint.sh", "#!/bin/sh\nexec /usr/bin/x11vnc\n"),
        ];
        let one = context("same-one", files);
        let two = context("same-two", files);
        assert_eq!(
            context_stamp(&one).expect("a stamp"),
            context_stamp(&two).expect("a stamp"),
        );
    }

    /// Every file the build reads counts, not just the Dockerfile. control.py
    /// and entrypoint.sh are most of what the desktop actually is, and a change
    /// to one of those used to be just as invisible.
    #[test]
    fn a_changed_script_beside_the_dockerfile_also_counts() {
        let docker = ("Dockerfile", "FROM debian:bookworm-slim\n");
        let before = context(
            "script-before",
            &[docker, ("control.py", "print('hello')\n")],
        );
        let after = context(
            "script-after",
            &[docker, ("control.py", "print('goodbye')\n")],
        );
        assert_ne!(
            context_stamp(&before).expect("a stamp"),
            context_stamp(&after).expect("a stamp"),
        );
    }

    /// Renaming a file is a change even when the bytes in the directory are the
    /// same set, because the Dockerfile copies things in by name.
    #[test]
    fn moving_bytes_between_files_is_a_change() {
        let before = context(
            "swap-before",
            &[("Dockerfile", "FROM x\n"), ("a.sh", "one"), ("b.sh", "two")],
        );
        let after = context(
            "swap-after",
            &[("Dockerfile", "FROM x\n"), ("a.sh", "two"), ("b.sh", "one")],
        );
        assert_ne!(
            context_stamp(&before).expect("a stamp"),
            context_stamp(&after).expect("a stamp"),
        );
    }

    /// Two files must not hash as one longer file with the same bytes, which is
    /// what a digest over concatenated contents alone would do.
    #[test]
    fn a_split_is_not_the_same_as_a_join() {
        let before = context("join", &[("Dockerfile", "FROM x\n"), ("a", "onetwo")]);
        let after = context(
            "split",
            &[("Dockerfile", "FROM x\n"), ("a", "one"), ("b", "two")],
        );
        assert_ne!(
            context_stamp(&before).expect("a stamp"),
            context_stamp(&after).expect("a stamp"),
        );
    }

    /// The epoch is the hand pull for a rebuild the context cannot explain — a
    /// new base image under the same tag. It has to reach the stamp.
    #[test]
    fn the_epoch_is_part_of_the_stamp() {
        let dir = context("epoch", &[("Dockerfile", "FROM debian:bookworm-slim\n")]);
        let stamp = context_stamp(&dir).expect("a stamp");
        // Recomputed the way the constant would if it were bumped.
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update((LAYER_EPOCH + 1).to_le_bytes());
        let body = std::fs::read(dir.join("Dockerfile")).expect("read");
        hasher.update(b"Dockerfile");
        hasher.update(u64::try_from(body.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(&body);
        assert_ne!(stamp, hex(&hasher.finalize()[..16]));
    }

    /// The bug this exists to prevent, in the words of the person who hit it:
    /// the image built into one engine and looked for in another.
    ///
    /// botcage installs its own engine, which on macOS lives in a VM reached
    /// through a socket. Every docker command has to be told that, and the
    /// build was the one that was not — so on a machine that also had Docker
    /// Desktop, `docker build` succeeded against Desktop while the `docker run`
    /// after it asked the managed engine for an image it had never seen. Which
    /// it reported as "pull access denied": a message about a registry, for an
    /// image sitting on the same disk.
    ///
    /// A machine with only one daemon cannot tell the difference, which is why
    /// this survived every test on the machine it was written on.
    #[test]
    fn every_docker_command_is_pointed_at_the_engine_botcage_manages() {
        let _alone = ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        let socket = "unix:///Users/someone/.botcage/lima/botcage/sock";

        // A file that certainly exists, because `pick_engine` will not use a
        // managed client it cannot see on disk. This said /usr/local/bin/docker
        // for a fortnight: true of the machine it was written on and of the
        // Linux runner, false of a macOS one, where the whole test failed with
        // "Docker CLI not found" before reaching a single assertion — the
        // failure hiding behind an exhausted quota the entire time.
        //
        // Nothing is ever run: the point is the command that gets built, so any
        // file will do to stand in for the CLI.
        let stand_in = std::env::temp_dir().join("botcage-test-docker");
        std::fs::write(&stand_in, b"").expect("a stand-in for the docker CLI");
        use_managed_engine(Some(stand_in.clone()), Some(socket.into()));

        for args in [
            vec!["image", "inspect", IMAGE],
            vec!["build", "--progress", "plain", "-t", IMAGE, "."],
            vec!["run", "-d", "--name", "botcage-x", IMAGE],
            vec!["exec", "botcage-x", "true"],
        ] {
            let cmd = docker_cmd(&args).expect("a docker command");
            assert_eq!(
                socket_of(&cmd).as_deref(),
                Some(socket),
                "`docker {}` would run against whatever daemon the CLI defaults to",
                args.join(" ")
            );
        }

        use_managed_engine(None, None);
        let _ = std::fs::remove_file(&stand_in);
    }

    fn env_of(cmd: &Command, want: &str) -> Option<String> {
        cmd.get_envs().find_map(|(key, value)| {
            (key == want).then(|| value.unwrap_or_default().to_string_lossy().into_owned())
        })
    }

    /// The Linux engine, told where its own parts are.
    ///
    /// podman looks for conmon, a registries.conf and a policy.json at absolute
    /// system paths. botcage does not install to `/`, so a bundle unpacked into
    /// its app data directory is invisible to the binary inside it: `podman
    /// info` fails on conmon, which is the first thing `served_by` asks, so the
    /// engine botcage just installed reports itself as no engine at all. The
    /// two after it stop a build: an unqualified `FROM debian:...` is refused
    /// without registries.conf, and nothing builds at all without a policy.
    ///
    /// Found by running the real thing on Ubuntu, having shipped two releases
    /// where the Linux desktop could not start.
    #[test]
    fn the_linux_engine_is_pointed_at_its_own_parts() {
        let _alone = ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());

        // The layout podman-static unpacks into.
        let root = std::env::temp_dir().join("botcage-podman-layout");
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("usr/local/bin");
        let lib = root.join("usr/local/lib/podman");
        let etc = root.join("etc/containers");
        for dir in [&bin, &lib, &etc] {
            std::fs::create_dir_all(dir).expect("the bundle's shape");
        }
        let podman = bin.join("podman");
        for file in [
            &podman,
            &lib.join("conmon"),
            &etc.join("registries.conf"),
            &etc.join("policy.json"),
        ] {
            std::fs::write(file, b"").expect("a bundled file");
        }

        use_managed_engine(Some(podman.clone()), None);

        let cmd = docker_cmd(&["image", "inspect", IMAGE]).expect("a command");
        let conf = env_of(&cmd, "CONTAINERS_CONF").expect("podman is told where conmon is");
        assert!(
            std::fs::read_to_string(&conf)
                .unwrap()
                .contains(&lib.join("conmon").display().to_string()),
            "the generated containers.conf must name the bundled conmon"
        );
        assert_eq!(
            env_of(&cmd, "CONTAINERS_REGISTRIES_CONF").as_deref(),
            Some(etc.join("registries.conf").display().to_string().as_str()),
            "without this an unqualified FROM is refused"
        );

        // The policy is a flag rather than a variable, and only on the two
        // subcommands that read one.
        let build = docker_cmd(&["build", "-t", IMAGE, "."]).expect("a build");
        let args: Vec<String> = build
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args.first().map(String::as_str),
            Some("build"),
            "the subcommand stays first"
        );
        assert!(
            args.iter().any(|a| a.starts_with("--signature-policy=")),
            "podman will not build without one: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a.starts_with("--signature-policy="))
                || args.contains(&".".to_string()),
            "the original arguments survive"
        );

        // And nowhere else, because docker has never heard of it.
        let run = docker_cmd(&["run", "-d", IMAGE]).expect("a run");
        assert!(
            !run.get_args()
                .any(|a| a.to_string_lossy().starts_with("--signature-policy")),
            "only build and pull take a policy"
        );

        use_managed_engine(None, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// And where botcage installed nothing, it must not invent a socket: the
    /// user's own docker is the right answer then, and pointing it at a VM that
    /// does not exist would break the machines this works on today.
    #[test]
    fn an_unmanaged_engine_is_left_alone() {
        let _alone = ONE_AT_A_TIME
            .lock()
            .unwrap_or_else(|held| held.into_inner());
        use_managed_engine(None, None);
        if let Ok(cmd) = docker_cmd(&["ps"]) {
            assert_eq!(socket_of(&cmd), None);
        }
    }
}
