//! Bridge between the botcage UI and the local Claude Code CLI.
//!
//! Each turn spawns `claude -p --output-format stream-json` in the bot's own
//! workspace directory and relays the parsed stream to the webview as
//! `bot-event` events. Auth comes from the user's own `claude` login, so no
//! API key ever passes through this process.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

mod connectors;
mod mcp;
mod oauth;
mod plugins;
mod sandbox;

/// Entry point for `botcage --mcp` (see main.rs). Identity arrives in the
/// environment, set by the app when it registers this server.
pub fn serve_mcp() {
    let brand = std::env::var("BOTCAGE_BRAND")
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    mcp::serve(mcp::Bot {
        id: std::env::var("BOTCAGE_BOT").unwrap_or_default(),
        workspace: std::env::var("BOTCAGE_WORKSPACE").unwrap_or_default().into(),
        brand,
    });
}

/// Tools the desktop MCP server provides, named as Claude Code addresses them.
const DESKTOP_TOOLS: &str = "mcp__desktop__screenshot,mcp__desktop__exec,mcp__desktop__click,\
mcp__desktop__move,mcp__desktop__type,mcp__desktop__key,mcp__desktop__scroll,mcp__desktop__replay,\
mcp__desktop__start_desktop";

/// Built-in tools a bot may use. Deliberately no Bash — shell access belongs in
/// the sandboxed desktop, not on the user's machine.
const TOOLS: &str = "Read,Glob,Grep,Write,Edit,WebSearch,WebFetch";

/// Every bot has these, desktop or not.
const ROUTINES_PROMPT: &str = "\
You can hold standing instructions called routines: a named job on a schedule — every day, every \
weekday, every hour, or every few minutes down to one — which arrives in this conversation and is answered by you \
exactly as if the user had typed it. So you are not limited to replying when spoken to: if someone \
asks for a morning summary, an hourly check, or a nightly tidy-up, the answer is a routine, not \
\"I can't do that\". Say so, and propose the name, the instruction and the schedule you would use. \
The user creates and edits them from the clock icon at the top of this conversation, where each \
routine also has a Run now button. Two honest caveats worth passing on: routines only fire while \
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
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeInfo {
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
fn claude_info() -> ClaudeInfo {
    let Some(bin) = locate_claude() else {
        return ClaudeInfo { path: None, version: None };
    };
    let version = Command::new(&bin)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|out| out.trim().to_string());

    ClaudeInfo { path: Some(bin.display().to_string()), version }
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
    let _ = app.emit(
        "bot-event",
        BotEvent { bot_id: bot_id.to_string(), kind: kind.to_string(), text, detail },
    );
}

