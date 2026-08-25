//! A bot's own folder, for an engine that cannot open a file by itself.
//!
//! Claude Code and Gemini arrive with Read, Write, Glob and Grep already in
//! hand. A hosted model arrives with nothing: it can call a function, and every
//! function it can call is one botcage wrote. So a bot on such an engine could
//! use its connectors and change its face and not open the notes it keeps —
//! which is most of what a bot is for.
//!
//! These are the missing four. They are offered through botcage's own MCP
//! server, so they reach a bot down the path connectors already use, and they
//! are named for the folder rather than the machine: this is the same directory
//! that appears as `~/work` on a bot's desktop and as a real folder on the
//! user's computer, so a bot which has all three is looking at one place by
//! three routes, not three places.
//!
//! The boundary is the workspace, and it is enforced twice — once on the path
//! as written, and once on where it actually landed. A bot is given its own
//! folder, not the machine the folder is on: `Read` in Claude Code can reach
//! anywhere the user can, and that is a decision botcage inherited rather than
//! made. Making it again here, deliberately, seemed better than copying it.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

/// The most of a file to hand back at once.
///
/// A model pays for every byte of this and has only so much room. A bot that
/// asks for something enormous is told how big it was and given the beginning,
/// which is more useful than a refusal and far more useful than filling its
/// context with one file.
const MOST: usize = 100_000;

/// How many entries a listing will name before it stops counting them out.
const MANY: usize = 400;

/// What these tools are called, as the rest of botcage addresses them.
pub const NAMES: &str = "mcp__desktop__read_file,mcp__desktop__write_file,\
mcp__desktop__list_files,mcp__desktop__find_in_files";

/// The tools, as a server describes them.
pub fn specs() -> Vec<Value> {
    vec![
        json!({
            "name": "read_file",
            "description": "Read a file in your folder. Paths are relative to it — \
                            \"notes.md\", \"tasks/friday.md\". Very large files come back \
                            beginning-first, with the size said, so ask for what you need.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "relative to your folder" }
                },
                "required": ["path"],
            },
        }),
        json!({
            "name": "write_file",
            "description": "Write a file in your folder, creating the directories it needs. \
                            This replaces what was there, so read it first if you meant to \
                            add to it. Anything the user should be able to open belongs here: \
                            this folder is on their own machine.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "relative to your folder" },
                    "text": { "type": "string", "description": "the whole new contents" }
                },
                "required": ["path", "text"],
            },
        }),
        json!({
            "name": "list_files",
            "description": "List what is in your folder, or in one directory of it. Start \
                            here when you do not know what you have.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "a directory; leave out for the whole folder" }
                },
            },
        }),
        json!({
            "name": "find_in_files",
            "description": "Find which files in your folder contain some text, and on which \
                            lines. Cheaper than reading everything when you are looking for \
                            one thing.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "the text to look for" },
                    "path": { "type": "string", "description": "a directory to look in; leave out for the whole folder" }
                },
                "required": ["query"],
            },
        }),
    ]
}

/// Run one of these, or say it is not ours.
///
/// `None` rather than an error for an unknown name, so the caller can go on
/// looking: this module owns four tools, not the dispatch.
pub fn call(workspace: &Path, name: &str, args: &Value) -> Option<Result<String, String>> {
    match name {
        "read_file" => Some(read(workspace, args["path"].as_str().unwrap_or_default())),
        "write_file" => Some(write(
            workspace,
            args["path"].as_str().unwrap_or_default(),
            args["text"].as_str().unwrap_or_default(),
        )),
        "list_files" => Some(list(workspace, args["path"].as_str().unwrap_or_default())),
        "find_in_files" => Some(find(
            workspace,
            args["query"].as_str().unwrap_or_default(),
            args["path"].as_str().unwrap_or_default(),
        )),
        _ => None,
    }
}

