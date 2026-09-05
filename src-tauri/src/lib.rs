//! Bridge between the botcage UI and whatever answers for a bot.
//!
//! Each turn spawns the engine that bot chose — see [`inference`] — in its own
//! workspace directory, and relays the stream to the webview as `bot-event`
//! events. Which flags, which stream format and which model belong to the
//! engine; what botcage does about any of it belongs here.
//!
//! Auth comes from the user's own CLI login, so no API key ever passes through
//! this process.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

mod backup;
mod catalogue;
mod connectors;
mod engine;
mod files;
mod hearing;
mod inference;
mod mcp;
mod mcp_client;
mod oauth;
mod p2p;
mod plugins;
mod push;
mod remote;
mod sandbox;
mod setup;
mod speech;
mod transcript;
mod voice;

/// Entry point for `botcage --mcp` (see main.rs). Identity arrives in the
/// environment, set by the app when it registers this server.
pub fn serve_mcp() {
    let brand = std::env::var("BOTCAGE_BRAND")
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    mcp::serve(mcp::Bot {
        // Who else this bot could put work on the calendar of. Names rather
        // than ids: a bot says "Ops", and the window turns that into whichever
        // bot is called that when the turn ends.
        colleagues: std::env::var("BOTCAGE_COLLEAGUES")
            .unwrap_or_default()
            .split('\n')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect(),
        // Present *and* not empty: a variable set to "" is still set, and a
        // bot silently given the wrong tools is not a thing that announces
        // itself.
        files: std::env::var("BOTCAGE_FILES").is_ok_and(|on| !on.is_empty()),
        id: std::env::var("BOTCAGE_BOT").unwrap_or_default(),
        workspace: std::env::var("BOTCAGE_WORKSPACE")
            .unwrap_or_default()
            .into(),
        brand,
    });
}

/// Tools the desktop MCP server provides, named as Claude Code addresses them.
const DESKTOP_TOOLS: &str = "mcp__desktop__screenshot,mcp__desktop__exec,mcp__desktop__click,\
mcp__desktop__move,mcp__desktop__type,mcp__desktop__key,mcp__desktop__scroll,mcp__desktop__replay,\
mcp__desktop__start_desktop";

/// The one tool every bot has, computer or not: its own appearance.
const FACE_TOOL: &str = "mcp__desktop__set_appearance";

/// Putting work on a calendar — its own, or a colleague's.
const SCHEDULE_TOOL: &str = "mcp__desktop__schedule";

/// Asking the user something with the answers ready to press.
const ASK_TOOL: &str = "mcp__desktop__ask";

/// Declaring the shortcuts this bot answers to.
const COMMANDS_TOOL: &str = "mcp__desktop__set_commands";

/// As with the face: a tool nobody mentions is a tool that goes unused, and
/// this one is worth using early — the list is how somebody finds out what a
/// bot is for without asking it.
const COMMANDS_PROMPT: &str = "\
## The shortcuts you answer to

`set_commands` declares up to eight named jobs — `/log`, `/standup`, `/review` \
— which the user sees by typing \"/\" in any conversation you are in. Picking \
one writes it into their message; you receive an ordinary message beginning \
with it.

Set them once you know what your work actually is, and revise them when it \
changes. Name the things you are asked for repeatedly, in the user's words \
rather than your own, and keep the list short: it is a menu of what you do, and \
past a handful nobody reads it. If the user has only ever asked you for one \
thing, one command is the honest list.";

/// The same lesson as the face and the calendar: a bot holding a tool nobody
/// mentioned will explain that it cannot do the thing it is holding the tool
/// for. This one is worth saying at some length, because the judgement — when
/// a question has buttons and when it does not — matters more than the call.
const ASK_PROMPT: &str = "\
## Asking with buttons

`ask` puts your answers under your reply as buttons. Whichever the user presses \
arrives as their next message, and you carry on.

Use it whenever you end on a question with a small number of sensible answers. \
Most questions are like that, and the difference it makes is not cosmetic: a \
question needing a typed sentence gets answered when somebody is next at a \
keyboard, and a question needing a thumb gets answered now — from a phone, in a \
queue, without opening anything. If you fired from a routine and nobody is \
there, this is the difference between an answer tonight and an answer tomorrow.

Ask in your reply too, in your own words. The buttons are a shortcut for the \
answer, never a replacement for the question: a bare row of words under a \
silent reply reads as a form, not as you.

Not every question. \"What did you eat?\" has no answers you could name, so just \
ask it. \"Log it now, or tonight?\" does. If you cannot name them, do not \
invent them — a wrong button is worse than no button, because it makes the \
easy path the wrong one.";

/// Same reason as the face prompt: a bot holding a tool nobody told it about
/// will explain that it cannot do the thing it is holding the tool for.
const SCHEDULE_PROMPT: &str = "\
## Putting work on a calendar

`schedule` adds a routine — a standing instruction that runs at a time. Use it \
on yourself when the user asks for something regular, and on a colleague when \
the work is theirs: they are named in the tool's description, and a name that \
is not on that list belongs to nobody. Scheduling for someone else is done \
openly — say who you are giving work to and what it is, before or as you do it, \
never quietly. The user sees your name on it and can delete it in one click.";

/// A bot that can change its face should know it can, or it will apologise for
/// being unable to do something it is holding the tool for. Which is exactly
/// what happened when the tool existed and nothing said so.
const FACE_PROMPT: &str = "\
You are drawn in botcage as a face — a head, eyes, brows, a resting smile, an optional mark and a colour — and `set_appearance` changes it. It is yours: change it when the user asks, and feel free to suggest one that suits the work you do. The vocabulary is fixed and the tool lists it, so anything outside it (a hat, a moustache, a monocle) does not exist; pick the nearest thing that does and say plainly what is not available rather than inventing it.";

/// Built-in tools a bot may use. Deliberately no Bash — shell access belongs in
/// the sandboxed desktop, not on the user's machine.
pub(crate) const TOOLS: &str = "Read,Glob,Grep,Write,Edit,WebSearch,WebFetch";

/// Every bot has these, desktop or not.
const ROUTINES_PROMPT: &str = "\
You can hold standing instructions called routines: a named job on a schedule — once at a date and \
time, every week on a given day, every day, every weekday, every hour, or every few minutes down to \
one — which arrives in this conversation and is answered by you \
exactly as if the user had typed it. So you are not limited to replying when spoken to: if someone \
asks for a morning summary, an hourly check, a nightly tidy-up, or a reminder next Tuesday, the \
answer is a routine, not \
\"I can't do that\". Say so, and propose the name, the instruction and the schedule you would use. \
The user creates and edits them from the clock icon at the top of this conversation, which opens \
their week as a calendar: clicking a slot schedules something at that day and hour, and every \
routine there has a Run now button. Two honest caveats worth passing on: routines only fire while \
botcage is open on their machine, and each one spends model usage every time it runs.";

/// Appended to the system prompt only while the bot's desktop is running.
const DESKTOP_PROMPT: &str = "\
You have your own computer: a Linux desktop (Debian, openbox, Chromium, a terminal, a file \
manager) that only you use, reachable through the `desktop` MCP tools. It is not always running — \
it switches itself off when idle — so if a tool reports it is off, call `start_desktop` and carry \
on; that takes a few seconds and the user sees it happen. Nobody else's files are \
on it and nothing you do there touches the user's machine.

