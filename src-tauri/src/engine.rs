//! A container engine botato installs and owns, so a bot's computer needs
//! nothing preinstalled — no Docker Desktop, no terminal, no admin password.
//!
//! Everything lands in botato's own data directory and nothing touches the
//! system, which is what makes it removable by deleting a folder — two, on
//! macOS, because lima's state cannot live where the rest does (see `lima_home`).
//!
//! The two platforms need genuinely different things, so this is not one
//! mechanism pretending to be portable:
//!
//! - **Linux** already runs Linux, so a static rootless podman is the whole
//!   answer: no VM, no daemon, no privileges.
//! - **macOS** cannot execute Linux binaries, so something must supply a Linux
//!   VM. Lima does, using Apple's own Virtualization framework, and the docker
//!   CLI on this side talks to it over a forwarded socket.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// One file to fetch. Hashes are pinned rather than fetched alongside the
/// download: a checksum served by whoever served the file proves only that the
/// two agree. These were verified against lima's published SHA256SUMS.
struct Artifact {
    url: &'static str,
    sha256: &'static str,
    /// Strip this many leading path components, tar-style.
    strip: usize,
    /// Subdirectory of the engine directory to unpack into. The docker archive
    /// is a bare binary once stripped, so it needs placing rather than spilling
    /// into the root.
    into: &'static str,
}

// Referenced by the test that keeps the pinned URLs and versions in step.
#[allow(dead_code)]
const LIMA_VERSION: &str = "2.2.0";
#[allow(dead_code)]
const DOCKER_VERSION: &str = "29.7.2";
#[allow(dead_code)]
const PODMAN_VERSION: &str = "5.8.4";

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const ARTIFACTS: &[Artifact] = &[
    Artifact {
        url: "https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-arm64.tar.gz",
        sha256: "bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3",
        strip: 0,
        into: "",
    },
    Artifact {
        url: "https://download.docker.com/mac/static/stable/aarch64/docker-29.7.2.tgz",
        sha256: "b8683ed19d1f06048a496f9b8429e2c71d0b088d475b7487c054ea3666c02a3c",
        strip: 1,
        into: "bin",
    },
];

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const ARTIFACTS: &[Artifact] = &[
    Artifact {
        url: "https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-x86_64.tar.gz",
        sha256: "0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31",
        strip: 0,
        into: "",
    },
    Artifact {
        url: "https://download.docker.com/mac/static/stable/x86_64/docker-29.7.2.tgz",
        sha256: "fb1f1aa7ac7af4364165b9eadfda92e96c8ced508fca74f53079719891367438",
        strip: 1,
        into: "bin",
    },
];

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const ARTIFACTS: &[Artifact] = &[Artifact {
    url: "https://github.com/mgoltzsche/podman-static/releases/download/v5.8.4/podman-linux-arm64.tar.gz",
    sha256: "a2f6b73cc0f7018e2e8518338a4ec27db70148e1af86e16719235605aefd1df3",
    into: "",
    // podman-linux-arm64/usr/local/bin/... → usr/local/bin/...
    strip: 1,
}];

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const ARTIFACTS: &[Artifact] = &[Artifact {
    url: "https://github.com/mgoltzsche/podman-static/releases/download/v5.8.4/podman-linux-amd64.tar.gz",
    sha256: "a58765fe8be6ab3fb79f892f1a027b4ce4a7e8eb589df1ef960c167cbde08d69",
    into: "",
    strip: 1,
}];

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const ARTIFACTS: &[Artifact] = &[];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// botato has an engine of its own, downloaded and verified.
    pub installed: bool,
    /// The client binary to drive it with.
    pub path: Option<String>,
    /// macOS runs the engine in a VM, which has to be started as well.
    pub needs_vm: bool,
    pub vm_running: bool,
    /// Roughly what the first install has to fetch, so the wait is not a
    /// surprise. The VM image is by far the larger half on macOS.
    pub download_mb: u64,
    pub supported: bool,
}

pub fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("engine");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The client botato should drive, if it installed one. Checked by existence
/// rather than by a marker file, so a half-finished install cannot look done.
pub fn managed_client(app: &AppHandle) -> Option<PathBuf> {
    let dir = engine_dir(app).ok()?;
    let client = if cfg!(target_os = "macos") {
        dir.join("bin").join("docker")
    } else {
        dir.join("usr").join("local").join("bin").join("podman")
    };
    client.is_file().then_some(client)
}

fn limactl(app: &AppHandle) -> Option<PathBuf> {
    let path = engine_dir(app).ok()?.join("bin").join("limactl");
    path.is_file().then_some(path)
}

