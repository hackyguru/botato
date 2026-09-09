//! What is going on in the rooms, in a form a bot can read.
//!
//! Rooms live in the window. A bot's own transcript is only what it took part
//! in — `transcript::append` runs when *that* bot is asked something — so a
//! channel a bot sits in quietly leaves no trace anywhere it can reach. Which
//! means a bot has never been able to answer "what have I missed", including
//! about rooms it is a member of.
//!
//! This is the mirror that makes it answerable: the window writes a small
//! digest of each room here whenever one changes, and a bot reads it. Two
//! properties matter more than anything else about the shape.
//!
//! **Writing it costs nothing.** No model is involved in keeping this current.
//! It is a few hundred kilobytes rewritten when a message arrives, which is
//! the difference between a bot that can catch up and a bot that spends a turn
//! every hour finding out there was nothing to catch up on.
//!
//! **So "has anything happened" is free to ask.** Every entry is stamped, and
//! every bot keeps a marker of where it last looked. Comparing the two is a
//! file read and an integer compare — no tokens at all. Anything scheduled on
//! top of this can therefore be quiet on a quiet hour, which is the only way a
//! recurring feature is worth leaving switched on.
//!
//! Bounded on purpose. A mirror that grows without limit becomes a thing that
//! has to be pruned, and pruning is where this would start losing messages
//! quietly. Instead it holds a fixed recent window and forgets the rest, which
//! is the honest promise: this answers "what happened lately", not "what was
//! ever said".

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Messages kept per room. Enough to summarise a busy morning, small enough
/// that twenty rooms are still a file you could open in an editor.
const KEPT: usize = 40;

/// And how much of one. A bot catching up needs the gist and who said it; a
/// bot that needs the whole of a long message can go and read the room.
const SNIPPET: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Said {
    /// Unix seconds. The whole gate depends on this being real.
    pub at: u64,
    /// Display name, because that is what one bot calls another.
    pub who: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Room {
    pub id: String,
    pub name: String,
    /// Bot ids that are in it. The scope rule, and not negotiable: a bot is
    /// told about rooms it is a member of and no others. "What have I missed"
    /// must never be a way to read a room you were not invited to.
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub said: Vec<Said>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Mirror {
    #[serde(default)]
    pub rooms: Vec<Room>,
}

/// Where the mirror lives, for the process that owns the app.
///
/// The MCP server is not that process — it is `botato --mcp`, started with
/// its identity in the environment — so everything on the reading side takes
/// the path explicitly and the server is told it in `BOTATO_ROOMS`, the way
/// it is told its workspace.
pub fn mirror_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("rooms.json"))
}