/// Where a path the bot wrote actually points, if it points inside the folder.
///
/// Checked as written — no `..`, nothing absolute, no Windows prefix — and then
/// checked again against where it landed, because a symlink is a way of writing
/// `..` that does not look like one. The second check only applies to something
/// that exists; a file about to be created is judged by its parent.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let asked = Path::new(rel);
    if asked.is_absolute() {
        return Err("paths are relative to your folder, and that one is not".into());
    }

    let mut out = root.to_path_buf();
    for part in asked.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("a path cannot go up out of your folder".into());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("paths are relative to your folder, and that one is not".into());
            }
        }
    }

    // Where it really is, for anything that exists. A link inside the folder
    // pointing outside it is still outside it.
    let ground = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let landed = match out.canonicalize() {
        Ok(real) => real,
        // Not there yet: judge the directory it would be created in.
        Err(_) => match out.parent().map(Path::canonicalize) {
            Some(Ok(parent)) => parent.join(out.file_name().unwrap_or_default()),
            _ => return Ok(out),
        },
    };
    if !landed.starts_with(&ground) {
        return Err("that path leads out of your folder".into());
    }
    Ok(out)
}

fn read(workspace: &Path, path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("say which file to read".into());
    }
    let at = inside(workspace, path)?;
    let raw = std::fs::read(&at).map_err(|e| format!("could not read {path}: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    if raw.len() > MOST {
        // Cut on a character boundary, which from_utf8_lossy guarantees exists.
        let mut end = MOST;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        return Ok(format!(
            "{path} is {} bytes; here are the first {end}:\n\n{}",
            raw.len(),
            &text[..end]
        ));
    }
    Ok(text.into_owned())
}

fn write(workspace: &Path, path: &str, text: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("say which file to write".into());
    }
    let at = inside(workspace, path)?;
    if let Some(parent) = at.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not make the folder for {path}: {e}"))?;
    }
    std::fs::write(&at, text).map_err(|e| format!("could not write {path}: {e}"))?;
    Ok(format!("wrote {path}, {} bytes", text.len()))
}

fn list(workspace: &Path, path: &str) -> Result<String, String> {
    let at = if path.is_empty() {
        workspace.to_path_buf()
    } else {
        inside(workspace, path)?
    };

    let mut found = Vec::new();
    walk(&at, &at, &mut found);
    if found.is_empty() {
        return Ok(if path.is_empty() {
            "your folder is empty".into()
        } else {
            format!("{path} is empty")
        });
    }
    found.sort();

    let total = found.len();
    let shown: Vec<String> = found.into_iter().take(MANY).collect();
    let mut out = shown.join("\n");
    if total > shown.len() {
        out.push_str(&format!(
            "\n\n… and {} more, not listed",
            total - shown.len()
        ));
    }
    Ok(out)
}

/// Everything under `at`, named relative to `from`.
///
/// Depth-first and shallow-biased on purpose: a bot asking what it has wants
/// the shape of the folder, and the cap is what stops one enormous directory
/// from being the whole answer.
fn walk(from: &Path, at: &Path, into: &mut Vec<String>) {
    if into.len() >= MANY * 2 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(at) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        // botcage's own bookkeeping, which is not the bot's business and would
        // only invite it to read its own transcript back to itself.
        if name.starts_with('.') || name == "transcript.jsonl" || name.starts_with("transcript-") {
            continue;
        }
        let shown = path
            .strip_prefix(from)
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned();
        if path.is_dir() {
            into.push(format!("{shown}/"));
            walk(from, &path, into);
        } else {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            into.push(format!("{shown} ({size} bytes)"));
        }
    }
}