Work it like an engineer, not like a person at a mouse: reach for `exec` first, because a shell \
command is faster, cheaper, and more certain than aiming at pixels — install packages with `sudo \
apt-get install -y`, move files, run scripts, read output. Use `screenshot` plus `click`, `type`, \
and `key` when the task genuinely lives in a GUI, and screenshot again afterwards to confirm what \
happened, since clicking blind is how these sessions go wrong.

For research, use your own WebSearch and WebFetch tools rather than driving a search engine in that browser. They return text instead of pixels, cost a fraction of a screenshot, and never meet a bot check. Your browser profile starts with no cookies or history, which trips Google's bot check quickly, and your traffic leaves through the user's own home connection — so a burst of automated queries can get their household address flagged and spoil their ordinary browsing, not just yours. The browser is for sites that need a real session: signing in, pages that only render with JS, flows the user demonstrated. If a CAPTCHA does appear, do not try to solve it or work around it — say so and ask the user to take control of the desktop, which they can do from the panel.

Know the geography, because the user cannot see all of it. ~/work is one directory shared three \
ways: it is your working directory on this side, it is ~/work on the desktop, and it is a real \
folder on the user's own machine. Shell commands start there, and anything the user should be able \
to open belongs there. ~/Desktop is only your screen — fine for something you want visible in a \
window, but invisible from the user's machine. Everywhere else on that box is yours alone. So say \
where you left something whenever it matters, and prefer ~/work when in doubt.";

#[derive(Default)]
struct Running(Mutex<HashMap<String, Child>>);

/* ------------------------------------------------------------------ locating */

