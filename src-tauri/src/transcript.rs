//! What a bot said, for engines that do not remember.
//!
//! Claude Code keeps its own conversation and picks it up again with
//! `--resume`, so botcage has never had to hold one. Most engines cannot: a
//! hosted API or a local model is given a prompt and answers it, and anything
//! it should know has to be in that prompt. This is where botcage keeps it.
//!
//! Deliberately not the bot's memory. `MEMORY.md` is what a bot chose to write
//! down and carries across everything it does; this is the last few exchanges,
//! kept so a reply follows from the one before it. Conflating them would make a
//! bot's long-term memory a function of how recently it spoke, which is exactly
//! the behaviour nobody wants.
//!
//! One line of JSON per entry, in the bot's own workspace beside everything
//! else that belongs to it: readable by a person, appendable without rewriting,
//! and removed with the bot.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Who said it. Engines name these differently; botcage does not care.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Voice {
    User,
    Bot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub voice: Voice,
    pub text: String,
    /// Unix seconds, so a transcript can be read without the app.
    pub at: u64,
}

/// Roughly how much of a conversation to carry into the next turn.
///
/// Counted in characters rather than tokens on purpose: tokenisation differs
/// per model, and a budget that is approximately right for all of them beats
/// one that is exactly right for whichever was implemented first. Four
/// characters to a token is the usual rule of thumb, so this is on the order of
/// twelve thousand tokens — generous for a conversation, and far short of any
/// modern context window.
pub const BUDGET: usize = 48_000;

/// Where a conversation lives.
///
/// A bot has more than one. Its own chat is the unnamed thread; a channel is a
/// separate room it also speaks in, and the two must not run together — a bot
/// answering in #finance should not have yesterday's private chat replayed at
/// it, and the room should not leak into the chat. One file per thread, in the
/// same workspace, so a channel is forgotten by deleting a file.
fn path(workspace: &Path, thread: Option<&str>) -> PathBuf {
    match thread {
        None => workspace.join("transcript.jsonl"),
        // Ids come from the window, not from a person, but they end up as a
        // filename either way — so anything that is not plainly safe becomes a
        // dash rather than an escape from the workspace.
        Some(thread) => {
            let safe: String = thread
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .take(64)
                .collect();
            workspace.join(format!("transcript-{safe}.jsonl"))
        }
    }
}

/// Add what was just said. Appends rather than rewrites, so a long
/// conversation costs the same to record as a short one.
pub fn append(
    workspace: &Path,
    thread: Option<&str>,
    voice: Voice,
    text: &str,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let entry = Entry {
        voice,
        text: text.to_string(),
        at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    };
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path(workspace, thread))
        .map_err(|e| format!("could not open the transcript: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("could not write the transcript: {e}"))
}

/// The most recent exchanges that fit in `budget`, oldest first.
///
/// Trimmed from the front: the beginning of a conversation is the part a model
/// can most afford to lose, and dropping from the end would remove the question
/// being answered.
///
/// Whole entries only. Half a message is worse than no message — it reads as
/// something the speaker actually said and stopped saying.
pub fn recent(workspace: &Path, thread: Option<&str>, budget: usize) -> Vec<Entry> {
    let Ok(file) = std::fs::File::open(path(workspace, thread)) else {
        return Vec::new();
    };

    let all: Vec<Entry> = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str(&line).ok())
        .collect();

    let mut kept: Vec<Entry> = Vec::new();
    let mut used = 0usize;
    for entry in all.into_iter().rev() {
        let cost = entry.text.len();
        if used + cost > budget && !kept.is_empty() {
            break;
        }
        used += cost;
        kept.push(entry);
    }
    kept.reverse();
    kept
}

