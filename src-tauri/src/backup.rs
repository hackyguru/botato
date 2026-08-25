//! An encrypted copy of everything that cannot be downloaded again.
//!
//! botcage keeps about half a gigabyte on disk and almost none of it matters:
//! the speech models, the container engine and the model catalogue are all
//! fetched, and fetched again just as easily. What cannot be fetched again is
//! small — a few megabytes of conversations, memory files, workspaces and
//! routines — and it is the only part of botcage that is genuinely the user's.
//!
//! It is also in a worse place than anyone would guess. The conversations you
//! see in the window live in the webview's `localStorage`, which on macOS is a
//! SQLite file under a hashed path in `~/Library/WebKit`, nowhere near the
//! application's own data folder. The `transcript.jsonl` files that *are* in
//! the data folder exist so an engine without a memory can be given one back;
//! they hold no channels, no threads, no pins, no routines and no faces. So a
//! backup that copied the obvious directory would look thorough and lose the
//! conversations.
//!
//! ## The shape of it
//!
//! One file. Small enough that there is nothing to be clever about: no
//! incremental snapshots, no chunking, no manifest of what changed. Write the
//! whole thing, keep the last few, delete the rest.
//!
//! Encrypted with a passphrase, because the point of a backup is to survive
//! the machine, and anything sealed to *this* machine's keychain would die with
//! it. The passphrase can be kept in the keychain for the unattended runs —
//! convenience there, portability in the file.
//!
//! ## Openable without botcage
//!
//! An encrypted backup you can only read with the program that died is not a
//! backup. So the format is written down here and in the README, the header is
//! plain and fixed, and what comes out of the decryption is an ordinary
//! `.tar.gz` that any machine can open. Sixty lines of Python would recover a
//! conversation from one of these with botcage uninstalled.
//!
//! ```text
//! offset  size  what
//!      0     8  magic, b"BOTCAGE\x01"
//!      8     1  key derivation: 1 = argon2id
//!      9     4  memory cost, KiB, little-endian u32
//!     13     4  time cost, little-endian u32
//!     17     1  parallelism
//!     18    16  salt
//!     34    24  nonce
//!     58     …  XChaCha20-Poly1305 ciphertext of a gzipped tar
//! ```
//!
//! The header is passed as associated data, so the cost parameters cannot be
//! edited down to make an attacker's work cheaper without the tag failing.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;

const MAGIC: &[u8; 8] = b"BOTCAGE\x01";
const ARGON2ID: u8 = 1;
const HEADER: usize = 58;

/// Argon2id at roughly a tenth of a second on this decade's laptop.
///
/// Chosen to be felt but not noticed when a backup is written by a timer, and
/// to make a guess at the passphrase cost real time. A future botcage can raise
/// these — the numbers travel in the header, so an old file still opens.
const MEMORY_KIB: u32 = 64 * 1024;
const PASSES: u32 = 3;
const LANES: u32 = 1;

/// Files in the application's data folder that a backup carries.
///
/// Everything else there is a download: the speech models, whisper, the
/// container engine, the models.dev catalogue. Naming what to *take* rather
/// than what to skip means a new cache directory appearing next year is
/// excluded by default, which is the safer way round for something that runs
/// unattended.
const KEEP: &[&str] = &["bots", "plugins.json"];

/// Files that are never carried, whatever else is.
///
/// `p2p-key` is this machine's identity and `paired-devices.json` holds what a
/// phone was given to prove itself. Both are secrets, and the user asked for a
/// backup that is not a credential store — so they stay behind, and restoring
/// means pairing a phone again. `.botcage-request.json` is one turn's prompt,
/// mid-flight, and belongs to nobody.
const NEVER: &[&str] = &["p2p-key", "paired-devices.json", ".botcage-request.json"];