/// The window handing over what it has.
///
/// Whole-file rather than incremental. Rooms are renamed, messages are deleted
/// and members come and go, so a mirror built from a stream of additions drifts
/// from the thing it mirrors and there is no moment anybody would notice. The
/// window knows the truth; it writes the truth.
pub fn put(app: &AppHandle, mut mirror: Mirror) -> Result<(), String> {
    for room in &mut mirror.rooms {
        if room.said.len() > KEPT {
            room.said = room.said.split_off(room.said.len() - KEPT);
        }
        for said in &mut room.said {
            if said.text.chars().count() > SNIPPET {
                said.text = said.text.chars().take(SNIPPET).collect::<String>() + "…";
            }
        }
    }
    let path = mirror_path(app)?;
    let body = serde_json::to_string(&mirror).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

/// The same, for anyone holding the path rather than the app.
pub fn read(path: &Path) -> Mirror {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

/* ------------------------------------------------------- where a bot got to */

/// How far through each room a bot has read, by room id.
///
/// In the bot's own workspace, beside its transcript and its memory: it is
/// this bot's business, it should be readable by a person poking around, and
/// it should go when the bot goes.
fn marker_path(workspace: &Path) -> PathBuf {
    workspace.join("caught-up.json")
}

fn markers(workspace: &Path) -> std::collections::HashMap<String, u64> {
    std::fs::read_to_string(marker_path(workspace))
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

/// What one room has for one bot, since it last looked.
pub struct News {
    pub room: String,
    pub said: Vec<Said>,
}

/// Everything a bot has not seen, in the rooms it belongs to.
///
/// Reading does not mark anything read — `mark_in` is separate. A bot that
/// asks what it missed and then fails mid-turn should be asked the same
/// question again next time, not told there is nothing.
///
/// Note what this costs: a file read and some integer comparisons. No engine
/// is started, no prompt is built, nothing is billed. Anything scheduled on
/// top of this can ask "is there anything?" on every tick and stay silent
/// through a quiet night for free, which is the only way a recurring feature
/// is worth leaving switched on.
pub fn unseen_in(mirror: &Mirror, bot_id: &str, workspace: &Path) -> Vec<News> {
    let seen = markers(workspace);
    mirror
        .rooms
        .clone()
        .into_iter()
        .filter(|room| room.members.iter().any(|member| member == bot_id))
        .filter_map(|room| {
            let since = seen.get(&room.id).copied().unwrap_or(0);
            let said: Vec<Said> = room.said.into_iter().filter(|s| s.at > since).collect();
            if said.is_empty() {
                None
            } else {
                Some(News {
                    room: room.name,
                    said,
                })
            }
        })
        .collect()
}

/// Remember that it has now seen everything up to this moment.
pub fn mark_in(mirror: &Mirror, bot_id: &str, workspace: &Path) {
    let mut seen = markers(workspace);
    for room in mirror.rooms.clone() {
        if !room.members.iter().any(|member| member == bot_id) {
            continue;
        }
        // The latest thing actually in the room, rather than the clock. Marking
        // "now" would skip anything said in the seconds between the mirror
        // being written and this running, and a message nobody can explain
        // losing is worse than one arriving twice.
        //
        // Still a high-water mark, with what that implies: a message that
        // reaches the mirror stamped *earlier* than one already read — a phone
        // syncing late, a clock adrift — is not seen. Fixing that means keeping
        // the ids of everything read rather than one number per room, which is
        // unbounded state to buy back a case that costs one missed message.
        if let Some(newest) = room.said.iter().map(|s| s.at).max() {
            let at = seen.entry(room.id).or_insert(0);
            *at = (*at).max(newest);
        }
    }
    if let Ok(body) = serde_json::to_string(&seen) {
        let _ = std::fs::write(marker_path(workspace), body);
    }
}

/* ----------------------------------------------------------- the commands */

#[tauri::command(async)]
pub fn rooms_mirror(app: AppHandle, mirror: Mirror) -> Result<(), String> {
    put(&app, mirror)
}

/// Is there anything this bot has not seen?
///
/// The question a heartbeat asks before it spends anything. A file read and
/// some integer comparisons — no engine started, no prompt built, nothing
/// billed — so a bot can be asked this every few minutes forever and a quiet
/// night costs nothing at all.
///
/// It deliberately does not say *what* is new. Answering that is the turn, and
/// the turn is the expensive part; this is only the part that decides whether
/// to have one.
#[tauri::command(async)]
pub fn rooms_unseen(app: AppHandle, bot_id: String) -> bool {
    let Ok(workspace) = crate::workspace(&app, &bot_id) else {
        return false;
    };
    !unseen_in(
        &read(&mirror_path(&app).unwrap_or_default()),
        &bot_id,
        &workspace,
    )
    .is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(at: u64, who: &str, text: &str) -> Said {
        Said {
            at,
            who: who.into(),
            text: text.into(),
        }
    }

    fn two_rooms() -> Mirror {
        Mirror {
            rooms: vec![
                Room {
                    id: "r1".into(),
                    name: "eng".into(),
                    members: vec!["b1".into()],
                    said: vec![said(100, "guru", "ship it"), said(200, "Ops", "on it")],
                },
                Room {
                    id: "r2".into(),
                    name: "private".into(),
                    members: vec!["b2".into()],
                    said: vec![said(150, "guru", "between us")],
                },
            ],
        }
    }

    fn workspace(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("botato-rooms-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace");
        dir
    }

    /// The rule the whole feature stands on. A bot is told about rooms it is in
    /// and no others — "what have I missed" must never become a way to read a
    /// room nobody invited you to.
    #[test]
    fn a_bot_never_hears_about_a_room_it_is_not_in() {
        let dir = workspace("scope");
        let news = unseen_in(&two_rooms(), "b1", &dir);
        assert_eq!(news.len(), 1);
        assert_eq!(news[0].room, "eng");

        // And the other way round, so this cannot pass by accident on a filter
        // that simply drops everything.
        let theirs = unseen_in(&two_rooms(), "b2", &dir);
        assert_eq!(theirs.len(), 1);
        assert_eq!(theirs[0].room, "private");
    }

    /// Asked twice, told once. In a room full of bots, hearing the same message
    /// again is how one message becomes an argument.
    #[test]
    fn marking_means_the_next_look_is_quiet() {
        let dir = workspace("mark");
        let mirror = two_rooms();
        assert_eq!(unseen_in(&mirror, "b1", &dir).len(), 1);

        mark_in(&mirror, "b1", &dir);
        assert!(
            unseen_in(&mirror, "b1", &dir).is_empty(),
            "nothing has happened since it looked"
        );
    }

    /// And something genuinely new gets through afterwards — the half that
    /// makes the mark a bookmark rather than a mute.
    #[test]
    fn what_arrives_after_the_mark_still_arrives() {
        let dir = workspace("after");
        let mut mirror = two_rooms();
        mark_in(&mirror, "b1", &dir);

        mirror.rooms[0]
            .said
            .push(said(300, "guru", "one more thing"));
        let news = unseen_in(&mirror, "b1", &dir);
        assert_eq!(news.len(), 1);
        assert_eq!(news[0].said.len(), 1, "only the new one");
        assert_eq!(news[0].said[0].text, "one more thing");
    }

    /// The limit of a high-water mark, written down rather than discovered.
    ///
    /// A message that reaches the mirror stamped earlier than one already read
    /// is not seen. This is a real gap — a phone syncing late would do it —
    /// and it is here so that anybody who decides the gap matters finds a test
    /// telling them what the current behaviour is before they change it.
    #[test]
    fn a_message_stamped_before_the_mark_is_missed() {
        let dir = workspace("late");
        let mut mirror = two_rooms();
        mark_in(&mirror, "b1", &dir);

        // Said at 150, but only reaching the mirror now — after 200 was read.
        mirror.rooms[0]
            .said
            .push(said(150, "Ops", "sorry, delayed"));
        assert!(
            unseen_in(&mirror, "b1", &dir).is_empty(),
            "a high-water mark cannot see behind itself"
        );
    }
}