pub(crate) fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// A Finder-launched app inherits almost no PATH, so probe known install
/// locations before falling back to whatever PATH we do have.
pub(crate) fn locate_claude() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("CLAUDE_BIN") {
        let explicit = PathBuf::from(raw);
        if explicit.is_file() {
            return Some(explicit);
        }
    }

    let mut candidates = vec![
        home().join(".local/bin/claude"),
        home().join(".claude/local/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        home().join(".bun/bin/claude"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("claude")));
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

/* -------------------------------------------------------------------- events */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BotEvent {
    bot_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Value>,
}

fn emit(app: &AppHandle, bot_id: &str, kind: &str, text: Option<String>, detail: Option<Value>) {
    let event = BotEvent {
        bot_id: bot_id.to_string(),
        kind: kind.to_string(),
        text,
        detail,
    };
    // A paired phone is fed from here rather than from the window, so a reply
    // arrives on it token by token exactly as it does on the desktop.
    if let Ok(payload) = serde_json::to_value(&event) {
        remote::broadcast("bot-event", &payload);
    }
    let _ = app.emit("bot-event", event);
}

/// Tell every listening phone that the shape of things changed.
///
/// The event stream carries a turn as it happens, which is what a phone needs
/// while it is watching one. It carries nothing about a channel being made or
/// a bot being fired, so a phone that was not looking at the moment it
/// happened went on showing a room that no longer exists — and tapping one of
/// those posts into nothing.
///
/// No payload: the phone re-reads the whole snapshot, which is one small
/// request and always right, rather than a diff that has to be applied in the
/// same order it was sent.
#[tauri::command]
fn remote_stale() {
    remote::broadcast("stale", &Value::Null);
}

/* ----------------------------------------------------------------- one turn */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskRequest {
    bot_id: String,
    /// Which engine answers for this bot. Absent on every bot made before there
    /// was a choice, which is why it falls back rather than failing.
    #[serde(default)]
    engine: Option<String>,
    /// Which provider, for an engine that is an API. A models.dev id, or
    /// "ollama" for the one on this machine.
    #[serde(default)]
    provider: Option<String>,
    session_id: String,
    /// False for a bot's first turn (creates the session), true afterwards.
    resume: bool,
    prompt: String,
    system_prompt: String,
    model: String,
    bot_name: String,
    bot_role: String,
    /// Whether the user has granted this bot a desktop at all.
    #[serde(default)]
    computer: bool,
    /// Passed through to the container if the bot starts its own desktop.
    #[serde(default)]
    brand: sandbox::BotBrand,
    /// Every other bot on this machine, by name — so this one can put work on
    /// their calendars, and knows who there is to ask.
    #[serde(default)]
    colleagues: Vec<String>,
    /// Which conversation this turn belongs to. Absent for the bot's own chat;
    /// a channel id when it is speaking in a room, so the two do not run into
    /// one another for an engine botcage keeps the transcript for.
    #[serde(default)]
    thread: Option<String>,
    /// MCP server keys this bot may use, from the app's plugin list.
    #[serde(default)]
    plugins: Vec<String>,
    /// Servers this machine offers that this particular bot may not use. They
    /// load regardless — denying them is what keeps one bot's connections out
    /// of another bot's reach.
    #[serde(default)]
    blocked_plugins: Vec<String>,
}

/// Naming the connections in the prompt is what makes a bot reach for them; the
/// tools are listed either way, but an unmentioned connector tends to go unused.
fn plugins_prompt(keys: &[String]) -> String {
    let names = keys
        .iter()
        .map(|key| key.trim_start_matches("claude_ai_").replace('_', " "))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "You are connected to: {names}. Their tools are yours to call directly \
         when a task needs them — read the calendar, search the mail, fetch the \
         file — rather than asking the user to look something up and paste it \
         back. These reach the user's real accounts, so treat writes (sending, \
         deleting, inviting) as actions worth confirming first unless they \
         asked for exactly that."
    )
}

/// Claude Code loads `CLAUDE.md` from the session's cwd on every turn, which
/// makes it the natural home for a bot's durable memory: it survives session
/// resets, costs nothing to inject, and the user can read or edit it directly.
fn ensure_memory(dir: &Path, name: &str, role: &str) {
    let path = dir.join("CLAUDE.md");
    if path.exists() {
        return;
    }

    let remit = if role.trim().is_empty() {
        String::new()
    } else {
        format!("{}\n\n", role.trim())
    };
    let body = format!(
        "# {name}\n\n{remit}## Memory\n\n\
         Notes you keep for yourself. Append what will still matter next time — \
         decisions, preferences, hard-won context — and keep it short. Correct or \
         delete anything that turns out to be wrong.\n"
    );
    let _ = fs::write(path, body);
}

/// Private scratch directory per bot, also used as the session's cwd so
/// `--resume` finds the conversation again.
pub(crate) fn workspace(app: &AppHandle, bot_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bots")
        .join(bot_id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// How many times a model may ask for tools before botcage stops asking again.
///
/// A loop needs a bound, and the bound has to be generous enough that real work
/// fits inside it — a bot reading three issues and writing a comment is four
/// rounds before it has said anything. Twelve is well past anything botcage
/// asks for and well short of a bot that has got stuck calling the same thing
/// forever, which is the failure this is here to stop.
const TOOL_ROUNDS: usize = 12;

/// One request of a turn: the process, its pipes, and where its complaints go.
///
/// A turn used to be exactly one of these, which is why this used to be written
/// inline. It stopped being one when botcage started running the tool loop
/// itself: a model that asks for a tool has not finished the turn, and the same
/// turn is put again with the result attached. The first request and the ones
/// after it start here so they cannot drift apart.
fn begin(
    app: &AppHandle,
    engine: &dyn inference::Engine,
    turn: &inference::Turn,
    bot_id: &str,
) -> Result<(std::process::ChildStdout, Arc<Mutex<String>>), String> {
    let mut cmd = engine.command(turn)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", engine.name()))?;

    // A pipe means the engine is waiting to be told; an engine that took the
    // prompt as an argument closed stdin instead, and there is nothing to send.
    // Closing the pipe afterwards is what starts the turn.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(inference::unslashed(inference::with_history(turn)).as_bytes())
            .map_err(|e| format!("could not send the prompt: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or("no stdout on the engine's process")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("no stderr on the engine's process")?;

    app.state::<Running>()
        .0
        .lock()
        .unwrap()
        .insert(bot_id.to_string(), child);

    let errors: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let drain = Arc::clone(&errors);
    std::thread::spawn(move || {
        let mut buf = String::new();
        let mut stderr = stderr;
        let _ = stderr.read_to_string(&mut buf);
        *drain.lock().unwrap() = buf;
    });

    Ok((stdout, errors))
}

/// A call the model is still in the middle of asking for.
///
/// Arrives in fragments: the name in one frame, the arguments over as many as
/// it takes. Held here until the stream ends, because a call cannot be run
/// until its arguments are complete.
#[derive(Default, Clone)]
struct Asked {
    id: String,
    name: String,
    arguments: String,
}

/// Can this build send a notification at all?
///
/// macOS hangs them off a bundle identifier, and a binary run straight out of
/// `target` has none — so under `tauri dev` the notification goes nowhere and
/// says nothing about it. The window that offers to send them asks this first,
/// so a switch that cannot work says why instead of lying.
///
/// Only macOS has that rule. This used to ask "are you inside a .app", which
/// is false on every Linux install there has ever been — so a packaged Linux
/// build disabled its own notification switch and explained that it was a
/// development build. It was not; it was a Linux build, where notifications go
/// through the desktop's portal and work perfectly well.
#[tauri::command]
fn can_notify() -> bool {
    if !cfg!(target_os = "macos") {
        return true;
    }
    std::env::current_exe()
        .map(|path| path.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

#[tauri::command]
fn ask(app: AppHandle, running: tauri::State<Running>, req: AskRequest) -> Result<(), String> {
    if running.0.lock().unwrap().contains_key(&req.bot_id) {
        return Err("this bot is already working on something".into());
    }

    // Through the registry rather than straight to one binary: what answers for
    // a bot is a property of the bot, and the reason it cannot answer is worth
    // saying precisely — "installed, but not signed in" is a different
    // afternoon from "not installed".
    let engine = inference::for_key(req.engine.as_deref());
    let ready = engine.ready();
    if !ready.usable {
        return Err(format!(
            "{} is {}",
            engine.name(),
            ready.missing.unwrap_or_else(|| "not available".into())
        ));
    }

    let cwd = workspace(&app, &req.bot_id)?;
    ensure_memory(&cwd, &req.bot_name, &req.bot_role);

    // What was said before, for an engine that cannot pick a conversation back
    // up. Read before the new prompt is recorded, so this turn's question is
    // asked once rather than appearing twice.
    //
    // An engine that is resuming its own session gets nothing: it already has
    // the conversation, and handing it over again would double every exchange.
    // Note the `resume` — a bot that changed engines has a session id its new
    // engine never created, so its first turn there is not a resumption, and
    // the history botcage kept is exactly what stops the thread starting over.
    let history = if engine.owns_transcript() && req.resume {
        Vec::new()
    } else {
        transcript::recent(&cwd, req.thread.as_deref(), transcript::BUDGET)
    };

    // A running desktop earns the bot a second set of tools, pointed at that
    // bot's container. No desktop, no tools — nothing to explain away in the
    // prompt and nothing to fail at call time.
    // Permission first: a bot with no computer is never told it has one, so it
    // describes itself the same way whether or not a container happens to run.
    // Permission, not container state, decides this: a bot allowed a computer
    // is told it has one and can switch it on itself, so its account of what it
    // can do doesn't change with whether something happens to be running.
    // Some engines cannot call a tool at all — a bare chat API has no way to
    // read a file or drive a browser. A bot on one is told that plainly rather
    // than being handed a prompt describing abilities it does not have, which
    // is the difference between a bot that says "I can't reach that" and one
    // that claims to have looked.
    let delivery = engine.tools();
    let carries_tools = delivery != inference::ToolDelivery::None;

    // Read, Grep, Write, WebSearch and the rest are Claude Code's own tools,
    // not something the protocol provides. An engine where botcage runs the
    // loop gets the bot's connectors and its desktop and no files — so the
    // built-ins are named only for the engine that actually has them. Naming
    // them anyway is how a bot ends up claiming to have read something.
    let builtins = if delivery == inference::ToolDelivery::Native {
        TOOLS
    } else {
        ""
    };
    let list = |parts: &[&str]| {
        parts
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(",")
    };

    let base = format!("{}\n\n{}", req.system_prompt, ROUTINES_PROMPT);
    // The other half of the same thought: where the engine has no file tools,
    // botcage's own server provides them, and they are granted in the same
    // breath as everything else this bot may use.
    let papers = if builtins.is_empty() && carries_tools {
        files::NAMES
    } else {
        ""
    };

    let (mut allowed, mut system_prompt) = if req.computer && carries_tools {
        sandbox::touch(&req.bot_id);
        (
            list(&[
                builtins,
                papers,
                DESKTOP_TOOLS,
                FACE_TOOL,
                SCHEDULE_TOOL,
                ASK_TOOL,
                COMMANDS_TOOL,
            ]),
            format!(
                "{base}\n\n{DESKTOP_PROMPT}\n\n{FACE_PROMPT}\n\n{SCHEDULE_PROMPT}\n\n\
                 {ASK_PROMPT}\n\n{COMMANDS_PROMPT}"
            ),
        )
    } else if carries_tools {
        (
            list(&[
                builtins,
                papers,
                FACE_TOOL,
                SCHEDULE_TOOL,
                ASK_TOOL,
                COMMANDS_TOOL,
            ]),
            format!(
                "{base}\n\n{FACE_PROMPT}\n\n{SCHEDULE_PROMPT}\n\n{ASK_PROMPT}\n\n\
                 {COMMANDS_PROMPT}"
            ),
        )
    } else {
        (TOOLS.to_string(), base)
    };

    // What this bot has written down about its own job.
    //
    // Claude Code reads the file itself, so handing it over as well would say
    // everything twice. Every other engine gets it here — without this, a bot
    // on Gemini or a hosted model keeps a memory file that nothing ever reads,
    // which is worse than having none: it looks like it remembers.
    if !engine.reads_memory() {
        if let Ok(memory) = fs::read_to_string(cwd.join("CLAUDE.md")) {
            let memory = memory.trim();
            if !memory.is_empty() {
                system_prompt.push_str(&format!(
                    "\n\n## What you have written down about this job\n\n\
                     Your own notes, kept between conversations. Trust them over your \
                     recollection, and correct them when they turn out to be wrong.\n\n{memory}"
                ));
            }
        }
    }

    // A bare `mcp__<server>` rule covers every tool that server offers, so a
    // connector gaining tools later needs no change here.
    if carries_tools {
        for key in &req.plugins {
            allowed.push_str(&format!(",mcp__{key}"));
        }
        if !req.plugins.is_empty() {
            system_prompt.push_str(&format!("\n\n{}", plugins_prompt(&req.plugins)));
        }
    } else {
        system_prompt.push_str(
            "\n\nYou have no tools in this conversation: no files, no web, no computer, and none \
             of the user's connected accounts. Answer from what you know and what is in this \
             conversation, and when something would need a tool, say so plainly rather than \
             describing what you would have found.",
        );
    }

    // The same honesty, one step in. A bot here has its connectors and its own
    // face and calendar, and cannot open a file or a web page — a real set of
    // abilities with a real edge, and a bot that knows where the edge is says
    // "I can't read that from here" instead of describing what it would have
    // found.
    if delivery == inference::ToolDelivery::Hosted {
        system_prompt.push_str(
            "\n\nYou have your own folder on the user's machine, and `read_file`, `write_file`, \
             `list_files` and `find_in_files` work in it. It is where your notes belong and where \
             anything you make for the user should go, because they can open it themselves. Paths \
             are relative to it and it is the whole of what you can reach: not the rest of their \
             machine.\n\n\
             You cannot run commands on this machine, search the web or fetch a page — those are \
             not among your tools here. When something would need one, say so plainly rather than \
             describing what you would have found.",
        );
    }

    // The connector's tools cannot check out a repo or run a build, so a bot
    // with both a desktop and GitHub is told about the CLI that can.
    if req.computer && carries_tools && req.plugins.iter().any(|key| key == "github") {
        system_prompt.push_str(
            "\n\nOn your desktop, `gh` and `git` are installed and already signed in as the \
             user — clone, branch, commit, push and open pull requests there when a task needs \
             a working copy rather than a single file edit. Prefer your GitHub tools for \
             reading issues or files, which is cheaper than a checkout.",
        );
    }

    // Which servers a bot gets is botcage's decision, and stays here: a desktop
    // if it has one, plus the connectors it was granted, each carrying the
    // credential we hold — so the grant decides reach, not whatever happens to
    // be configured on the machine.
    let mut servers = serde_json::Map::new();

    // Every bot that can call a tool gets botcage's own server, whether or not
    // it has a computer: it is where a bot reaches its own face, and a face is
    // not a feature of owning a machine. The desktop tools inside it report
    // that there is no desktop when there isn't one, which is the same answer
    // they give when one is merely switched off.
    if carries_tools {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find my own binary: {e}"))?;
        servers.insert(
            "desktop".into(),
            serde_json::json!({
                "command": exe.display().to_string(),
                "args": ["--mcp"],
                "env": {
                    "BOTCAGE_BOT": req.bot_id,
                    "BOTCAGE_COLLEAGUES": req.colleagues.join("\n"),
                    "BOTCAGE_WORKSPACE": cwd.display().to_string(),
                    "BOTCAGE_BRAND": serde_json::to_string(&req.brand).unwrap_or_default(),
                    // Only where the engine brings none of its own.
                    "BOTCAGE_FILES": if builtins.is_empty() { "1" } else { "" },
                }
            }),
        );
    }

    if carries_tools {
        for key in &req.plugins {
            if let Some(entry) = connectors::server_entry(key, Some(&req.bot_id)) {
                servers.insert(key.clone(), entry);
            }
        }
    }

    let servers = serde_json::Value::Object(servers);

    // An engine that speaks MCP is handed the servers and asks them itself.
    // One that does not needs botcage to have asked already: the tools go into
    // the request as functions, and answering when the model calls one is this
    // process's job for the rest of the turn.
    //
    // Starting them costs a moment before the first token, which is the price
    // of a bot that can actually do something. Only the servers this bot was
    // granted are started, and only the tools it is allowed are offered.
    let mut bench = if delivery == inference::ToolDelivery::Hosted {
        mcp_client::Bench::open(&servers, &allowed)
    } else {
        mcp_client::Bench::default()
    };

    // A connector that would not start is said out loud rather than silently
    // missing. A bot that knows its GitHub is down can say so; one that simply
    // finds no tool for it will invent a reason.
    for (name, why) in &bench.broken {
        system_prompt.push_str(&format!(
            "\n\nYour {name} connector could not be started this turn ({why}), so none of its \
             tools are available. Say so if something needs it."
        ));
    }

    // What tools, which connectors, which secrets: botcage's decisions. How any
    // of it is spelled on a command line: the engine's.
    let turn = inference::Turn {
        session_id: req.session_id.clone(),
        resume: req.resume,
        prompt: req.prompt.clone(),
        system_prompt,
        model: req.model.clone(),
        cwd: cwd.clone(),
        allowed_tools: allowed,
        denied_plugins: req.blocked_plugins.clone(),
        mcp_servers: servers,
        env: plugins::env_for(&req.plugins),
        history,
        // Empty for an engine that runs its own loop, which is what tells the
        // request builder there is nothing to send.
        tools: bench.definitions().to_vec(),
        pending: Vec::new(),
        // Resolved here, not in the engine: which provider a bot uses is the
        // app's business, and the key belongs to the keychain rather than to
        // anything that builds a command line.
        api: req.provider.as_deref().and_then(|id| {
            catalogue::provider(&app, id).map(|found| inference::Api {
                key: catalogue::key_for(id),
                provider: found.name,
                base: found.api,
            })
        }),
    };

    // The first request of the turn. Started here rather than in the thread so
    // that an engine which cannot be started at all is an error the window gets
    // back from this call, the way it always was.
    let (stdout, errors) = begin(&app, engine.as_ref(), &turn, &req.bot_id)?;

    // Kept for every engine, not only the ones that need it read back. It costs
    // a line per message, and it is what lets a bot keep its thread when the
    // thing answering for it changes.
    let _ = transcript::append(
        &cwd,
        req.thread.as_deref(),
        transcript::Voice::User,
        &req.prompt,
    );

    let app_handle = app.clone();
    let bot_id = req.bot_id.clone();
    let reader = inference::for_key(req.engine.as_deref());
    let workspace = cwd.clone();
    let thread = req.thread.clone();
    std::thread::spawn(move || {
        let mut turn = turn;
        let mut final_text: Option<String> = None;
        let mut failure: Option<String> = None;
        let mut spend: Option<Value> = None;
        // What the bot has actually said so far, for the transcript. An engine
        // that reports a finished answer is believed over this; one that only
        // streams still has to be remembered. Across every round of the turn,
        // not just the last: a bot often says something before it reaches for a
        // tool, and that was part of its answer.
        let mut spoken = String::new();

        // The pipes of the round being read. Replaced by the next round's when
        // the model asks for a tool, which is the only reason this is a loop.
        let mut pipes = Some((stdout, errors));
        // Whichever round's stderr we end up reporting: the last one to run.
        let mut errors: Arc<Mutex<String>>;

        for round in 0.. {
            let Some((stdout, drain)) = pipes.take() else {
                break;
            };
            errors = drain;
            // What the model has asked to call this round, still arriving.
            let mut asked: Vec<Asked> = Vec::new();
            let mut said_this_round = String::new();

            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                // Read by the engine rather than here. What a stream means is the
                // engine's business; this loop's business is what botcage does
                // about it, and the two were the same code only because there was
                // one engine.
                for event in reader.read_line(&line) {
                    match event {
                        inference::Event::Delta(text) => {
                            spoken.push_str(&text);
                            said_this_round.push_str(&text);
                            emit(&app_handle, &bot_id, "delta", Some(text), None)
                        }
                        inference::Event::Thinking(text) => {
                            emit(&app_handle, &bot_id, "thinking", Some(text), None)
                        }
                        inference::Event::Tool(name) => {
                            emit(&app_handle, &bot_id, "tool", Some(name), None)
                        }
                        // Assembled rather than acted on: the arguments are still
                        // arriving, and a call cannot be run half-written. The
                        // index is the provider's, and is what keeps two calls
                        // asked for at once from becoming one.
                        inference::Event::Calling {
                            index,
                            id,
                            name,
                            arguments,
                        } => {
                            if asked.len() <= index {
                                asked.resize(index + 1, Asked::default());
                            }
                            let call = &mut asked[index];
                            if let Some(id) = id {
                                call.id = id;
                            }
                            if let Some(name) = name {
                                call.name.push_str(&name);
                            }
                            call.arguments.push_str(&arguments);
                        }
                        inference::Event::RateLimit {
                            status,
                            kind,
                            resets_at,
                        } => emit(
                            &app_handle,
                            &bot_id,
                            "rate-limit",
                            None,
                            Some(serde_json::json!({
                                "status": status,
                                "rateLimitType": kind,
                                "resetsAt": resets_at,
                            })),
                        ),
                        // Held rather than emitted: the turn is only over once the
                        // process is, and how it ended decides which of these the
                        // app is told about.
                        inference::Event::Done {
                            text,
                            cost_usd,
                            duration_ms,
                        } => {
                            final_text = text;
                            spend = Some(serde_json::json!({
                                "costUsd": cost_usd,
                                "durationMs": duration_ms,
                            }));
                        }
                        inference::Event::Error(why) => failure = Some(why),
                    }
                }
            }

            // stdout is closed, so this round's process is finished or was killed.
            let status = app_handle
                .state::<Running>()
                .0
                .lock()
                .unwrap()
                .remove(&bot_id)
                .map(|mut child| child.wait());
            let ended_well = matches!(&status, Some(Ok(code)) if code.success());

            // The model asked for something rather than answering. Run what it
            // asked for, hang the answers on the turn, and put the same turn again:
            // this is the tool loop, and it is why a turn can outlive a process.
            if status.is_some() && ended_well && failure.is_none() && !asked.is_empty() {
                if round >= TOOL_ROUNDS {
                    // Almost certainly a bot going round in circles. Saying so is
                    // better than answering with silence, and better than looping
                    // until someone notices the fan.
                    failure = Some(format!(
                    "this bot asked to use tools {TOOL_ROUNDS} times without reaching an answer"
                ));
                } else {
                    let mut calls = Vec::new();
                    let mut results = Vec::new();
                    for (nth, call) in asked.iter().enumerate() {
                        // Some providers omit the id on a single call; the pair
                        // only has to match each other.
                        let id = if call.id.is_empty() {
                            format!("call_{round}_{nth}")
                        } else {
                            call.id.clone()
                        };
                        emit(&app_handle, &bot_id, "tool", Some(call.name.clone()), None);
                        // Echoed back exactly as the model wrote them, whatever it
                        // wrote; parsed separately, because a model that sent
                        // malformed arguments should be told by the tool rather
                        // than have the turn fall over.
                        let arguments: Value = serde_json::from_str(&call.arguments)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        let answer = bench.call(&call.name, &arguments);
                        calls.push(serde_json::json!({
                            "id": id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments },
                        }));
                        results.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": id,
                            "content": answer,
                        }));
                    }

                    // The model's own turn, as it made it, and then the answers.
                    // Anything it said before reaching for the tool belongs in the
                    // first of those, or it will say it twice.
                    turn.pending.push(serde_json::json!({
                    "role": "assistant",
                    "content": if said_this_round.is_empty() { Value::Null } else { Value::String(said_this_round.clone()) },
                    "tool_calls": calls,
                }));
                    turn.pending.extend(results);

                    match begin(&app_handle, reader.as_ref(), &turn, &bot_id) {
                        Ok(next) => {
                            pipes = Some(next);
                            continue;
                        }
                        Err(why) => failure = Some(why),
                    }
                }
            }

            // Whatever was said, including by a turn that was stopped halfway: the
            // app keeps that text on screen, and a transcript that disagreed with
            // the screen would be worse than no transcript. The finished answer
            // wins when there is one, on the same grounds the app prefers it.
            let said = match &final_text {
                Some(text) if text.len() >= spoken.len() => text.clone(),
                _ => spoken.clone(),
            };
            let _ =
                transcript::append(&workspace, thread.as_deref(), transcript::Voice::Bot, &said);

            match status {
                // Removed by `cancel` — that path emits its own terminal event.
                None => {}
                Some(result) => {
                    let ok = matches!(&result, Ok(status) if status.success());
                    if let Some(message) = failure {
                        emit(&app_handle, &bot_id, "error", Some(message), None);
                    } else if ok {
                        emit(&app_handle, &bot_id, "done", final_text, spend);
                    } else {
                        let stderr = errors.lock().unwrap().trim().to_string();
                        let tail = stderr.lines().rev().take(4).collect::<Vec<_>>().join(" ");
                        let message = if tail.is_empty() {
                            format!("{} stopped before finishing the reply", reader.name())
                        } else {
                            tail
                        };
                        emit(&app_handle, &bot_id, "error", Some(message), None);
                    }
                }
            }

            // Nothing asked for, so nothing left to ask.
            break;
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel(app: AppHandle, running: tauri::State<Running>, bot_id: String) {
    let child = running.0.lock().unwrap().remove(&bot_id);
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        emit(&app, &bot_id, "cancelled", None, None);
    }
}

/* --------------------------------------------------------------- backups */

/// Where the passphrase lives between backups.
///
/// In the keychain, beside the API keys and connector tokens, because an
/// unattended backup cannot stop and ask. The passphrase is what makes the
/// archive portable — the keychain copy is only so the timer does not need a
/// person present.
const BACKUP_SECRET: &str = "backup-passphrase";

/// Whether botcage is holding a passphrase, without saying what it is.
#[tauri::command]
fn backup_ready() -> bool {
    connectors::read_secret(BACKUP_SECRET).is_some_and(|word| !word.is_empty())
}

/// Set or change the passphrase.
///
/// Changing it does not re-encrypt the archives already written: those still
/// open with the passphrase they were made with, which is worth knowing before
/// you forget it.
#[tauri::command]
fn backup_passphrase(passphrase: String) -> Result<(), String> {
    if passphrase.chars().count() < 8 {
        return Err(
            "use at least eight characters — this is the only thing between the backup \
                    and whoever finds it"
                .into(),
        );
    }
    connectors::write_secret(BACKUP_SECRET, &passphrase)
}

/// One archive, now.
///
/// `state` is the window's own store: the conversations are in the webview and
/// this process cannot read them, so they are handed over rather than found.
#[tauri::command]
fn backup_now(
    app: AppHandle,
    state: String,
    folder: String,
    keep: usize,
) -> Result<String, String> {
    let word = connectors::read_secret(BACKUP_SECRET)
        .filter(|w| !w.is_empty())
        .ok_or("set a passphrase first — a backup without one is only a copy")?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    let into = PathBuf::from(&folder);

    let written = backup::write(&data, &state, &word, &into)?;
    // Only ever after a good one. Tidying first would be a way of throwing away
    // the last copy immediately before failing to make a new one.
    backup::prune(&into, keep.max(1));
    Ok(written.display().to_string())
}

/// Somewhere sensible to keep backups, so that switching them on is a switch.
///
/// iCloud Drive if this machine has it, because the whole point is a copy that
/// is not on this machine and that is the folder most people already sync.
/// Documents otherwise. Either way it is a suggestion: the folder is shown and
/// can be changed, and nothing is written until the user asks.
#[tauri::command]
fn backup_default_folder() -> String {
    let icloud = home().join("Library/Mobile Documents/com~apple~CloudDocs");
    let base = if icloud.is_dir() {
        icloud
    } else {
        home().join("Documents")
    };
    base.join("botcage-backups").display().to_string()
}

/// The archives in a folder, newest first.
#[tauri::command]
fn backup_list(folder: String) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(&folder) else {
        return Vec::new();
    };
    let mut found: Vec<Value> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("botcage-") && name.ends_with(".backup")
        })
        .map(|e| {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            serde_json::json!({
                "name": e.file_name().to_string_lossy(),
                "path": e.path().display().to_string(),
                "bytes": size,
            })
        })
        .collect();
    // The names carry the time they were taken, so this is chronological.
    found.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    found
}

/// Open one, put the files back, and hand the window its store.
///
/// The window is what finishes the job: it takes the state, saves it, and
/// reloads. Doing it here would mean a Rust process reaching into the webview's
/// storage, which is exactly the coupling the rest of botcage avoids.
#[tauri::command]
fn backup_restore(app: AppHandle, path: String, passphrase: String) -> Result<String, String> {
    let sealed = fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    let restored = backup::read(&sealed, &passphrase)?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    restored.unpack(&data)?;
    Ok(restored.state)
}

/// What a bot decided it should look like, if it changed its face this turn.
///
/// Read once and removed: the file is a message from a process that has since
/// exited, not a record of anything. Returning it rather than storing it keeps
/// a bot's appearance where the rest of a bot lives — in the window's own
/// state, saved with everything else about it.
#[tauri::command]
fn take_face(app: AppHandle, bot_id: String) -> Option<Value> {
    let path = workspace(&app, &bot_id).ok()?.join("face.json");
    let raw = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

/// What a bot has written down about its job, for the window to show.
///
/// It is the one part of a bot that the bot writes and the user reads. Until
/// now it lived in a file nobody opened: the app created it, told the bot to
/// keep it, and then offered no way to see whether it had — so a memory that
/// had quietly filled with something wrong stayed wrong.
#[tauri::command]
fn read_memory(app: AppHandle, bot_id: String) -> String {
    workspace(&app, &bot_id)
        .ok()
        .and_then(|dir| fs::read_to_string(dir.join("CLAUDE.md")).ok())
        .unwrap_or_default()
}

/// Correct it by hand.
///
/// The user editing this is the point rather than a fallback: a bot that has
/// written down something untrue will go on acting on it every turn, and the
/// fastest fix is a person deleting the line.
#[tauri::command]
fn write_memory(app: AppHandle, bot_id: String, text: String) -> Result<(), String> {
    let dir = workspace(&app, &bot_id)?;
    fs::write(dir.join("CLAUDE.md"), text).map_err(|e| e.to_string())
}

/// Write a bot's template where the user asked for it.
///
/// Plain JSON on disk rather than anything sealed: the point of a template is
/// that somebody else can read it, and a person handing one over should be
/// able to open it first and see exactly what they are handing over. It is the
/// window that decides what goes in; this only writes what it is given.
#[tauri::command]
fn template_write(path: String, json: String) -> Result<(), String> {
    fs::write(&path, json).map_err(|e| format!("could not write {path}: {e}"))
}

/// Read one back.
///
/// Capped, because this is the one file botcage opens that came from somebody
/// else: a template is a few kilobytes and anything claiming to be one that is
/// megabytes long is not worth parsing to find out what it is.
#[tauri::command]
fn template_read(path: String) -> Result<String, String> {
    let size = fs::metadata(&path)
        .map_err(|e| format!("could not open {path}: {e}"))?
        .len();
    if size > 512 * 1024 {
        return Err("that file is far too large to be a bot template".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))
}

/// A question a bot left for the user this turn, if it left one.
///
/// Read once and removed, like the face and the routines: a note from a
/// process that has since exited. The answers become buttons under the reply,
/// and pressing one sends it as the user's own next message — so nothing here
/// has to be remembered on this side.
#[tauri::command]
fn take_ask(app: AppHandle, bot_id: String) -> Option<Value> {
    let path = workspace(&app, &bot_id).ok()?.join("ask.json");
    let raw = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

/// The shortcuts a bot declared this turn, if it declared any.
///
/// An empty list is meaningful — a bot withdrawing its commands — so the
/// absence of the file and an empty file are different answers, and only the
/// first is `None`.
#[tauri::command]
fn take_commands(app: AppHandle, bot_id: String) -> Option<Value> {
    let path = workspace(&app, &bot_id).ok()?.join("commands.json");
    let raw = fs::read_to_string(&path).ok()?;
    let _ = fs::remove_file(&path);
    serde_json::from_str(&raw).ok()
}

/// Work a bot scheduled this turn, for itself or for a colleague.
///
/// Read once and removed, like the face: these are messages from a process
/// that has already exited. Names rather than ids, because a bot says "Ops"
/// and only the window knows which bot that is — or that there is no longer
/// one by that name.
#[tauri::command]
fn take_routines(app: AppHandle, bot_id: String) -> Vec<Value> {
    let Ok(path) = workspace(&app, &bot_id).map(|dir| dir.join("routines.jsonl")) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let _ = fs::remove_file(&path);
    raw.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Say yes when the page asks for the microphone.
///
/// Only Linux has anything to do here. WebKitGTK does not decide for itself
/// whether a page may use a device — it emits `permission-request` and lets
/// whoever embedded it answer — and wry implements that for the macOS and
/// Android webviews but not for GTK. An unanswered request is a denied one, so
/// without this a call on Linux is silent and says nothing about why.
///
/// The answer is yes because botcage is not a browser: there is one page, we
/// wrote it, and it asks for the microphone at exactly one moment — while you
/// are holding the talk button on a call you started. macOS asks the user
/// instead, through the system, which is the right place for that question
/// when the code being run might have come from anywhere. Here it did not.
#[cfg(target_os = "linux")]
fn allow_the_microphone(app: &tauri::App) {
    use tauri::Manager;
    // `is` comes from glib rather than from webkit, and the compiler on a Mac
    // never sees this block — so this was found by compiling these exact calls
    // in a Debian container rather than by reading.
    use webkit2gtk::glib::ObjectExt;
    use webkit2gtk::{PermissionRequestExt, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|view| {
        view.inner().connect_permission_request(|_, request| {
            // Only the microphone. Anything else this page has no business
            // asking for, and a blanket yes would be a different promise.
            if request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn allow_the_microphone(_app: &tauri::App) {}

/// Someone clicked "Add to botcage" on a template.
///
/// The link carries the whole template rather than an id to fetch, so the app
/// never has to talk to the website and a link keeps working after the page it
/// came from is gone. It arrives here as a `botcage://` URL and goes straight
/// to the window as text — this end deliberately does not parse it, because
/// the thing that has to understand a template is the thing that builds a bot
/// out of one, and that lives in the front end already.
///
/// Nothing is created by a link arriving. It opens the new-bot sheet with the
/// fields filled in, and a person presses the button. A web page that could
/// silently add a bot to your roster is a web page that could add a bot to
/// your roster while you were reading something else.
fn handed_a_bot(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // Raise the window first. A link opened from a browser means the
            // browser has the front, and filling in a form nobody can see is
            // the same as doing nothing.
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = handle.emit("deep-link", url.to_string());
        }
    });
}

/// Whether botcage's own speech engine is installed.
#[tauri::command]
fn speech_ready(app: AppHandle) -> bool {
    speech::ready(&app)
}

/// Fetch it. Reports progress on the "speech" event.
#[tauri::command]
async fn speech_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || speech::install(&app))
        .await
        .map_err(|e| format!("download thread: {e}"))?
}

/// Remove it, and go back to the machine's own voice.
#[tauri::command]
fn speech_forget(app: AppHandle) -> Result<(), String> {
    speech::forget(&app)
}

/// Whether this machine can already turn speech into words.
#[tauri::command]
fn hearing_ready(app: AppHandle) -> bool {
    hearing::ready(&app)
}

/// Fetch the speech model. Reports progress on the "hearing" event.
#[tauri::command]
async fn hearing_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || hearing::install(&app))
        .await
        .map_err(|e| format!("download thread: {e}"))?
}

/// What was said, from mono 16 kHz samples the window recorded.
///
/// Off the main thread: a few seconds of speech takes a moment even on the
/// GPU, and the window is showing a face that should keep blinking.
#[tauri::command]
async fn transcribe(app: AppHandle, samples: Vec<f32>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hearing::listen(&app, &samples))
        .await
        .map_err(|e| format!("transcription thread: {e}"))?
}

/// Say it out loud, in whichever voice this bot was given.
///
/// Answers when the speaking stops rather than when it starts: the window
/// moves the bot's mouth for as long as this takes, and a promise that
/// resolved on spawn would have a face finish talking a sentence early.
#[tauri::command]
async fn speak(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    rate: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || voice::speak(&app, &text, voice.as_deref(), rate))
        .await
        .map_err(|e| format!("speech thread: {e}"))?
}

/// Stop talking — the call ended, or you have heard enough.
#[tauri::command]
fn hush() {
    voice::hush();
}

/// The voices this machine has for a language, so each bot can have its own.
#[tauri::command]
fn voices(app: AppHandle, language: String) -> Vec<String> {
    voice::voices(&app, &language)
}

/// Forget the conversation, keeping the bot.
///
/// The app starts a new session id at the same moment, which is what ends the
/// thread for an engine that keeps its own. For one that does not, the thread
/// is this file — so clearing on screen has to clear it here, or a "cleared"
/// bot would carry on referring to what was just deleted.
#[tauri::command]
fn clear_thread(app: AppHandle, bot_id: String, thread: Option<String>) -> Result<(), String> {
    transcript::clear(&workspace(&app, &bot_id)?, thread.as_deref())
}

/// Forget a bot for good: kill any turn in flight, drop its Claude Code
/// transcript, and delete its workspace. The desktop is torn down separately by
/// `sandbox_destroy` so this stays usable when Docker isn't installed.
#[tauri::command]
fn forget_bot(
    app: AppHandle,
    running: tauri::State<Running>,
    bot_id: String,
) -> Result<(), String> {
    if let Some(mut child) = running.0.lock().unwrap().remove(&bot_id) {
        let _ = child.kill();
        let _ = child.wait();
    }

    let dir = workspace(&app, &bot_id)?;
    // Claude Code keys transcripts by cwd, with path separators flattened to '-'.
    let encoded: String = dir
        .display()
        .to_string()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let transcripts = home().join(".claude/projects").join(&encoded);

    let _ = fs::remove_dir_all(&transcripts);
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

/// Holds the power assertion while it is on: a child process whose lifetime is
/// the assertion. Killing it releases the machine back to normal sleep.
static AWAKE: Mutex<Option<Child>> = Mutex::new(None);

/// Keep the machine from idle-sleeping so bots and routines keep running with
/// the screen off. The display is deliberately left free to sleep.
#[tauri::command]
fn set_awake(on: bool) -> Result<(), String> {
    let mut guard = AWAKE.lock().unwrap();

    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if !on {
        return Ok(());
    }

    // -i holds off idle sleep on any power source; the display is left alone so
    // the screen can still switch off.
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = Command::new("/usr/bin/caffeinate");
        cmd.arg("-i");
        cmd
    };

    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut cmd = Command::new("systemd-inhibit");
        cmd.args([
            "--what=idle:sleep",
            "--who=botcage",
            "--why=running bots",
            "--mode=block",
            "sleep",
            "infinity",
        ]);
        cmd
    };

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        return Err("keeping the machine awake isn't wired up on this platform yet".into());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not hold the machine awake: {e}"))?;
        *guard = Some(child);
        Ok(())
    }
}