/// Make one archive.
///
/// `state` is the window's own store, handed in rather than read: the
/// conversations live in the webview and this process cannot see them.
pub fn write(
    data_dir: &Path,
    state: &str,
    passphrase: &str,
    into: &Path,
) -> Result<PathBuf, String> {
    if passphrase.is_empty() {
        return Err("a backup needs a passphrase — without one it is only a copy".into());
    }
    std::fs::create_dir_all(into).map_err(|e| format!("could not use {}: {e}", into.display()))?;

    let tarball = gather(data_dir, state)?;
    let sealed = seal(&tarball, passphrase)?;

    // Named for when it was taken, so a folder of them sorts into an order and
    // the newest is obvious without opening anything.
    let at = stamp();
    let path = into.join(format!("botcage-{at}.backup"));

    // Written beside and moved into place, so a backup interrupted halfway is
    // not left looking like a backup.
    let part = into.join(format!("botcage-{at}.part"));
    std::fs::write(&part, &sealed).map_err(|e| format!("could not write the backup: {e}"))?;
    std::fs::rename(&part, &path).map_err(|e| format!("could not finish the backup: {e}"))?;
    Ok(path)
}

/// Everything in one archive, uncompressed size first.
fn gather(data_dir: &Path, state: &str) -> Result<Vec<u8>, String> {
    let mut tar = tar::Builder::new(Vec::new());

    // The window's store goes in first and by itself, because it is the part
    // that is hard to find and easy to lose.
    let mut head = tar::Header::new_gnu();
    head.set_size(state.len() as u64);
    head.set_mode(0o600);
    head.set_mtime(0);
    head.set_cksum();
    tar.append_data(&mut head, "state.json", state.as_bytes())
        .map_err(|e| format!("could not record the window's state: {e}"))?;

    for name in KEEP {
        let from = data_dir.join(name);
        if !from.exists() {
            continue;
        }
        if from.is_dir() {
            append_dir(&mut tar, &from, Path::new(name))?;
        } else if keepable(name) {
            tar.append_path_with_name(&from, name)
                .map_err(|e| format!("could not record {name}: {e}"))?;
        }
    }

    let plain = tar
        .into_inner()
        .map_err(|e| format!("could not finish the archive: {e}"))?;

    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&plain)
        .map_err(|e| format!("could not compress the archive: {e}"))?;
    gz.finish()
        .map_err(|e| format!("could not compress the archive: {e}"))
}

/// Whether a file is one a backup should hold.
fn keepable(name: &str) -> bool {
    !NEVER.iter().any(|skip| name.ends_with(skip))
}

fn append_dir(tar: &mut tar::Builder<Vec<u8>>, from: &Path, as_: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if !keepable(&name) {
            continue;
        }
        let inner = as_.join(name.as_ref());
        if path.is_dir() {
            append_dir(tar, &path, &inner)?;
        } else if path.is_file() {
            tar.append_path_with_name(&path, &inner)
                .map_err(|e| format!("could not record {}: {e}", inner.display()))?;
        }
        // Anything else — a symlink, a socket — is not a thing a bot's folder
        // should contain and not a thing worth carrying.
    }
    Ok(())
}