/// Where lima keeps the VM. Deliberately not inside the app data directory,
/// which is the obvious place and does not work: lima puts a unix socket under
/// this directory and a unix path cannot exceed 104 bytes. Measured against the
/// real binary, `~/Library/Application Support/com.botato.app/engine/lima-home`
/// produces a 106-byte socket path for a four-letter username, and lima refuses
/// to start at all — so this lives in a short directory in the home folder, the
/// same thing colima and Rancher Desktop do for the same reason.
fn lima_home(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home directory: {e}"))?;
    Ok(lima_home_in(&home))
}

fn lima_home_in(home: &Path) -> PathBuf {
    home.join(".botato").join("lima")
}

/// The longest path lima will build under its home: the ssh socket plus the
/// 17-byte suffix it appends before checking the limit.
#[cfg(test)]
fn longest_socket_path(lima_home: &Path) -> PathBuf {
    lima_home.join(VM_NAME).join("ssh.sock.1234567890123456")
}

const VM_NAME: &str = "botato";

#[tauri::command(async)]
pub fn engine_status(app: AppHandle) -> EngineStatus {
    let client = managed_client(&app);
    let needs_vm = cfg!(target_os = "macos");
    EngineStatus {
        installed: client.is_some(),
        path: client.map(|p| p.display().to_string()),
        needs_vm,
        vm_running: needs_vm && vm_is_running(&app),
        // macOS also pulls a Linux image for the VM on first start.
        download_mb: if needs_vm { 55 + 600 } else { 30 },
        supported: !ARTIFACTS.is_empty(),
    }
}

fn vm_is_running(app: &AppHandle) -> bool {
    let (Some(bin), Ok(home)) = (limactl(app), lima_home(app)) else {
        return false;
    };
    Command::new(bin)
        .args(["list", "--format", "{{.Status}}", VM_NAME])
        .env("LIMA_HOME", home)
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "Running")
        .unwrap_or(false)
}

/// Download, verify and unpack the engine. Progress is emitted rather than
/// returned because on macOS this is minutes, not seconds.
#[tauri::command(async)]
pub fn install_engine(app: AppHandle) -> Result<String, String> {
    if ARTIFACTS.is_empty() {
        return Err("botato has no engine for this platform yet".into());
    }
    let dir = engine_dir(&app)?;
    let say = |step: &str| {
        let _ = app.emit("engine", step);
    };

    for (index, artifact) in ARTIFACTS.iter().enumerate() {
        let label = if ARTIFACTS.len() > 1 {
            format!("Downloading {} of {}", index + 1, ARTIFACTS.len())
        } else {
            "Downloading".to_string()
        };
        say(&format!("{label}…"));
        let archive = dir.join(format!("download-{index}"));
        fetch(artifact.url, &archive, &say, &label)?;

        say("Checking the download…");
        let bytes = std::fs::read(&archive).map_err(|e| e.to_string())?;
        let digest = crate::oauth::sha256(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if digest != artifact.sha256 {
            let _ = std::fs::remove_file(&archive);
            return Err(format!(
                "the download did not match its expected checksum, so it was discarded ({})",
                artifact.url
            ));
        }

        say("Unpacking…");
        let target = if artifact.into.is_empty() {
            dir.clone()
        } else {
            dir.join(artifact.into)
        };
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        unpack(&archive, &target, artifact.strip)?;
        let _ = std::fs::remove_file(&archive);
    }

    let client =
        managed_client(&app).ok_or("the engine unpacked but its client binary is missing")?;
    crate::sandbox::use_managed_engine(Some(client.clone()), docker_host(&app));
    say("Ready");
    Ok(client.display().to_string())
}

/// Download to `to`, reporting how far along it is. curl's own progress meter
/// redraws with carriage returns, which line-based reading cannot follow, so the
/// size of the growing file is the progress — it needs no parsing and cannot
/// disagree with what actually landed on disk.
pub fn download(url: &str, to: &Path, say: &dyn Fn(&str), label: &str) -> Result<(), String> {
    fetch(url, to, say, label)
}

fn fetch(url: &str, to: &Path, say: &dyn Fn(&str), label: &str) -> Result<(), String> {
    let total = content_length(url);
    let mut child = Command::new("curl")
        .args(["-fL", "--retry", "2", "-m", "900", "-o"])
        .arg(to)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run curl: {e}"))?;

    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            let mut why = String::new();
            if let Some(mut err) = child.stderr.take() {
                let _ = err.read_to_string(&mut why);
            }
            return Err(format!(
                "download failed: {}",
                why.lines().last().unwrap_or("unknown error").trim()
            ));
        }
        let got = std::fs::metadata(to).map(|m| m.len()).unwrap_or(0);
        say(&progress(label, got, total));
        std::thread::sleep(Duration::from_millis(400));
    }
}