fn find(workspace: &Path, query: &str, path: &str) -> Result<String, String> {
    if query.is_empty() {
        return Err("say what to look for".into());
    }
    let at = if path.is_empty() {
        workspace.to_path_buf()
    } else {
        inside(workspace, path)?
    };

    let mut names = Vec::new();
    walk(&at, &at, &mut names);

    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    for entry in names {
        if entry.ends_with('/') {
            continue;
        }
        // walk() renders a file as "name (123 bytes)"; the name is what is
        // wanted here.
        let name = entry.rsplit_once(" (").map(|(n, _)| n).unwrap_or(&entry);
        let file = at.join(name);
        let Ok(raw) = std::fs::read(&file) else {
            continue;
        };
        let text = String::from_utf8_lossy(&raw);
        for (n, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                let line = line.trim();
                let shown: String = line.chars().take(200).collect();
                hits.push(format!("{name}:{}: {shown}", n + 1));
                if hits.len() >= MANY {
                    hits.push("… and more, not listed".into());
                    return Ok(hits.join("\n"));
                }
            }
        }
    }

    if hits.is_empty() {
        return Ok(format!("nothing in your folder contains {query:?}"));
    }
    Ok(hits.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botcage-files-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        dir
    }

    #[test]
    fn a_file_goes_in_and_comes_back() {
        let dir = folder("round-trip");
        assert!(write(&dir, "notes/friday.md", "shipped the loop").is_ok());
        assert_eq!(
            read(&dir, "notes/friday.md"),
            Ok("shipped the loop".to_string())
        );
        // The directory was made on the way, because a bot asked to write a
        // note should not have to be told to make a folder first.
        assert!(dir.join("notes").is_dir());
    }

    #[test]
    fn a_bot_is_given_its_folder_and_not_the_machine() {
        // The whole point of the module. Every one of these is a way of asking
        // for something that is not the bot's.
        let dir = folder("boundary");
        for escape in [
            "../../../etc/passwd",
            "..",
            "notes/../../elsewhere",
            "/etc/passwd",
        ] {
            assert!(
                read(&dir, escape).is_err(),
                "{escape} should not be readable"
            );
            assert!(
                write(&dir, escape, "no").is_err(),
                "{escape} should not be writable"
            );
        }

        // And nothing was created on the way out.
        assert!(!dir.join("elsewhere").exists());
    }

    #[test]
    fn a_link_out_is_a_way_up_that_does_not_look_like_one() {
        // "../" is the obvious escape and the easy one to stop. A symlink is
        // the same move written differently, and a check on the path as typed
        // will happily wave it through.
        let dir = folder("links");
        let outside = std::env::temp_dir().join("botcage-files-links-secret.txt");
        std::fs::write(&outside, "not yours").expect("a file outside");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, dir.join("secret.txt")).expect("a link");
            assert!(
                read(&dir, "secret.txt").is_err(),
                "a link pointing out of the folder still points out of it"
            );
        }
    }

    #[test]
    fn a_listing_says_what_is_there_and_leaves_out_the_bookkeeping() {
        let dir = folder("listing");
        write(&dir, "a.md", "one").expect("a");
        write(&dir, "sub/b.md", "two").expect("b");
        std::fs::write(dir.join("transcript.jsonl"), "{}").expect("transcript");
        std::fs::write(dir.join(".botcage-request.json"), "{}").expect("request");

        let said = list(&dir, "").expect("a listing");
        assert!(said.contains("a.md"), "{said}");
        assert!(said.contains("sub/"), "{said}");
        assert!(said.contains("sub/b.md"), "{said}");
        // Its own transcript read back to itself is noise at best, and the
        // request file is botcage talking to itself.
        assert!(!said.contains("transcript"), "{said}");
        assert!(!said.contains("botcage-request"), "{said}");
    }

    #[test]
    fn finding_says_the_file_and_the_line() {
        let dir = folder("finding");
        write(&dir, "notes.md", "nothing here\nthe deadline is Friday\n").expect("notes");
        write(&dir, "other.md", "unrelated").expect("other");

        let said = find(&dir, "DEADLINE", "").expect("a search");
        assert!(said.contains("notes.md:2"), "{said}");
        assert!(said.contains("Friday"), "{said}");
        assert!(!said.contains("other.md"), "{said}");

        assert!(find(&dir, "kumquat", "")
            .expect("a search")
            .contains("nothing"));
    }

    #[test]
    fn something_enormous_is_cut_rather_than_refused() {
        // A bot that asks for a huge file has made a reasonable request badly.
        // Giving it the beginning and the size is more use than a refusal, and
        // much more use than spending its whole context on one file.
        let dir = folder("enormous");
        write(&dir, "big.txt", &"x".repeat(MOST * 2)).expect("a big file");

        let said = read(&dir, "big.txt").expect("a read");
        assert!(said.len() < MOST * 2);
        assert!(said.contains(&format!("{} bytes", MOST * 2)), "{said}");
    }

    #[test]
    fn only_the_four_are_answered() {
        let dir = folder("dispatch");
        assert!(call(&dir, "read_file", &json!({ "path": "nope" })).is_some());
        // Not this module's, and saying so rather than failing is what lets the
        // server go on looking.
        assert!(call(&dir, "screenshot", &json!({})).is_none());
    }
}