/// Header, then ciphertext.
fn seal(plain: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let mut header = Vec::with_capacity(HEADER);
    header.extend_from_slice(MAGIC);
    header.push(ARGON2ID);
    header.extend_from_slice(&MEMORY_KIB.to_le_bytes());
    header.extend_from_slice(&PASSES.to_le_bytes());
    header.push(LANES as u8);
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);
    debug_assert_eq!(header.len(), HEADER);

    let key = derive(passphrase, &salt, MEMORY_KIB, PASSES, LANES)?;
    let sealed = XChaCha20Poly1305::new((&key).into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain,
                // The cost parameters are covered by the tag, so nobody can
                // edit them down to a cheaper guess.
                aad: &header,
            },
        )
        .map_err(|_| "could not encrypt the backup".to_string())?;

    let mut out = header;
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// What was in one, given the passphrase it was made with.
///
/// Returns the window's state and the files, for the caller to put back. The
/// two are separate because they go to different places, and because a restore
/// that wrote the state without the workspaces would leave a roster of bots
/// whose memory had gone.
pub fn read(sealed: &[u8], passphrase: &str) -> Result<Restored, String> {
    if sealed.len() < HEADER || &sealed[..8] != MAGIC {
        return Err("that is not a botcage backup".into());
    }
    let header = &sealed[..HEADER];
    if header[8] != ARGON2ID {
        return Err("this backup was made by a later botcage than this one".into());
    }
    let memory = u32::from_le_bytes(header[9..13].try_into().unwrap());
    let passes = u32::from_le_bytes(header[13..17].try_into().unwrap());
    let lanes = header[17] as u32;
    let salt = &header[18..34];
    let nonce = &header[34..58];

    let key = derive(passphrase, salt, memory, passes, lanes)?;
    let plain = XChaCha20Poly1305::new((&key).into())
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: &sealed[HEADER..],
                aad: header,
            },
        )
        // The one failure a person will actually meet, so it says the likely
        // cause rather than "authentication failed".
        .map_err(|_| "wrong passphrase, or this backup is damaged".to_string())?;

    let mut gz = flate2::read::GzDecoder::new(&plain[..]);
    let mut tarball = Vec::new();
    gz.read_to_end(&mut tarball)
        .map_err(|e| format!("this backup could not be unpacked: {e}"))?;

    let mut state = None;
    let mut files = Vec::new();
    let mut archive = tar::Archive::new(&tarball[..]);
    for entry in archive
        .entries()
        .map_err(|e| format!("this backup could not be read: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("this backup could not be read: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("this backup could not be read: {e}"))?
            .into_owned();
        let mut body = Vec::new();
        entry
            .read_to_end(&mut body)
            .map_err(|e| format!("this backup could not be read: {e}"))?;

        if path == Path::new("state.json") {
            state = Some(String::from_utf8_lossy(&body).into_owned());
        } else {
            files.push((path, body));
        }
    }

    Ok(Restored {
        state: state.ok_or("this backup has no conversations in it")?,
        files,
    })
}

/// What came out of a backup.
#[derive(Debug)]
pub struct Restored {
    /// The window's own store, to be handed back to it.
    pub state: String,
    /// Everything else, by its path within the data folder.
    pub files: Vec<(PathBuf, Vec<u8>)>,
}

impl Restored {
    /// Put the files back, refusing anything that would land outside.
    ///
    /// A backup is a file that has been somewhere else, possibly on somebody
    /// else's machine, and a tar entry named `../../` is the oldest trick
    /// there is. The paths in one of ours are always relative and shallow, so
    /// anything that is not is a reason to stop rather than to sanitise.
    pub fn unpack(&self, data_dir: &Path) -> Result<usize, String> {
        let mut done = 0;
        for (path, body) in &self.files {
            let at = within(data_dir, path)?;
            if let Some(parent) = at.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not make {}: {e}", parent.display()))?;
            }
            std::fs::write(&at, body)
                .map_err(|e| format!("could not restore {}: {e}", path.display()))?;
            done += 1;
        }
        Ok(done)
    }
}

fn within(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for part in rel.components() {
        match part {
            std::path::Component::Normal(name) => out.push(name),
            std::path::Component::CurDir => {}
            _ => {
                return Err(format!(
                    "this backup wants to write outside botcage's folder ({}), which botcage \
                     will not do",
                    rel.display()
                ))
            }
        }
    }
    Ok(out)
}

fn derive(
    passphrase: &str,
    salt: &[u8],
    memory: u32,
    passes: u32,
    lanes: u32,
) -> Result<[u8; 32], String> {
    // A ceiling on what a file is allowed to ask this machine to do. Without
    // it, a hostile backup could name four terabytes of memory and take the
    // app down on the way to failing.
    if memory > 1024 * 1024 || passes > 32 || lanes > 16 || lanes == 0 {
        return Err("this backup asks for more work than botcage will do".into());
    }
    let params = argon2::Params::new(memory, passes, lanes, Some(32))
        .map_err(|e| format!("could not set up the key: {e}"))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("could not derive the key: {e}"))?;
    Ok(key)
}