/// Whether lid-close sleep is currently disabled system-wide.
#[tauri::command]
fn lid_awake() -> bool {
    Command::new("/usr/bin/pmset")
        .arg("-g")
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout).lines().any(|line| {
                let line = line.trim();
                line.starts_with("disablesleep") && line.ends_with('1')
            })
        })
        .unwrap_or(false)
}

/// Keep working with the lid shut. Unlike the idle assertion this is a system
/// setting, not something scoped to this app: it needs an administrator, it
/// outlives botcage until switched off, and a closed machine doing constant
/// work runs hotter.
#[tauri::command]
fn set_lid_awake(on: bool) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("lid-close behaviour can only be changed on macOS here".into());
    }

    let script = format!(
        "do shell script \"pmset -a disablesleep {}\" with administrator privileges",
        u8::from(on)
    );
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("could not ask for permission: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&out.stderr);
    Err(if message.contains("-128") {
        "cancelled".into()
    } else {
        message.trim().to_string()
    })
}

/// Is botcage set to start when the user logs in?
#[tauri::command]
fn login_launch() -> bool {
    login_item_path().map(|path| path.exists()).unwrap_or(false)
}

fn login_item_path() -> Option<PathBuf> {
    let home = home();
    if cfg!(target_os = "macos") {
        Some(home.join("Library/LaunchAgents/com.hackyguru.botcage.plist"))
    } else if cfg!(target_os = "linux") {
        Some(home.join(".config/autostart/botcage.desktop"))
    } else {
        None
    }
}