/* ----------------------------------------------------------------- one turn */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskRequest {
    bot_id: String,
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

#[tauri::command]
fn ask(app: AppHandle, running: tauri::State<Running>, req: AskRequest) -> Result<(), String> {
    if running.0.lock().unwrap().contains_key(&req.bot_id) {
        return Err("this bot is already working on something".into());
    }

    let bin = locate_claude()
        .ok_or("Claude Code CLI not found — install it, or point CLAUDE_BIN at the binary")?;
    let cwd = workspace(&app, &req.bot_id)?;
    ensure_memory(&cwd, &req.bot_name, &req.bot_role);

    // A running desktop earns the bot a second set of tools, pointed at that
    // bot's container. No desktop, no tools — nothing to explain away in the
    // prompt and nothing to fail at call time.
    // Permission first: a bot with no computer is never told it has one, so it
    // describes itself the same way whether or not a container happens to run.
    // Permission, not container state, decides this: a bot allowed a computer
    // is told it has one and can switch it on itself, so its account of what it
    // can do doesn't change with whether something happens to be running.
    let base = format!("{}\n\n{}", req.system_prompt, ROUTINES_PROMPT);
    let (mut allowed, mut system_prompt) = if req.computer {
        sandbox::touch(&req.bot_id);
        (format!("{TOOLS},{DESKTOP_TOOLS}"), format!("{base}\n\n{DESKTOP_PROMPT}"))
    } else {
        (TOOLS.to_string(), base)
    };

    // A bare `mcp__<server>` rule covers every tool that server offers, so a
    // connector gaining tools later needs no change here.
    for key in &req.plugins {
        allowed.push_str(&format!(",mcp__{key}"));
    }
    if !req.plugins.is_empty() {
        system_prompt.push_str(&format!("\n\n{}", plugins_prompt(&req.plugins)));
    }

    // The connector's tools cannot check out a repo or run a build, so a bot
    // with both a desktop and GitHub is told about the CLI that can.
    if req.computer && req.plugins.iter().any(|key| key == "github") {
        system_prompt.push_str(
            "\n\nOn your desktop, `gh` and `git` are installed and already signed in as the \
             user — clone, branch, commit, push and open pull requests there when a task needs \
             a working copy rather than a single file edit. Prefer your GitHub tools for \
             reading issues or files, which is cheaper than a checkout.",
        );
    }

    let mut cmd = Command::new(&bin);
    cmd.current_dir(&cwd)
        .arg("-p")
        .arg("--verbose")
        .args(["--output-format", "stream-json"])
        .arg("--include-partial-messages")
        .args(["--model", &req.model])
        .args(["--permission-mode", "acceptEdits"])
        .args(["--tools", TOOLS])
        .args(["--allowed-tools", &allowed])
        .args(["--append-system-prompt", &system_prompt])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut servers = serde_json::Map::new();

    if req.computer {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find my own binary: {e}"))?;
        servers.insert(
            "desktop".into(),
            serde_json::json!({
                "command": exe.display().to_string(),
                "args": ["--mcp"],
                "env": {
                    "BOTCAGE_BOT": req.bot_id,
                    "BOTCAGE_WORKSPACE": cwd.display().to_string(),
                    "BOTCAGE_BRAND": serde_json::to_string(&req.brand).unwrap_or_default(),
                }
            }),
        );
    }

    // Only the connectors this bot was granted, carrying the credential we hold
    // for them — so the grant decides reach, not whatever happens to be
    // configured on the machine.
    for key in &req.plugins {
        if let Some(entry) = connectors::server_entry(key, Some(&req.bot_id)) {
            servers.insert(key.clone(), entry);
        }
    }

    if !servers.is_empty() {
        let config = serde_json::json!({ "mcpServers": servers });
        cmd.args(["--mcp-config", &config.to_string()]);
    }

    // claude.ai connectors are account-wide: every bot granted one would reach
    // the user's own mail. botcage scopes per bot, so they stay off and our own
    // connectors take their place. Strict mode would also do this, but it
    // suppresses the servers installed marketplace plugins bring, which the
    // user does want.
    cmd.args(["--settings", "{\"disableClaudeAiConnectors\":true}"]);

    // Our own connectors reach this bot only through the config above, but an
    // installed marketplace plugin brings its servers to every session. Denying
    // the ones this bot was not granted is what keeps them apart.
    if !req.blocked_plugins.is_empty() {
        let denied = req
            .blocked_plugins
            .iter()
            .map(|key| format!("mcp__{key}"))
            .collect::<Vec<_>>()
            .join(",");
        cmd.args(["--disallowed-tools", &denied]);
    }

    if req.resume {
        cmd.args(["--resume", &req.session_id]);
    } else {
        cmd.args(["--session-id", &req.session_id]);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", bin.display()))?;

    // The prompt goes in on stdin; closing it is what tells claude to start.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(req.prompt.as_bytes())
            .map_err(|e| format!("could not send the prompt: {e}"))?;
    }

    let stdout = child.stdout.take().ok_or("no stdout on the claude process")?;
    let stderr = child.stderr.take().ok_or("no stderr on the claude process")?;

    running.0.lock().unwrap().insert(req.bot_id.clone(), child);

    let errors: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let drain = Arc::clone(&errors);
    std::thread::spawn(move || {
        let mut buf = String::new();
        let mut stderr = stderr;
        let _ = stderr.read_to_string(&mut buf);
        *drain.lock().unwrap() = buf;
    });

    let app_handle = app.clone();
    let bot_id = req.bot_id.clone();
    std::thread::spawn(move || {
        let mut final_text: Option<String> = None;
        let mut failure: Option<String> = None;
        let mut spend: Option<Value> = None;

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };

            match event["type"].as_str().unwrap_or_default() {
                "stream_event" => {
                    let inner = &event["event"];
                    if inner["type"] == "content_block_delta" {
                        let delta = &inner["delta"];
                        let kind = match delta["type"].as_str().unwrap_or_default() {
                            "text_delta" => "delta",
                            "thinking_delta" => "thinking",
                            _ => continue,
                        };
                        let text = delta["text"]
                            .as_str()
                            .or_else(|| delta["thinking"].as_str())
                            .unwrap_or_default();
                        emit(&app_handle, &bot_id, kind, Some(text.to_string()), None);
                    }
                }
                "assistant" => {
                    if let Some(blocks) = event["message"]["content"].as_array() {
                        for block in blocks {
                            if block["type"] == "tool_use" {
                                let name = block["name"].as_str().unwrap_or("a tool");
                                emit(&app_handle, &bot_id, "tool", Some(name.to_string()), None);
                            }
                        }
                    }
                }
                "rate_limit_event" => {
                    emit(&app_handle, &bot_id, "rate-limit", None, Some(event["rate_limit_info"].clone()));
                }
                "result" => {
                    if event["is_error"].as_bool().unwrap_or(false) {
                        failure = Some(
                            event["result"]
                                .as_str()
                                .unwrap_or("the turn ended with an error")
                                .to_string(),
                        );
                    } else {
                        final_text = event["result"].as_str().map(str::to_string);
                        spend = Some(serde_json::json!({
                            "costUsd": event["total_cost_usd"],
                            "durationMs": event["duration_ms"],
                        }));
                    }
                }
                _ => {}
            }
        }

        // stdout is closed, so the process is finished or was killed.
        let status = app_handle
            .state::<Running>()
            .0
            .lock()
            .unwrap()
            .remove(&bot_id)
            .map(|mut child| child.wait());

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
                        "claude exited before finishing the reply".to_string()
                    } else {
                        tail
                    };
                    emit(&app_handle, &bot_id, "error", Some(message), None);
                }
            }
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

/// Forget a bot for good: kill any turn in flight, drop its Claude Code
/// transcript, and delete its workspace. The desktop is torn down separately by
/// `sandbox_destroy` so this stays usable when Docker isn't installed.
#[tauri::command]
fn forget_bot(app: AppHandle, running: tauri::State<Running>, bot_id: String) -> Result<(), String> {
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
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
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
            let _ = Command::new("/bin/launchctl").args(["unload", "-w"]).arg(&path).output();
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
        let _ = Command::new("/bin/launchctl").args(["load", "-w"]).arg(&path).output();
    }
    Ok(())
}

/// Whoever is logged in — the sidebar used to show a hardcoded name.
#[tauri::command]
fn user_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default()
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
    let path = workspace(&app, &bot_id).ok()?.join("teach").join(&slug).join("name.txt");
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
        .manage(Running::default())
        .manage(sandbox::Sandboxes::default())
        .invoke_handler(tauri::generate_handler![
            claude_info,
            ask,
            cancel,
            forget_bot,
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
        .setup(|_app| {
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
            }
        });
}
