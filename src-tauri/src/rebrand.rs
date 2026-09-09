//! Carrying an existing install across the rename from botcage to botato.
//!
//! The name is in more than the words. It is in the bundle identifier, which is
//! what macOS and Linux derive the application-support directory from; in
//! `~/.botcage`, which holds the container engine's VM and the connectors; and
//! in the names and labels of every container and image the old build made.
//! Rename the app and all of it moves, so a person who has been using botcage
//! for months opens botato and finds a machine with no bots on it — their
//! conversations, memory, routines and workspaces all still on disk, under a
//! directory nothing looks in any more.
//!
//! This runs once, before anything reads any of it, and moves what is there.
//!
//! ## What moves, and what cannot
//!
//! The two directories move whole, by rename where the filesystem allows it and
//! by copy where it does not. That covers every bot, the rooms, the settings,
//! the speech models, the engine and the connectors.
//!
//! Containers are different. A container's name and its labels are fixed when
//! it is created, and the label is what the app filters on to find a desktop at
//! all — so an old one cannot be adopted, only recreated. They are removed here
//! rather than left: an orphan that no query matches is invisible for ever, and
//! invisible gigabytes are worse than a desktop that rebuilds itself the next
//! time somebody opens it. Nothing durable is in them. A bot's real work lives
//! in its workspace, which is a host directory and moves with the rest; what a
//! container holds is the desktop's own state — a browser profile, a downloads
//! folder — which the desktop makes again.
//!
//! ## Once, and never destructively
//!
//! Nothing is moved onto anything. If the new location already has bots in it
//! then this install has been used under the new name, and the old directory is
//! left exactly where it is rather than merged over the top of it. The worst
//! case is a stranded copy somebody can delete, which is recoverable; the other
//! direction is not.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// The bundle identifier before the rename. The one after it is in
/// `tauri.conf.json`, and the directory is derived from it.
const WAS_IDENTIFIER: &str = "com.hackyguru.botcage";

/// The dot-directory before the rename.
const WAS_HOME: &str = ".botcage";
const NOW_HOME: &str = ".botato";

/// How the old build named and marked what it created in the engine.
const WAS_LABEL: &str = "botcage=1";
const WAS_IMAGE: &str = "botcage/desktop:1";

/// What a used install has in it. Emptiness is not enough to decide with: the
/// updater writes its cache into the application-support directory the moment
/// it checks, so a fresh botato can already have created the folder before this
/// ever runs.
const SIGNS_OF_USE: &[&str] = &["bots", "rooms.json", "settings.json"];

/// Whether a directory holds an install rather than merely existing.
fn is_in_use(dir: &Path) -> bool {
    SIGNS_OF_USE.iter().any(|name| dir.join(name).exists())
}

/// Move a whole directory, falling back to a copy across filesystems.
///
/// `rename` is the one to want: it is atomic and instant however many gigabytes
/// are inside. It also fails with `EXDEV` the moment the two paths are on
/// different volumes, which for a home directory on an external disk is not
/// exotic, so the copy is not optional.
fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_dir(from, to)?;
    // Only after the copy has been made in full. A remove that runs first, or
    // runs on a partial copy, is the one mistake here nobody can undo.
    std::fs::remove_dir_all(from).map_err(|e| e.to_string())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            // Followed rather than recreated would turn a link into a second
            // copy of whatever it points at, which for a model file is a
            // gigabyte and for a loop is for ever.
            #[cfg(unix)]
            if let Ok(dest) = std::fs::read_link(entry.path()) {
                let _ = std::os::unix::fs::symlink(dest, &target);
            }
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The application-support directory the old build used, beside the new one.
fn was_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let now = app.path().app_data_dir().ok()?;
    Some(now.parent()?.join(WAS_IDENTIFIER))
}

/// Everything the old name owned, moved to the new one. Returns what it did,
/// for the log.
pub fn carry_over(app: &AppHandle) -> Vec<String> {
    let mut done = Vec::new();

    if let (Some(was), Ok(now)) = (was_data_dir(app), app.path().app_data_dir()) {
        if was.exists() && is_in_use(&was) && !is_in_use(&now) {
            // The new directory may exist and be empty — the updater's cache
            // is enough to create it — and rename refuses a non-empty target
            // on some platforms, so clear the empty one out of the way first.
            if now.exists() {
                let _ = std::fs::remove_dir_all(&now);
            }
            match move_dir(&was, &now) {
                Ok(()) => done.push(format!("moved {} to {}", was.display(), now.display())),
                Err(err) => done.push(format!("could not move {}: {err}", was.display())),
            }
        }
    }

    let was_home = crate::home().join(WAS_HOME);
    let now_home = crate::home().join(NOW_HOME);
    if was_home.exists() && !now_home.exists() {
        match move_dir(&was_home, &now_home) {
            Ok(()) => done.push(format!(
                "moved {} to {}",
                was_home.display(),
                now_home.display()
            )),
            Err(err) => done.push(format!("could not move {}: {err}", was_home.display())),
        }
    }

    done
}

