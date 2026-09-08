//! What botcage has put on this disk, and how to get it back.
//!
//! Everything here is downloaded or built rather than written by a person: a
//! speech model, a container engine, a desktop image, a container per bot.
//! Which is what makes a panel like this worth having — none of it is
//! irreplaceable, all of it is large, and until now the only way to find out
//! how much of it there was involved knowing where an app puts things.
//!
//! Sizes come from two different places on purpose. What sits in a folder is
//! measured by walking the folder; what lives inside the engine is asked of
//! the engine, because on macOS the whole of it is one opaque VM disk image as
//! far as this machine's filesystem is concerned.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// One thing taking up room.
///
/// It carries no words: the window knows the bots' names and does the wording,
/// which keeps every string a person reads in one language and one file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    /// Pass this back to `storage_free` to remove it.
    pub id: String,
    /// What sort of thing it is: `voice`, `engine`, `image`, `desk`, `files`.
    pub kind: String,
    /// Whose it is, where it belongs to one bot.
    pub bot: Option<String>,
    /// Stands in for a name when there is no bot to take one from — a desktop
    /// left behind by a bot that has since been deleted.
    pub label: Option<String>,
    pub bytes: u64,
    /// False for things botcage will not throw away on a button: a bot's own
    /// files go when the bot does, and not before.
    pub removable: bool,
    /// Inside the engine's disk rather than on this one. Counted separately so
    /// the panel does not add a number to a total it is already part of.
    pub inside: bool,
}

/// What one file is actually costing.
///
/// The blocks it occupies, not the size it claims. A virtual machine's disk is
/// a sparse file that says a hundred gigabytes and holds four — reporting the
/// number it claims would make the engine row a work of fiction, and it is the
/// largest row here.
#[cfg(unix)]
fn file_bytes(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks() * 512
}

#[cfg(not(unix))]
fn file_bytes(meta: &std::fs::Metadata) -> u64 {
    meta.len()
}

/// What a folder holds, following nothing.
///
/// Symlinks are skipped rather than followed: the engine unpacks a tree full
/// of them, and following them counts the same bytes several times over and
/// can walk clean out of the directory being measured.
fn dir_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return file_bytes(&meta);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| dir_bytes(&entry.path()))
        .sum()
}

fn item(id: &str, kind: &str, bytes: u64, removable: bool) -> StorageItem {
    StorageItem {
        id: id.to_string(),
        kind: kind.to_string(),
        bot: None,
        label: None,
        bytes,
        removable,
        inside: false,
    }
}

/// Everything botcage is holding, largest first.
///
/// The bot ids come from the window because that is where the roster lives.
/// They are used for two things: naming each bot's own files, and working out
/// which desktops still belong to somebody.
#[tauri::command(async)]
pub fn storage_usage(app: AppHandle, bots: Vec<String>) -> Vec<StorageItem> {
    let mut all = Vec::new();

    let ears = crate::hearing::model_path(&app)
        .map(|path| dir_bytes(&path))
        .unwrap_or(0);
    let voices = crate::speech::home(&app)
        .map(|dir| dir_bytes(&dir))
        .unwrap_or(0);
    if ears + voices > 0 {
        all.push(item("voice", "voice", ears + voices, true));
    }

    let engine: u64 = crate::engine::homes(&app)
        .iter()
        .map(|dir| dir_bytes(dir))
        .sum();
    if engine > 0 {
        all.push(item("engine", "engine", engine, true));
    }

    let image = crate::sandbox::image_bytes();
    if image > 0 {
        let mut row = item("image", "image", image, true);
        row.label = Some(crate::sandbox::image_name().to_string());
        row.inside = true;
        all.push(row);
    }

    for (container, bytes) in crate::sandbox::desks() {
        let bot = crate::sandbox::bot_of(&container, &bots);
        all.push(StorageItem {
            id: format!("desk:{container}"),
            kind: "desk".into(),
            label: bot.is_none().then(|| container.clone()),
            bot,
            bytes,
            removable: true,
            inside: true,
        });
    }

    if let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("bots")) {
        for id in &bots {
            let bytes = dir_bytes(&dir.join(id));
            if bytes == 0 {
                continue;
            }
            all.push(StorageItem {
                id: format!("files:{id}"),
                kind: "files".into(),
                bot: Some(id.clone()),
                label: None,
                bytes,
                // A bot's workspace is its memory and its transcript. That goes
                // when the bot does, from the place where deleting a bot is
                // what you are doing — not from a list of sizes.
                removable: false,
                inside: false,
            });
        }
    }

    all.sort_by_key(|row| std::cmp::Reverse(row.bytes));
    all
}

/// Throw one of them away. Returns what it was holding, so the window can say.
#[tauri::command(async)]
pub fn storage_free(app: AppHandle, id: String) -> Result<u64, String> {
    let was = storage_usage(app.clone(), Vec::new())
        .into_iter()
        .find(|row| row.id == id)
        .map(|row| row.bytes)
        .unwrap_or(0);

    match id.as_str() {
        "voice" => {
            for path in [
                crate::hearing::model_path(&app).ok(),
                crate::speech::home(&app).ok(),
            ]
            .into_iter()
            .flatten()
            {
                if path.is_dir() {
                    std::fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
                } else if path.exists() {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
            }
            // The model is held in memory between utterances, and the file it
            // was read from has just gone.
            crate::hearing::unload();
            Ok(was)
        }
        "engine" => {
            crate::engine::remove(&app)?;
            Ok(was)
        }
        "image" => {
            crate::sandbox::remove_image()?;
            Ok(was)
        }
        _ => match id.strip_prefix("desk:") {
            Some(container) => {
                crate::sandbox::remove_desk(container);
                Ok(was)
            }
            None => Err(format!("nothing here is called {id}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_is_the_sum_of_what_is_in_it() {
        let dir = std::env::temp_dir().join(format!("botcage-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("deep")).unwrap();
        std::fs::write(dir.join("one"), vec![0u8; 100_000]).unwrap();
        std::fs::write(dir.join("deep").join("two"), vec![0u8; 23_000]).unwrap();

        // Not an exact byte count: what a file costs is the blocks it sits in,
        // which is the number this is here to report and a number only the
        // filesystem knows. What it must do is add up and stop at the edge.
        let one = dir_bytes(&dir.join("one"));
        let two = dir_bytes(&dir.join("deep").join("two"));
        assert!(one >= 100_000, "a file is at least its own contents");
        assert_eq!(dir_bytes(&dir), one + two);
        assert_eq!(dir_bytes(&dir.join("nothing here")), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The engine's tree is full of links to its own files. Counting what they
    /// point at would report an engine several times its real size.
    #[cfg(unix)]
    #[test]
    fn a_link_counts_as_nothing() {
        let dir = std::env::temp_dir().join(format!("botcage-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real"), vec![0u8; 64_000]).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("copy")).unwrap();

        assert_eq!(dir_bytes(&dir), dir_bytes(&dir.join("real")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