/// The total size, so progress can be a percentage rather than a rising number.
/// Zero when the server will not say, which the caller treats as "unknown"
/// instead of guessing.
fn content_length(url: &str) -> u64 {
    // Not curl's %{content_length}: macOS ships a curl that does not have it.
    let out = match Command::new("curl").args(["-sIL", url]).output() {
        Ok(out) => out,
        Err(_) => return 0,
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<u64>().ok())?
        })
        .next_back()
        .unwrap_or(0)
}

/// lima logs for operators, not for a window: a timestamp, a level, the message
/// in quotes and trailing key=value fields. Pull out the sentence and leave the
/// rest, or return None for lines nobody should be shown.
fn readable(line: &str) -> Option<String> {
    // Two logrus layouts, depending on whether it thinks it has a terminal.
    let text = if let Some(at) = line.find("msg=") {
        if line.contains("level=debug") || line.contains("level=trace") {
            return None;
        }
        let rest = &line[at + 4..];
        match rest.strip_prefix('"') {
            Some(quoted) => unquote(quoted),
            None => rest.split_whitespace().next()?.to_string(),
        }
    } else if let Some(at) = line.find("] ") {
        let (level, message) = line.split_at(at);
        if !level.starts_with("INFO") && !level.starts_with("WARN") && !level.starts_with("ERRO") {
            return None;
        }
        // Trailing fields are separated from the message by runs of spaces.
        message[2..].split("  ").next()?.to_string()
    } else {
        line.to_string()
    };

    let text = text.trim();
    if text.is_empty() || text.starts_with("Terminal is not available") {
        return None;
    }
    Some(text.to_string())
}

/// Read a logrus-quoted value. The message itself quotes things — instance names,
/// requirement names — and those arrive escaped, so splitting on the next quote
/// truncates most lines mid-sentence.
fn unquote(rest: &str) -> String {
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some(escaped) => out.push(escaped),
                None => break,
            },
            '"' => break,
            _ => out.push(c),
        }
    }
    out
}

fn progress(label: &str, got: u64, total: u64) -> String {
    let mb = |bytes: u64| bytes as f64 / 1_048_576.0;
    if total == 0 {
        return format!("{label} — {:.0} MB so far…", mb(got));
    }
    format!(
        "{label} — {:.0} of {:.0} MB ({:.0}%)",
        mb(got),
        mb(total),
        (got as f64 / total as f64 * 100.0).min(100.0)
    )
}

fn unpack(archive: &Path, into: &Path, strip: usize) -> Result<(), String> {
    let mut cmd = Command::new("tar");
    cmd.arg("-xzf").arg(archive).arg("-C").arg(into);
    if strip > 0 {
        cmd.arg(format!("--strip-components={strip}"));
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run tar: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "could not unpack: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
}

/// Bring the Linux VM up. macOS only: on Linux the engine runs directly, so
/// this is a no-op and the caller does not have to know the difference.
#[tauri::command(async)]
pub fn start_engine(app: AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let bin = limactl(&app).ok_or("the engine is not installed yet")?;
    let home = lima_home(&app)?;
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "engine",
        "Starting the Linux machine (first run downloads it)…",
    );

    // Creating a machine and starting one that exists are the same subcommand
    // with different arguments, and passing the creating ones at an instance
    // that is already there is fatal: "instance `botato` already exists".
    //
    // Which meant this worked exactly once. The first install created the VM
    // and every later start failed — so a laptop that slept, or an app that
    // had been quit, left botato unable to bring up its own engine, reporting
    // "docker stopped answering" and offering to download six hundred
    // megabytes of something already on the disk.
    let exists = home.join(VM_NAME).is_dir();

    let mut cmd = Command::new(&bin);
    cmd.args(["start", "--name", VM_NAME, "--tty=false"]);
    if !exists {
        // vz is Apple's own hypervisor, so no QEMU is needed. virtiofs is what
        // makes a bot's workspace visible inside the VM at the same path. Only
        // on the run that creates it: afterwards these live in its config, and
        // repeating them is what lima refuses.
        cmd.args([
            "--vm-type",
            "vz",
            "--mount-type",
            "virtiofs",
            "--mount-writable",
        ])
        .arg("template:docker");
    }
    let mut child = cmd
        .env("LIMA_HOME", &home)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the machine: {e}"))?;

    // This is minutes on a first run — the image download plus a boot that waits
    // on five requirements in turn. lima says which one it is on, so relay that
    // rather than leaving one sentence on screen for the whole wait.
    let mut last = String::new();
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(step) = readable(&line) {
                let _ = app.emit("engine", &step);
            }
            last = line;
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "the machine did not start: {}",
            readable(&last).unwrap_or_else(|| last.trim().to_string())
        ));
    }
    // The socket only exists once the machine is up, so re-point the client now.
    crate::sandbox::use_managed_engine(managed_client(&app), docker_host(&app));
    let _ = app.emit("engine", "Ready");
    Ok(())
}