/// Start botcage at login, so "always running" survives a restart.
#[tauri::command]
fn set_login_launch(on: bool) -> Result<(), String> {
    let path = login_item_path().ok_or("launching at login isn't wired up on this platform yet")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    if !on {
        if cfg!(target_os = "macos") && path.exists() {
            let _ = Command::new("/bin/launchctl")
                .args(["unload", "-w"])
                .arg(&path)
                .output();
        }
        let _ = fs::remove_file(&path);
        return Ok(());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let body = if cfg!(target_os = "macos") {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
             \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\"><dict>\n\
             <key>Label</key><string>com.hackyguru.botcage</string>\n\
             <key>ProgramArguments</key><array><string>{}</string></array>\n\
             <key>RunAtLoad</key><true/>\n\
             </dict></plist>\n",
            exe.display()
        )
    } else {
        format!(
            "[Desktop Entry]\nType=Application\nName=botcage\nExec={}\nX-GNOME-Autostart-enabled=true\n",
            exe.display()
        )
    };

    fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    if cfg!(target_os = "macos") {
        let _ = Command::new("/bin/launchctl")
            .args(["load", "-w"])
            .arg(&path)
            .output();
    }
    Ok(())
}

/// Who is logged in, in the order the answers are likely to be there.
///
/// Separated from the environment so the order can be tested, which is the
/// only part worth testing: every variable here is set on some systems and
/// missing on others, and the bug this prevents is a blank name on somebody
/// else's machine rather than on this one.
fn name_from(env: impl Fn(&str) -> Option<String>, ask: impl Fn() -> Option<String>) -> String {
    // USER is set by login shells and by launchd for a Mac app opened from the
    // Dock. LOGNAME is the POSIX one, and is what some Linux desktops set when
    // USER is absent — a session started by systemd rather than by a shell has
    // often had one and not the other. USERNAME is Windows.
    for name in ["USER", "LOGNAME", "USERNAME"] {
        if let Some(found) = env(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            return found;
        }
    }
    // Nothing in the environment, so ask the system. `id -un` reads the passwd
    // database, which is the actual answer rather than a variable somebody may
    // have unset, and exists on macOS and Linux alike.
    ask().map(|v| v.trim().to_string()).unwrap_or_default()
}