/// The containers and image the old name left in the engine.
///
/// Best-effort and last: the engine may not be installed, may not be running,
/// and none of that is a reason to hold up a launch. Everything here is
/// recreated on demand, so failing to remove it costs disk and nothing else.
pub fn sweep_engine() -> Vec<String> {
    let mut done = Vec::new();

    if let Ok(out) = crate::sandbox::docker(&[
        "ps",
        "-a",
        "--filter",
        &format!("label={WAS_LABEL}"),
        "--format",
        "{{.Names}}",
    ]) {
        for name in String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
        {
            // -v as well: the desktop's own volume goes with it. Keeping one
            // that nothing will ever mount again is the orphan this is for.
            if crate::sandbox::docker(&["rm", "-f", "-v", name]).is_ok() {
                done.push(format!("removed the old desktop {name}"));
            }
        }
    }

    if let Ok(out) = crate::sandbox::docker(&["image", "rm", "-f", WAS_IMAGE]) {
        if out.status.success() {
            done.push(format!("removed the old image {WAS_IMAGE}"));
        }
    }

    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botato-rebrand-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        dir
    }

    /// An install is its bots, not the existence of a directory. The updater
    /// creates the new folder the first time it checks for a release, so
    /// "already there" would refuse to migrate anybody.
    #[test]
    fn an_empty_directory_is_not_an_install() {
        let dir = folder("empty");
        assert!(!is_in_use(&dir));
        std::fs::write(dir.join("update.json"), "{}").expect("write");
        assert!(!is_in_use(&dir), "a cache is not an install");
        std::fs::create_dir_all(dir.join("bots")).expect("bots");
        assert!(is_in_use(&dir));
    }

    #[test]
    fn a_directory_moves_whole() {
        let root = folder("move");
        let was = root.join("old");
        std::fs::create_dir_all(was.join("bots/b1")).expect("bots");
        std::fs::write(was.join("bots/b1/CLAUDE.md"), "remembers the plant").expect("memory");
        std::fs::write(was.join("rooms.json"), "{}").expect("rooms");

        let now = root.join("new");
        move_dir(&was, &now).expect("move");

        assert!(!was.exists(), "the old one is gone");
        assert_eq!(
            std::fs::read_to_string(now.join("bots/b1/CLAUDE.md")).expect("read"),
            "remembers the plant",
        );
        assert!(now.join("rooms.json").exists());
    }

    /// The copy path, exercised directly: on a machine where the two are on
    /// different volumes this is what runs, and it is the half that can lose
    /// things if it is wrong.
    #[test]
    fn the_copy_fallback_carries_nested_files() {
        let root = folder("copy");
        let was = root.join("old");
        std::fs::create_dir_all(was.join("a/b/c")).expect("dirs");
        std::fs::write(was.join("a/b/c/deep.txt"), "still here").expect("write");
        std::fs::write(was.join("top.txt"), "top").expect("write");

        let now = root.join("new");
        copy_dir(&was, &now).expect("copy");

        assert_eq!(
            std::fs::read_to_string(now.join("a/b/c/deep.txt")).expect("read"),
            "still here",
        );
        assert_eq!(
            std::fs::read_to_string(now.join("top.txt")).expect("read"),
            "top"
        );
        assert!(
            was.exists(),
            "copy leaves the original for the caller to remove"
        );
    }

    /// The rule that keeps this from being destructive. Two installs is a
    /// stranded folder somebody can delete; a merge is a lost one.
    #[test]
    fn an_install_under_the_new_name_is_never_written_over() {
        let root = folder("both");
        let was = root.join("old");
        let now = root.join("new");
        std::fs::create_dir_all(was.join("bots")).expect("old bots");
        std::fs::write(was.join("rooms.json"), "old rooms").expect("write");
        std::fs::create_dir_all(now.join("bots")).expect("new bots");
        std::fs::write(now.join("rooms.json"), "new rooms").expect("write");

        // What carry_over decides, on the two directories it would decide on.
        assert!(is_in_use(&was) && is_in_use(&now));
        let would_move = was.exists() && is_in_use(&was) && !is_in_use(&now);
        assert!(!would_move, "a used destination is left alone");
        assert_eq!(
            std::fs::read_to_string(now.join("rooms.json")).expect("read"),
            "new rooms",
        );
    }
}