/// Where the docker client should look, once the VM is up. Empty on Linux,
/// where podman needs no socket.
/// Where botato's engine listens, whether or not it is listening yet.
///
/// This used to return nothing unless the socket already existed — and the
/// socket exists only while the VM is running. So the app, started on a machine
/// whose VM was asleep, recorded its own engine with no address and then ran
/// its own client against whatever `DOCKER_HOST` defaulted to: Docker Desktop's
/// socket, on a machine that had Docker Desktop installed and stopped.
///
/// Everything downstream then made sense and was wrong. The engine botato owns
/// was the one being used and the daemon being asked was somebody else's, so
/// starting the VM changed nothing, and the honest report — "docker stopped
/// answering" — named a component that was not the one at fault.
///
/// Where the socket will be is a fact about where the engine is installed, not
/// about whether it happens to be up.
/// Where the engine's two halves sit: the client botato unpacked, and the
/// Linux machine it drives on macOS. Both are wanted by the storage panel, and
/// only this module knows the second one is not where the first one is.
#[must_use]
pub fn homes(app: &AppHandle) -> Vec<PathBuf> {
    let mut all = Vec::new();
    if let Ok(dir) = engine_dir(app) {
        all.push(dir);
    }
    if let Ok(home) = lima_home(app) {
        all.push(home);
    }
    all
}

/// Remove the engine: stop the machine, delete it, then delete the client.
///
/// Deliberately whole rather than partial. Half an engine looks installed to
/// `managed_client` and fails at the point somebody switches a desktop on,
/// which is a worse position than having none.
pub fn remove(app: &AppHandle) -> Result<(), String> {
    if let (Some(bin), Ok(home)) = (limactl(app), lima_home(app)) {
        for args in [["stop", "--force", VM_NAME], ["delete", "--force", VM_NAME]] {
            let mut cmd = Command::new(&bin);
            cmd.args(args).env("LIMA_HOME", &home);
            let _ = cmd.output();
        }
    }
    for dir in homes(app) {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .map_err(|e| format!("could not remove {}: {e}", dir.display()))?;
        }
    }
    Ok(())
}