#[tauri::command]
fn user_name() -> String {
    name_from(
        |name| std::env::var(name).ok(),
        || {
            Command::new("id")
                .arg("-un")
                .output()
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        },
    )
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Where bots keep their workspaces, so the menu can open it.
#[tauri::command]
fn bots_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/* --------------------------------------------------------- teaching a task */

/// Grab one frame of the demonstration into the bot's workspace. Frames land in
/// the shared folder, so the bot reads them with its own Read tool (it handles
/// PNGs) instead of us pushing image bytes through the prompt.
#[tauri::command]
fn teach_capture(
    app: AppHandle,
    bot_id: String,
    slug: String,
    index: u32,
    width: Option<u32>,
) -> Result<String, String> {
    let port = sandbox::control_port_for(&bot_id).ok_or("this bot's desktop isn't running")?;
    let path = format!("/screenshot?width={}", width.unwrap_or(1200));
    let (status, body) = mcp::request(port, "GET", &path, None)?;
    if status != 200 {
        return Err(format!("the desktop returned {status} for a screenshot"));
    }

    let dir = workspace(&app, &bot_id)?.join("teach").join(&slug);
    // Re-teaching under the same name replaces the old demonstration rather
    // than interleaving frames with it.
    if index == 1 {
        let _ = fs::remove_dir_all(&dir);
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("frame-{index:02}.png");
    fs::write(dir.join(&name), body).map_err(|e| e.to_string())?;
    Ok(format!("teach/{slug}/{name}"))
}

/// Write the input log that accompanies the frames.
#[tauri::command]
fn teach_save(
    app: AppHandle,
    bot_id: String,
    slug: String,
    steps: String,
    events: String,
) -> Result<String, String> {
    let dir = workspace(&app, &bot_id)?.join("teach").join(&slug);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("steps.md"), steps).map_err(|e| e.to_string())?;
    // The machine-readable twin, so `replay` can repeat the demonstration
    // exactly without a model re-deriving it from prose.
    fs::write(dir.join("steps.json"), events).map_err(|e| e.to_string())?;
    Ok(format!("teach/{slug}"))
}

/// The name a bot chose for an unnamed demonstration, if it wrote one.
#[tauri::command]
fn teach_name(app: AppHandle, bot_id: String, slug: String) -> Option<String> {
    let path = workspace(&app, &bot_id)
        .ok()?
        .join("teach")
        .join(&slug)
        .join("name.txt");
    let raw = fs::read_to_string(path).ok()?;
    let name = raw.lines().next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.chars().take(48).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Only so a person can point at a folder for their backups. botcage
        // never opens one on its own.
        .plugin(tauri_plugin_dialog::init())
        // Notifications when botcage is not the window you are looking at.
        .plugin(tauri_plugin_notification::init())
        // "botcage://" — how a template on the website gets into the roster.
        // Nothing is created by a link arriving; see `handed_a_bot`.
        .plugin(tauri_plugin_deep_link::init())
        .manage(Running::default())
        .manage(sandbox::Sandboxes::default())
        .invoke_handler(tauri::generate_handler![
            ask,
            can_notify,
            remote_stale,
            push::push_state,
            push::push_setup,
            push::push_forget,
            push::push_send,
            cancel,
            forget_bot,
            clear_thread,
            take_face,
            take_ask,
            take_commands,
            template_write,
            template_read,
            read_memory,
            write_memory,
            backup_ready,
            backup_passphrase,
            backup_now,
            backup_default_folder,
            backup_list,
            backup_restore,
            take_routines,
            speak,
            hush,
            voices,
            speech_ready,
            speech_install,
            speech_forget,
            hearing_ready,
            hearing_install,
            transcribe,
            bots_dir,
            app_version,
            user_name,
            plugins::list_plugins,
            connectors::connectors,
            connectors::connect_connector,
            connectors::disconnect_connector,
            connectors::google_consent_url,
            connectors::google_finish,
            connectors::github_scopes,
            connectors::mcp_oauth_start,
            connectors::mcp_oauth_finish,
            connectors::github_device_start,
            connectors::github_device_finish,
            plugins::plugin_catalog,
            plugins::plugin_detail,
            plugins::verify_catalogue,
            plugins::set_plugin_secret,
            plugins::install_plugin,
            plugins::uninstall_plugin,
            set_awake,
            lid_awake,
            set_lid_awake,
            login_launch,
            set_login_launch,
            teach_capture,
            teach_save,
            teach_name,
            sandbox::docker_info,
            p2p::p2p_start,
            p2p::p2p_id,
            p2p::p2p_address,
            remote::remote_status,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_pairing_code,
            remote::remote_forget_devices,
            remote::remote_forget_device,
            remote::remote_reply,
            inference::engines,
            catalogue::catalogue_state,
            catalogue::catalogue_refresh,
            catalogue::catalogue_search,
            catalogue::catalogue_providers,
            catalogue::provider_key_set,
            catalogue::provider_key_clear,
            setup::claude_state,
            setup::install_claude,
            setup::claude_sign_in,
            engine::engine_status,
            engine::install_engine,
            engine::start_engine,
            sandbox::sandbox_status,
            sandbox::sandbox_start,
            sandbox::sandbox_stop,
            sandbox::sandbox_rebuild,
            sandbox::sandbox_keepalive,
            sandbox::set_idle_limit,
            sandbox::rebuild_image,
            sandbox::sandbox_destroy,
            sandbox::sandbox_sync_tools,
        ])
        .setup(|app| {
            allow_the_microphone(app);
            handed_a_bot(app);

            // If botcage installed its own engine, use that rather than whatever
            // is on PATH — it is the one the user agreed to.
            let handle = app.handle().clone();
            sandbox::use_managed_engine(
                engine::managed_client(&handle),
                engine::docker_host(&handle),
            );

            // Bots may switch their own desktops on, so something has to switch
            // idle ones off.
            sandbox::start_reaper();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                // Release the power assertion with the app that took it.
                if let Some(mut child) = AWAKE.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                sandbox::stop_all();
                // Before the C++ globals get their turn: see hearing::unload.
                hearing::unload();
            }
        });
}

