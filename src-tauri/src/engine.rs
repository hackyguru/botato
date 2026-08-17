//! A container engine botcage installs and owns, so a bot's computer needs
//! nothing preinstalled — no Docker Desktop, no terminal, no admin password.
//!
//! Everything lands in botcage's own data directory and nothing touches the
//! system, which is what makes it removable by deleting a folder.
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
use std::path::{Path, PathBuf};
use std::process::Command;
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
    /// botcage has an engine of its own, downloaded and verified.
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

/// The client botcage should drive, if it installed one. Checked by existence
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

/// Lima keeps its state beside the binaries rather than in ~/.lima, so removing
/// botcage's data directory removes the VM with it.
fn lima_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(engine_dir(app)?.join("lima-home"))
}

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
        .args(["list", "--format", "{{.Status}}", "botcage"])
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
        return Err("botcage has no engine for this platform yet".into());
    }
    let dir = engine_dir(&app)?;
    let say = |step: &str| {
        let _ = app.emit("engine", step);
    };

    for (index, artifact) in ARTIFACTS.iter().enumerate() {
        say(&format!(
            "Downloading ({} of {})…",
            index + 1,
            ARTIFACTS.len()
        ));
        let archive = dir.join(format!("download-{index}"));
        fetch(artifact.url, &archive)?;

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

fn fetch(url: &str, to: &Path) -> Result<(), String> {
    let out = Command::new("curl")
        .args(["-fL", "--retry", "2", "-m", "900", "-o"])
        .arg(to)
        .arg(url)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "download failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    ))
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

    // vz is Apple's own hypervisor, so no QEMU is needed. virtiofs is what makes
    // a bot's workspace visible inside the VM at the same path.
    let out = Command::new(&bin)
        .args(["start", "--name", "botcage", "--tty=false"])
        .args([
            "--vm-type",
            "vz",
            "--mount-type",
            "virtiofs",
            "--mount-writable",
        ])
        .arg("template://docker")
        .env("LIMA_HOME", &home)
        .output()
        .map_err(|e| format!("could not start the machine: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "the machine did not start: {}",
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("unknown error")
        ));
    }
    // The socket only exists once the machine is up, so re-point the client now.
    crate::sandbox::use_managed_engine(managed_client(&app), docker_host(&app));
    let _ = app.emit("engine", "Ready");
    Ok(())
}

/// Where the docker client should look, once the VM is up. Empty on Linux,
/// where podman needs no socket.
pub fn docker_host(app: &AppHandle) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let socket = lima_home(app)
        .ok()?
        .join("botcage")
        .join("sock")
        .join("docker.sock");
    socket
        .exists()
        .then(|| format!("unix://{}", socket.display()))
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
        let dir = std::env::temp_dir().join("botcage-engine-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        for artifact in ARTIFACTS {
            let archive = dir.join("download");
            fetch(artifact.url, &archive).expect("download");
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
}