pub fn docker_host(app: &AppHandle) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let socket = lima_home(app)
        .ok()?
        .join(VM_NAME)
        .join("sock")
        .join("docker.sock");
    Some(format!("unix://{}", socket.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Downloads, verifies and unpacks for real into a temporary directory. The
    /// pins, the URLs, the strip depths and the expected binary layout are all
    /// things only a real run can confirm — a mistake in any of them means the
    /// feature fails on a user's first attempt with nothing to point at.
    #[test]
    #[ignore = "downloads ~55MB; run explicitly"]
    fn the_engine_really_installs() {
        let dir = std::env::temp_dir().join("botato-engine-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        for artifact in ARTIFACTS {
            let archive = dir.join("download");
            let seen = std::cell::RefCell::new(Vec::new());
            let say = |step: &str| seen.borrow_mut().push(step.to_string());
            fetch(artifact.url, &archive, &say, "Downloading").expect("download");
            // A download of this size must report more than its first frame.
            assert!(
                seen.borrow().iter().any(|s| s.contains('%')),
                "no percentage was reported for {}: {:?}",
                artifact.url,
                seen.borrow()
            );
            let bytes = std::fs::read(&archive).expect("read");
            let digest = crate::oauth::sha256(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            assert_eq!(digest, artifact.sha256, "pin is wrong for {}", artifact.url);
            let target = if artifact.into.is_empty() {
                dir.clone()
            } else {
                dir.join(artifact.into)
            };
            std::fs::create_dir_all(&target).expect("target dir");
            unpack(&archive, &target, artifact.strip).expect("unpack");
            std::fs::remove_file(&archive).ok();
            println!(
                "ok {} ({} MB)",
                artifact.url.rsplit('/').next().unwrap(),
                bytes.len() / 1048576
            );
        }

        // The layout managed_client() and limactl() expect, checked by running them.
        let expected: Vec<PathBuf> = if cfg!(target_os = "macos") {
            vec![dir.join("bin/docker"), dir.join("bin/limactl")]
        } else {
            vec![dir.join("usr/local/bin/podman")]
        };
        for binary in &expected {
            assert!(
                binary.is_file(),
                "{} is missing after unpack",
                binary.display()
            );
            let out = Command::new(binary).arg("--version").output().expect("run");
            println!(
                "  {} → {}",
                binary.file_name().unwrap().to_string_lossy(),
                String::from_utf8_lossy(&out.stdout).trim()
            );
            assert!(out.status.success(), "{} did not run", binary.display());
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A wrong pin means every install fails on a checksum, so the table is
    /// checked for shape rather than left to a user to discover.
    #[test]
    fn artifacts_are_pinned_and_plausible() {
        assert!(!ARTIFACTS.is_empty(), "this platform needs an engine table");
        for artifact in ARTIFACTS {
            assert_eq!(
                artifact.sha256.len(),
                64,
                "{} has a malformed hash",
                artifact.url
            );
            assert!(
                artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{} has a non-hex hash",
                artifact.url
            );
            assert!(
                artifact.url.starts_with("https://"),
                "{} is not https",
                artifact.url
            );
            // The version constants and the URLs must not drift apart.
            let versioned = artifact.url.contains(LIMA_VERSION)
                || artifact.url.contains(DOCKER_VERSION)
                || artifact.url.contains(PODMAN_VERSION);
            assert!(versioned, "{} names no known version", artifact.url);
        }
    }

    #[test]
    fn progress_reads_as_a_sentence() {
        assert_eq!(
            progress("Downloading 1 of 2", 5_242_880, 37_586_365),
            "Downloading 1 of 2 — 5 of 36 MB (14%)"
        );
        // A server that will not give a length must not produce "NaN%".
        assert_eq!(
            progress("Downloading", 2_097_152, 0),
            "Downloading — 2 MB so far…"
        );
        // Redirects can overshoot the length reported by the first response.
        assert!(progress("x", 40, 10).ends_with("(100%)"));
    }

    #[test]
    fn engine_log_lines_become_readable() {
        assert_eq!(
            readable(
                r#"time="2026-08-17T10:00:00+05:30" level=info msg="Starting the instance \"botato\" with VM driver \"vz\"""#
            ),
            Some(r#"Starting the instance "botato" with VM driver "vz""#.into())
        );
        assert_eq!(
            readable("INFO[0042] [hostagent] Waiting for the essential requirement 1 of 5: \"ssh\"  fields=x"),
            Some("[hostagent] Waiting for the essential requirement 1 of 5: \"ssh\"".into())
        );
        // Debug noise and lima's own terminal warning are not progress.
        assert_eq!(readable(r#"level=debug msg="probing ssh""#), None);
        assert_eq!(
            readable("INFO[0000] Terminal is not available, proceeding"),
            None
        );
        assert_eq!(readable("   "), None);
    }

    /// lima refuses to start when the socket path it would create exceeds
    /// UNIX_PATH_MAX, and the message names the instance rather than the path, so
    /// this is checked here rather than discovered on someone's machine. The old
    /// location under Application Support failed this for every macOS user.
    #[test]
    fn the_vm_socket_path_fits_in_a_unix_path() {
        const UNIX_PATH_MAX: usize = 104;
        // Longer than any macOS account name allows (that limit is 20).
        for user in ["a", "guru", "kumaraguruthambidurai", &"x".repeat(32)] {
            let home = PathBuf::from(format!("/Users/{user}"));
            let socket = longest_socket_path(&lima_home_in(&home));
            let length = socket.as_os_str().len();
            assert!(
                length < UNIX_PATH_MAX,
                "{} is {length} bytes, over lima's limit",
                socket.display()
            );
        }

        // And the location this replaced, to keep the reason from being lost.
        //
        // A literal from history, spelled the way it actually was. It is not a
        // name to keep in step with the app's: the rename to botato rewrote the
        // stand-in that used to be here, took one byte out of it, and dropped it
        // to exactly 104 — so the line recording why the VM had to move stopped
        // being true, and the only thing that noticed was CI. The real path is
        // both correct and seven bytes clear of the limit.
        let old = PathBuf::from(
            "/Users/guru/Library/Application Support/com.hackyguru.botcage/engine/lima-home",
        );
        assert!(
            longest_socket_path(&old).as_os_str().len() > UNIX_PATH_MAX,
            "the path the VM moved off must still be over lima's limit",
        );
    }
}