#[cfg(test)]
mod who_tests {
    use super::name_from;

    /// The order matters more than any single variable: each of these is set
    /// on some systems and missing on others, and the failure it prevents
    /// happens on a machine that is not this one.
    #[test]
    fn every_platform_has_something_to_answer_with() {
        let only = |have: &'static str, value: &'static str| {
            move |name: &str| (name == have).then(|| value.to_string())
        };
        let never = || None;

        // A Mac app opened from the Dock, and a login shell anywhere.
        assert_eq!(name_from(only("USER", "ada"), never), "ada");
        // A Linux session started by systemd rather than by a shell.
        assert_eq!(name_from(only("LOGNAME", "ada"), never), "ada");
        // Windows.
        assert_eq!(name_from(only("USERNAME", "ada"), never), "ada");
    }

    #[test]
    fn an_empty_variable_is_not_an_answer() {
        // Set-but-blank is commoner than unset, and reads as a user with no
        // name rather than as a missing one.
        let blank_user = |name: &str| (name == "USER").then(|| "   ".to_string());
        assert_eq!(name_from(blank_user, || Some("ada\n".into())), "ada");
    }

    #[test]
    fn the_system_is_asked_when_the_environment_is_bare() {
        assert_eq!(name_from(|_| None, || Some("ada\n".into())), "ada");
        // And when even that fails, nothing — the window shows a placeholder
        // rather than the word "undefined".
        assert_eq!(name_from(|_| None, || None), "");
    }
}