/// `YYYY-MM-DD-HHMM`, in UTC, from the clock rather than a date library.
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (y, m, d) = civil(days as i64);
    let rest = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}-{:02}{:02}",
        rest / 3600,
        (rest % 3600) / 60
    )
}

/// Days since the epoch to a calendar date. Howard Hinnant's civil_from_days.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Keep the newest `keep` archives in a folder and delete the rest.
///
/// Runs after a successful write, never before: a tidy-up that ran first would
/// be a way of throwing away the only good copy just before failing to make a
/// new one.
pub fn prune(folder: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return 0;
    };
    let mut ours: Vec<PathBuf> = Vec::new();
    for path in entries.flatten().map(|e| e.path()) {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if !name.starts_with("botcage-") {
            continue;
        }
        if name.ends_with(".backup") {
            ours.push(path);
        } else if name.ends_with(".part") {
            // A write that died before its rename. Nothing will ever finish it,
            // and left alone it sits in somebody's iCloud folder for good.
            let _ = std::fs::remove_file(&path);
        }
    }
    // The names carry the time, so sorting them sorts by age.
    ours.sort();
    let mut gone = 0;
    while ours.len() > keep {
        let oldest = ours.remove(0);
        if std::fs::remove_file(&oldest).is_ok() {
            gone += 1;
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap parameters, so the tests are about the format rather than about
    /// how long Argon2 takes. The real ones travel in the header, which is the
    /// property that makes this substitution safe.
    fn quick(plain: &[u8], pass: &str) -> Vec<u8> {
        let mut out = seal(plain, pass).expect("sealed");
        // Rewrite the cost down and re-seal, the way an older file would look.
        out[9..13].copy_from_slice(&MEMORY_KIB.to_le_bytes());
        out
    }

    fn a_folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botcage-backup-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        dir
    }

    /// A machine's worth of botcage, in miniature.
    fn a_machine(name: &str) -> PathBuf {
        let dir = a_folder(name);
        std::fs::create_dir_all(dir.join("bots/b1/tasks")).expect("a bot");
        std::fs::write(dir.join("bots/b1/CLAUDE.md"), "remembers the plant").expect("memory");
        std::fs::write(dir.join("bots/b1/transcript.jsonl"), "{\"text\":\"hello\"}").expect("t");
        std::fs::write(dir.join("bots/b1/tasks/friday.md"), "ship it").expect("a task");
        std::fs::write(dir.join("plugins.json"), "{}").expect("plugins");

        // The parts that must not travel.
        std::fs::write(dir.join("p2p-key"), "this machine's identity").expect("key");
        std::fs::write(dir.join("paired-devices.json"), "phone tokens").expect("devices");
        std::fs::write(dir.join("bots/b1/.botcage-request.json"), "mid-flight").expect("req");

        // And the parts that are only downloads.
        std::fs::create_dir_all(dir.join("speech")).expect("speech");
        std::fs::write(dir.join("speech/model.onnx"), vec![0u8; 4096]).expect("model");
        std::fs::write(dir.join("models.dev.json"), "{}").expect("catalogue");
        dir
    }

    #[test]
    fn what_goes_round_comes_back() {
        let dir = a_machine("round-trip");
        let state = r#"{"bots":[{"name":"Ops","messages":[{"text":"morning"}]}]}"#;

        let sealed = seal(&gather(&dir, state).expect("gathered"), "correct horse").expect("s");
        let back = read(&sealed, "correct horse").expect("read back");

        assert_eq!(back.state, state);
        let names: Vec<String> = back
            .files
            .iter()
            .map(|(p, _)| p.display().to_string())
            .collect();
        assert!(
            names.contains(&"bots/b1/CLAUDE.md".to_string()),
            "{names:?}"
        );
        assert!(
            names.contains(&"bots/b1/tasks/friday.md".to_string()),
            "{names:?}"
        );
        assert!(names.contains(&"plugins.json".to_string()), "{names:?}");

        // And the contents survived, not merely the names.
        let memory = back
            .files
            .iter()
            .find(|(p, _)| p == Path::new("bots/b1/CLAUDE.md"))
            .map(|(_, body)| String::from_utf8_lossy(body).into_owned());
        assert_eq!(memory.as_deref(), Some("remembers the plant"));
    }

    #[test]
    fn the_conversations_are_in_it_because_nothing_else_has_them() {
        // The reason this module exists. The window's store is not in the data
        // folder at all, so a backup built by walking the disk would look
        // complete and contain no conversations.
        let dir = a_machine("conversations");
        let state = r#"{"channels":[{"name":"ops","messages":[{"text":"stand-up"}]}]}"#;
        let back = read(
            &seal(&gather(&dir, state).expect("g"), "pass").expect("s"),
            "pass",
        )
        .expect("r");
        assert!(back.state.contains("stand-up"));
    }

    #[test]
    fn secrets_stay_on_the_machine_they_belong_to() {
        // The user chose a backup that is not a credential store. If this ever
        // stops being true, it stops being true silently and the file becomes
        // the most valuable thing they own.
        let dir = a_machine("secrets");
        let sealed = seal(&gather(&dir, "{}").expect("g"), "pass").expect("s");
        let back = read(&sealed, "pass").expect("r");

        for (path, body) in &back.files {
            let name = path.display().to_string();
            assert!(!name.contains("p2p-key"), "the machine identity travelled");
            assert!(!name.contains("paired-devices"), "phone tokens travelled");
            assert!(!name.contains(".botcage-request"), "a live turn travelled");
            assert!(
                !String::from_utf8_lossy(body).contains("phone tokens"),
                "a secret travelled inside {name}"
            );
        }

        // Nor the things that are only downloads: a backup nobody can sync is
        // a backup nobody keeps.
        let names: Vec<String> = back
            .files
            .iter()
            .map(|(p, _)| p.display().to_string())
            .collect();
        assert!(!names.iter().any(|n| n.contains("speech/")), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("models.dev")), "{names:?}");
    }

    #[test]
    fn the_wrong_passphrase_is_told_so_rather_than_handed_rubbish() {
        let dir = a_machine("wrong-pass");
        let sealed = seal(&gather(&dir, "{}").expect("g"), "the right one").expect("s");
        let why = read(&sealed, "the wrong one").expect_err("must not open");
        assert!(why.contains("passphrase"), "{why}");
    }

    #[test]
    fn a_backup_that_was_meddled_with_does_not_open() {
        let dir = a_machine("tamper");
        let mut sealed = seal(&gather(&dir, "{}").expect("g"), "pass").expect("s");

        // The cost parameters are the interesting thing to attack: turn them
        // down and every guess at the passphrase gets cheaper. They are covered
        // by the tag precisely so that this fails.
        sealed[9..13].copy_from_slice(&(8u32 * 1024).to_le_bytes());
        assert!(
            read(&sealed, "pass").is_err(),
            "the header must be sealed too"
        );

        // And the body, obviously.
        let mut body = seal(&gather(&dir, "{}").expect("g"), "pass").expect("s");
        let last = body.len() - 1;
        body[last] ^= 0xff;
        assert!(read(&body, "pass").is_err());
    }

    #[test]
    fn something_that_is_not_a_backup_is_named_as_such() {
        assert!(read(b"", "pass")
            .unwrap_err()
            .contains("not a botcage backup"));
        assert!(read(b"hello there, this is a text file", "pass")
            .unwrap_err()
            .contains("not a botcage backup"));
    }

    #[test]
    fn a_backup_cannot_write_outside_the_folder_it_is_restored_into() {
        // A backup is a file that has been elsewhere, and a tar entry called
        // ../../ is the oldest trick there is. Ours never contains one, which
        // is exactly why a hand-made one has to be refused rather than trusted.
        let dir = a_folder("escape");
        let hostile = Restored {
            state: "{}".into(),
            files: vec![
                (PathBuf::from("../../evil.txt"), b"no".to_vec()),
                (PathBuf::from("/etc/evil.txt"), b"no".to_vec()),
            ],
        };
        assert!(hostile.unpack(&dir).is_err());
        assert!(!dir.parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn restoring_puts_the_files_back_where_they_were() {
        let from = a_machine("restore-from");
        let onto = a_folder("restore-onto");

        let sealed = seal(&gather(&from, r#"{"bots":[]}"#).expect("g"), "pass").expect("s");
        let back = read(&sealed, "pass").expect("r");
        let count = back.unpack(&onto).expect("unpacked");

        assert!(count >= 4, "only {count} files came back");
        assert_eq!(
            std::fs::read_to_string(onto.join("bots/b1/CLAUDE.md")).expect("memory"),
            "remembers the plant"
        );
        assert_eq!(
            std::fs::read_to_string(onto.join("bots/b1/tasks/friday.md")).expect("task"),
            "ship it"
        );
    }

    #[test]
    fn only_the_newest_few_are_kept() {
        let dir = a_folder("prune");
        for name in [
            "botcage-2026-08-20-0900.backup",
            "botcage-2026-08-21-0900.backup",
            "botcage-2026-08-22-0900.backup",
            "botcage-2026-08-23-0900.backup",
        ] {
            std::fs::write(dir.join(name), b"x").expect("a backup");
        }
        // Something else living in the same folder is not ours to delete.
        std::fs::write(dir.join("notes.txt"), b"mine").expect("a note");
        // A write that died before its rename, which nothing will ever finish.
        std::fs::write(dir.join("botcage-2026-08-19-0900.part"), b"half").expect("a part");

        assert_eq!(prune(&dir, 2), 2);
        assert!(
            !dir.join("botcage-2026-08-19-0900.part").exists(),
            "an abandoned half-written backup was left behind"
        );
        assert!(dir.join("botcage-2026-08-23-0900.backup").exists());
        assert!(dir.join("botcage-2026-08-22-0900.backup").exists());
        assert!(!dir.join("botcage-2026-08-20-0900.backup").exists());
        assert!(
            dir.join("notes.txt").exists(),
            "pruning took someone else's file"
        );
    }

    #[test]
    fn a_backup_without_a_passphrase_is_refused() {
        // It would still be a file, and it would still look like a backup in a
        // folder, which is the problem.
        let dir = a_machine("no-pass");
        let why = write(&dir, "{}", "", &dir.join("out")).expect_err("must refuse");
        assert!(why.contains("passphrase"), "{why}");
    }

    #[test]
    fn the_written_file_is_named_for_when_it_was_taken() {
        let dir = a_machine("naming");
        let into = dir.join("out");
        let path = write(&dir, "{}", "pass", &into).expect("written");
        let name = path.file_name().unwrap().to_string_lossy().into_owned();

        assert!(
            name.starts_with("botcage-") && name.ends_with(".backup"),
            "{name}"
        );
        // No half-written file left behind.
        assert!(!into.join(name.replace(".backup", ".part")).exists());
        // And it opens.
        let raw = std::fs::read(&path).expect("read it");
        assert!(read(&raw, "pass").is_ok());
    }

    #[test]
    fn a_date_is_worked_out_correctly() {
        // The stamp is the only ordering a folder of backups has, so a wrong
        // one puts the newest in the middle and prune throws away the wrong file.
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_000), (2022, 1, 8));
        // A leap day, which is where a hand-rolled calendar goes wrong.
        assert_eq!(civil(19_782), (2024, 2, 29));
    }

    #[test]
    fn an_old_file_still_opens_when_the_cost_goes_up() {
        // The parameters travel in the header so that raising them later does
        // not lock anyone out of the backups they already have.
        let dir = a_machine("params");
        let plain = gather(&dir, "{}").expect("g");
        let sealed = quick(&plain, "pass");
        assert!(read(&sealed, "pass").is_ok());
    }
}