/// Forget the conversation, keeping the bot. What "clear thread" means for an
/// engine that has no session of its own to end.
pub fn clear(workspace: &Path, thread: Option<&str>) -> Result<(), String> {
    match std::fs::remove_file(path(workspace, thread)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not clear the transcript: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botcage-transcript-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp workspace");
        dir
    }

    #[test]
    fn a_conversation_comes_back_in_order() {
        let dir = workspace("order");
        append(&dir, None, Voice::User, "morning").unwrap();
        append(&dir, None, Voice::Bot, "morning — two PRs need review").unwrap();
        append(&dir, None, Voice::User, "which ones?").unwrap();

        let back = recent(&dir, None, BUDGET);
        assert_eq!(back.len(), 3);
        assert_eq!(back[0].voice, Voice::User);
        assert_eq!(back[0].text, "morning");
        assert_eq!(back[2].text, "which ones?", "oldest first, newest last");
    }

    #[test]
    fn the_beginning_is_dropped_rather_than_the_question() {
        let dir = workspace("budget");
        for i in 0..40 {
            append(
                &dir,
                None,
                Voice::User,
                &format!("old message {i} {}", "x".repeat(200)),
            )
            .unwrap();
        }
        append(&dir, None, Voice::User, "the actual question").unwrap();

        let back = recent(&dir, None, 1_000);
        assert!(
            back.len() < 41,
            "a budget that keeps everything is not a budget"
        );
        assert_eq!(
            back.last().map(|e| e.text.as_str()),
            Some("the actual question"),
            "the newest entry must survive — it is what is being answered"
        );
        let used: usize = back.iter().map(|e| e.text.len()).sum();
        assert!(used <= 1_000 || back.len() == 1, "over budget: {used}");
    }

    #[test]
    fn one_entry_that_exceeds_the_budget_is_still_returned() {
        // Nothing useful can be sent if a single long message means sending
        // nothing at all, and half of it would read as something the person
        // said and stopped saying.
        let dir = workspace("huge");
        append(&dir, None, Voice::User, &"y".repeat(5_000)).unwrap();
        let back = recent(&dir, None, 100);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].text.len(), 5_000, "entries are never cut in half");
    }

    #[test]
    fn a_bot_that_has_never_spoken_has_no_transcript() {
        let dir = workspace("empty");
        assert!(recent(&dir, None, BUDGET).is_empty());
        // And clearing one that was never written is not an error.
        clear(&dir, None).expect("clearing nothing must succeed");
    }

    #[test]
    fn clearing_forgets_the_conversation_but_not_the_bot() {
        let dir = workspace("clear");
        append(&dir, None, Voice::User, "something").unwrap();
        clear(&dir, None).unwrap();
        assert!(recent(&dir, None, BUDGET).is_empty());
        assert!(dir.exists(), "the workspace is the bot; only the talk goes");

        // And it can be spoken to again afterwards.
        append(&dir, None, Voice::User, "hello again").unwrap();
        assert_eq!(recent(&dir, None, BUDGET).len(), 1);
    }

    #[test]
    fn a_damaged_line_does_not_lose_the_conversation() {
        // A crash mid-write leaves a partial line. The rest is still worth
        // reading — a transcript is not a ledger.
        let dir = workspace("damaged");
        append(&dir, None, Voice::User, "before").unwrap();
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.join("transcript.jsonl"))
                .unwrap();
            writeln!(file, "{{\"voice\":\"user\",\"text\":\"cut off").unwrap();
        }
        append(&dir, None, Voice::Bot, "after").unwrap();

        let back = recent(&dir, None, BUDGET);
        assert_eq!(back.len(), 2, "the readable entries survive");
        assert_eq!(back[1].text, "after");
    }

    /// The point of naming a thread: a bot's own chat and a room it speaks in
    /// are two conversations, and replaying one into the other would have it
    /// answering questions nobody in the room asked.
    #[test]
    fn a_channel_and_a_chat_are_different_conversations() {
        let dir = workspace("threads");
        append(&dir, None, Voice::User, "just between us").unwrap();
        append(&dir, Some("ch-finance"), Voice::User, "in the room").unwrap();

        let chat = recent(&dir, None, BUDGET);
        let room = recent(&dir, Some("ch-finance"), BUDGET);
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].text, "just between us");
        assert_eq!(room.len(), 1);
        assert_eq!(room[0].text, "in the room");

        // And clearing one leaves the other standing.
        clear(&dir, Some("ch-finance")).unwrap();
        assert!(recent(&dir, Some("ch-finance"), BUDGET).is_empty());
        assert_eq!(recent(&dir, None, BUDGET).len(), 1);
    }

    /// Ids come from the window today, but they end up as a filename, and a
    /// filename is not the place to find out that something upstream changed.
    #[test]
    fn a_thread_name_cannot_escape_the_workspace() {
        let dir = workspace("escape");
        append(&dir, Some("../../etc/passwd"), Voice::User, "nope").unwrap();
        assert!(
            !dir.join("../../etc/passwd").exists(),
            "a thread id is a name, not a path"
        );
        assert_eq!(recent(&dir, Some("../../etc/passwd"), BUDGET).len(), 1);
    }
}
