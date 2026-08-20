//! What answers for a bot.
//!
//! botcage drives the Claude Code CLI today, but nothing about a bot requires
//! that: a bot is a name, a role, a memory, a workspace, optionally a computer,
//! and something that turns a prompt into words. This module is the seam
//! between the last of those and the rest of the app, so a second engine —
//! another CLI, a hosted API, a model running on the machine — can be added
//! without the roster, the threads, the sandbox, the routines, the relay or the
//! phone knowing anything happened.
//!
//! Most of botcage is already indifferent. Everything downstream speaks
//! [`Event`], which is botcage's own vocabulary rather than any one tool's
//! stream format, and has been since before there was a second engine to
//! consider.
//!
//! The hard part is not the command line. It is [`Engine::owns_transcript`]:
//! Claude Code keeps a conversation on disk and picks it up again with
//! `--resume`, so botcage has never had to remember one. An engine without
//! that — an API, a local model — needs botcage to hold the transcript and
//! replay it each turn. Declaring which kind an engine is, rather than assuming
//! the first kind, is what makes the second one possible.

use serde::Serialize;

/// One turn's work, in botcage's terms.
///
/// Deliberately not a command line: what an engine is *given* is a prompt, who
/// the bot is, what it may use and where it works. How that becomes a process,
/// a request, or a local inference loop is the engine's business.
pub struct Turn {
    /// The conversation this turn belongs to. An engine that owns its own
    /// transcript treats this as a handle to resume; one that does not uses it
    /// only to tell conversations apart.
    pub session_id: String,
    /// False on a bot's first turn, when there is nothing yet to continue.
    pub resume: bool,
    pub prompt: String,
    /// Who this bot is, and what it may do. Assembled by the caller, because it
    /// depends on the bot's plugins and whether it has a computer.
    pub system_prompt: String,
    pub model: String,
    /// The bot's own workspace, which is also where a transcript would live.
    pub cwd: std::path::PathBuf,
    /// Which tools this bot may use, as botcage decided. The engine names them
    /// in whatever way it takes; it does not choose them.
    pub allowed_tools: String,
    /// Plugins this bot may not use. Named by key: how a denial is spelled is
    /// the engine's convention, not botcage's.
    pub denied_plugins: Vec<String>,
    /// The MCP servers this bot's connectors amount to. Which servers is
    /// botcage's business; how they are handed over is the engine's.
    pub mcp_servers: serde_json::Value,
    /// Secrets a plugin needs in the environment.
    pub env: Vec<(String, String)>,
    /// What was said before this, oldest first.
    ///
    /// Empty for an engine that keeps its own conversation and is being asked
    /// to continue it — sending history to something that already has it would
    /// double every exchange. Filled for anything that cannot, which is what
    /// makes a bot on such an engine a bot rather than a series of strangers.
    pub history: Vec<crate::transcript::Entry>,
}

/// A prompt with the conversation in front of it, for an engine that cannot
/// resume one.
///
/// Plain prose rather than a chat array on purpose: this is going to a CLI that
/// takes a single string, and the shapes those accept differ. What every model
/// understands is a transcript that reads like one.
pub fn with_history(turn: &Turn) -> String {
    if turn.history.is_empty() {
        return turn.prompt.clone();
    }

    // A turn that failed still recorded the question, so a retry would find it
    // sitting at the end of the history and ask it twice — once as something
    // that already happened, once as the thing being asked. Drop it.
    let mut history = turn.history.as_slice();
    if let Some(last) = history.last() {
        if last.voice == crate::transcript::Voice::User && last.text == turn.prompt {
            history = &history[..history.len() - 1];
        }
    }
    if history.is_empty() {
        return turn.prompt.clone();
    }

    let mut out = String::from("Earlier in this conversation, oldest first:\n\n");
    for entry in history {
        let who = match entry.voice {
            crate::transcript::Voice::User => "User",
            // Addressed to the model, because it is the model's own past words.
            crate::transcript::Voice::Bot => "You",
        };
        out.push_str(&format!("{who}: {}\n\n", entry.text.trim()));
    }
    out.push_str("The user now says:\n\n");
    out.push_str(&turn.prompt);
    out
}

/// What botcage understands, whatever produced it.
///
/// The desktop, the phone and the relay all render these; an engine's own
/// stream format never reaches them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Event {
    /// A piece of the answer.
    Delta(String),
    /// The model is working before it speaks.
    Thinking(String),
    /// A tool is being used, by name.
    Tool(String),
    /// The turn finished.
    ///
    /// `text` is the whole answer as the engine finally rendered it, which is
    /// authoritative: deltas can be shed under load, and the app prefers this
    /// when it is longer. Cost and duration are optional because not every
    /// engine bills or counts.
    Done {
        text: Option<String>,
        cost_usd: Option<f64>,
        duration_ms: Option<u64>,
    },
    /// The engine is waiting on a usage limit. Every field is optional: an
    /// engine that has limits may still decline to explain them.
    RateLimit {
        status: Option<String>,
        kind: Option<String>,
        resets_at: Option<u64>,
    },
    Error(String),
}

/// Something that can answer for a bot.
pub trait Engine: Send + Sync {
    /// Stable identifier, stored per bot: "claude-code", and one day others.
    fn key(&self) -> &'static str;

    /// What to call it on screen.
    fn name(&self) -> &'static str;

    /// Is it usable right now — installed, signed in, reachable? Setup asks
    /// this to say what is missing rather than letting a turn fail.
    fn ready(&self) -> Ready;

    /// Does it keep the conversation itself?
    ///
    /// True for a CLI that resumes a session from disk. False for anything
    /// stateless, which means botcage must hold the transcript and send it
    /// each turn — the one difference that is not cosmetic.
    fn owns_transcript(&self) -> bool;

    /// The command that runs one turn.
    fn command(&self, turn: &Turn) -> Result<std::process::Command, String>;

    /// One line of that command's output, as botcage understands it. A line may
    /// carry nothing worth showing, so the answer is a list rather than an
    /// option.
    fn read_line(&self, line: &str) -> Vec<Event>;

    /// How this engine is given a bot's connectors.
    ///
    /// Not *whether*: the connectors belong to botcage — that is the whole
    /// reason claude.ai's were removed — and a bot's GitHub or Notion should
    /// work whatever answers for it.
    fn tools(&self) -> ToolDelivery;

    /// Which models it can be asked for, the one to default to first.
    ///
    /// Here rather than in the UI because "opus" means nothing to Gemini and a
    /// bot switched between the two must not keep asking for a model that does
    /// not exist. A short curated list, not a catalogue: an engine that can
    /// reach hundreds will need somewhere to search, and that is a different
    /// screen from a picker with two entries.
    fn models(&self) -> Vec<Model>;
}

/// One model an engine can be asked for.
#[derive(Debug, Clone, Serialize)]
pub struct Model {
    /// Exactly what goes on the command line.
    pub key: &'static str,
    pub name: &'static str,
    /// The one sentence that decides it for someone.
    pub hint: &'static str,
}

/// How a bot's connectors reach the model.
///
/// MCP is how botcage implements a connector, not something an engine has to
/// understand. An engine that speaks MCP is handed the servers directly,
/// because it already has a tool loop and doing it twice would only add
/// latency. Anything else gets the same connectors as ordinary function
/// definitions, with botcage running the loop: calling the MCP server, feeding
/// the result back, and going round again.
///
/// The difference is plumbing. The connectors are the same either way, which is
/// the point — an OAuth flow a person completed once should not have to be
/// repeated because they changed which model answers.
// Hosted and None arrive with the second engine; they are written down now
// because the shape of the first one is a bad guide to the rest.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolDelivery {
    /// The engine speaks MCP: hand it the servers and let it run its own loop.
    Native,
    /// botcage runs the loop and passes tools in whatever shape the engine
    /// takes. Everything that can call a function qualifies.
    Hosted,
    /// The model cannot call tools at all. A bot on such an engine is told so
    /// rather than being given a prompt that claims abilities it lacks.
    None,
}

/// Whether an engine can be used, and if not, what a person should do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub usable: bool,
    /// Shown when it is not: "not installed", "not signed in", "no API key".
    pub missing: Option<String>,
}

impl Ready {
    pub fn yes() -> Self {
        Ready {
            usable: true,
            missing: None,
        }
    }

    pub fn no(missing: impl Into<String>) -> Self {
        Ready {
            usable: false,
            missing: Some(missing.into()),
        }
    }
}

/// The Claude Code CLI: the engine botcage has always used.
///
/// It owns its transcripts, which is why botcage has never kept one, and it
/// brings its own tool loop and MCP support.
pub struct ClaudeCode;

impl Engine for ClaudeCode {
    /// The command that runs one turn.
    ///
    /// Every flag here is Claude Code's own vocabulary — what to call streaming
    /// output, how to name a denied tool, whether a conversation is continued
    /// by id — which is exactly why it belongs to the engine rather than to the
    /// runner that spawns it.
    fn command(&self, turn: &Turn) -> Result<std::process::Command, String> {
        let bin = crate::locate_claude()
            .ok_or("Claude Code CLI not found — install it, or point CLAUDE_BIN at the binary")?;

        let mut cmd = std::process::Command::new(&bin);
        cmd.current_dir(&turn.cwd)
            .arg("-p")
            .arg("--verbose")
            .args(["--output-format", "stream-json"])
            .arg("--include-partial-messages")
            .args(["--model", &turn.model])
            .args(["--permission-mode", "acceptEdits"])
            .args(["--tools", crate::TOOLS])
            .args(["--allowed-tools", &turn.allowed_tools])
            .args(["--append-system-prompt", &turn.system_prompt])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(servers) = turn.mcp_servers.as_object() {
            if !servers.is_empty() {
                let config = serde_json::json!({ "mcpServers": turn.mcp_servers });
                cmd.args(["--mcp-config", &config.to_string()]);
            }
        }

        // Not --strict-mcp-config, which would also suppress the servers an
        // installed marketplace plugin brings. Only claude.ai's own connectors
        // are turned off: botcage supplies its own, and a bot should reach the
        // account its user connected here rather than one connected elsewhere.
        cmd.args(["--settings", "{\"disableClaudeAiConnectors\":true}"]);

        // Scoping is subtraction: an installed plugin offers its servers to
        // every session, so a bot that may not use one has it denied by name.
        if !turn.denied_plugins.is_empty() {
            let denied = turn
                .denied_plugins
                .iter()
                .map(|key| format!("mcp__{key}"))
                .collect::<Vec<_>>()
                .join(",");
            cmd.args(["--disallowed-tools", &denied]);
        }

        for (var, value) in &turn.env {
            cmd.env(var, value);
        }

        if turn.resume {
            cmd.args(["--resume", &turn.session_id]);
        } else {
            cmd.args(["--session-id", &turn.session_id]);
        }

        Ok(cmd)
    }

    fn read_line(&self, line: &str) -> Vec<Event> {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            // A partial or malformed line loses that line, not the turn.
            return Vec::new();
        };

        match frame["type"].as_str().unwrap_or_default() {
            "stream_event" => {
                let inner = &frame["event"];
                if inner["type"] != "content_block_delta" {
                    return Vec::new();
                }
                let delta = &inner["delta"];
                let text = delta["text"]
                    .as_str()
                    .or_else(|| delta["thinking"].as_str())
                    .unwrap_or_default()
                    .to_string();
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => vec![Event::Delta(text)],
                    "thinking_delta" => vec![Event::Thinking(text)],
                    _ => Vec::new(),
                }
            }

            // A tool is announced in the assistant message that requests it,
            // which is what lets the app say what a bot is doing before the
            // result comes back.
            "assistant" => frame["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block["type"] == "tool_use")
                        .map(|block| {
                            Event::Tool(block["name"].as_str().unwrap_or("a tool").to_string())
                        })
                        .collect()
                })
                .unwrap_or_default(),

            "rate_limit_event" => {
                let info = &frame["rate_limit_info"];
                vec![Event::RateLimit {
                    status: info["status"].as_str().map(str::to_string),
                    kind: info["rateLimitType"].as_str().map(str::to_string),
                    resets_at: info["resetsAt"].as_u64(),
                }]
            }

            "result" => {
                if frame["is_error"].as_bool().unwrap_or(false) {
                    vec![Event::Error(
                        frame["result"]
                            .as_str()
                            .unwrap_or("the turn ended with an error")
                            .to_string(),
                    )]
                } else {
                    vec![Event::Done {
                        text: frame["result"].as_str().map(str::to_string),
                        cost_usd: frame["total_cost_usd"].as_f64(),
                        duration_ms: frame["duration_ms"].as_u64(),
                    }]
                }
            }

            _ => Vec::new(),
        }
    }

    fn key(&self) -> &'static str {
        "claude-code"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn ready(&self) -> Ready {
        let state = crate::setup::claude_state();
        match (state.path.is_some(), state.signed_in) {
            (false, _) => Ready::no("not installed"),
            (true, false) => Ready::no("installed, but not signed in"),
            (true, true) => Ready::yes(),
        }
    }

    fn owns_transcript(&self) -> bool {
        true
    }

    fn tools(&self) -> ToolDelivery {
        // It has its own MCP client and tool loop; botcage hands over the
        // servers and stays out of the way.
        ToolDelivery::Native
    }

    fn models(&self) -> Vec<Model> {
        vec![
            Model {
                key: "opus",
                name: "Opus",
                hint: "The most capable, and the hungriest.",
            },
            Model {
                key: "sonnet",
                name: "Sonnet",
                hint: "Easier on your usage limits.",
            },
        ]
    }
}

/// One line of a Claude Code stream, as botcage understands it.
/// Google's Gemini CLI.
///
/// The second engine, and chosen deliberately as the awkward one: it streams
/// newline-delimited events like Claude Code and speaks MCP, but it does not
/// resume a conversation from a session id in headless mode. That makes it the
/// first engine botcage has to remember a transcript for — which is exactly the
/// assumption worth breaking early, while there are two engines rather than
/// five.
pub struct GeminiCli;

/// Where the Gemini CLI installs itself. Same shape as the Claude Code search:
/// an app launched from Finder inherits almost no PATH, so known locations are
/// tried before whatever PATH happens to hold.
pub fn locate_gemini() -> Option<std::path::PathBuf> {
    if let Some(raw) = std::env::var_os("GEMINI_BIN") {
        let explicit = std::path::PathBuf::from(raw);
        if explicit.is_file() {
            return Some(explicit);
        }
    }

    let mut candidates = vec![
        crate::home().join(".local/bin/gemini"),
        crate::home().join(".npm-global/bin/gemini"),
        std::path::PathBuf::from("/opt/homebrew/bin/gemini"),
        std::path::PathBuf::from("/usr/local/bin/gemini"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join("gemini")));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// The file Gemini reads in place of a system-prompt flag.
///
/// Rewritten every turn and labelled as ours, because the bot can see it and
/// will otherwise mistake it for something worth maintaining. Its own notes go
/// in MEMORY.md, which botcage never overwrites.
fn write_instructions(cwd: &std::path::Path, system_prompt: &str) -> Result<(), String> {
    let body = format!(
        "<!-- Written by botcage before every turn, and replaced each time. \
         Your own notes belong in MEMORY.md. -->\n\n{system_prompt}\n"
    );
    std::fs::write(cwd.join("GEMINI.md"), body)
        .map_err(|e| format!("could not write this bot's instructions: {e}"))
}

/// The bot's connectors, where Gemini looks for them.
///
/// Merged rather than replaced: only `mcpServers` is botcage's to decide, and a
/// bot that edited its own settings for some other reason should keep what it
/// wrote. The key is always set, including to nothing — a revoked connector has
/// to actually disappear.
fn write_settings(cwd: &std::path::Path, servers: &serde_json::Value) -> Result<(), String> {
    let dir = cwd.join(".gemini");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let file = dir.join("settings.json");
    let mut settings = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    settings["mcpServers"] = servers.clone();

    std::fs::write(
        &file,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("could not write this bot's connectors: {e}"))
}

impl Engine for GeminiCli {
    fn key(&self) -> &'static str {
        "gemini-cli"
    }

    fn name(&self) -> &'static str {
        "Gemini CLI"
    }

    fn ready(&self) -> Ready {
        match locate_gemini() {
            None => Ready::no("not installed — npm install -g @google/gemini-cli"),
            Some(_) => Ready::yes(),
        }
    }

    fn command(&self, turn: &Turn) -> Result<std::process::Command, String> {
        let bin =
            locate_gemini().ok_or("Gemini CLI not found — npm install -g @google/gemini-cli")?;

        // Two things Claude Code takes as arguments, Gemini reads from the
        // working directory. Writing them is therefore part of building the
        // command, and both are rewritten every turn: a bot whose connectors
        // were revoked, or whose role was edited, must not be answered by
        // yesterday's file.
        write_instructions(&turn.cwd, &turn.system_prompt)?;
        write_settings(&turn.cwd, &turn.mcp_servers)?;

        let mut cmd = std::process::Command::new(&bin);
        cmd.current_dir(&turn.cwd)
            .args(["--output-format", "stream-json"])
            .args(["--model", &turn.model])
            // Nothing is watching to answer a prompt, so a turn that stops to
            // ask permission is a turn that hangs. Edits go through; this is
            // the same bargain the Claude Code runner strikes with
            // `--permission-mode acceptEdits`.
            .args(["--approval-mode", "auto_edit"])
            // The conversation, because there is no session to resume.
            .args(["--prompt", &with_history(turn)])
            // Closed rather than piped, and that is how the runner knows the
            // prompt has already been delivered: an engine that wants it on
            // stdin asks for a pipe, and this one has taken it as an argument.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (var, value) in &turn.env {
            cmd.env(var, value);
        }

        // Nothing here denies a plugin by name, and that is not an omission:
        // botcage writes the settings file itself, so a bot is only offered the
        // servers it was granted. Claude Code has to be told what to subtract
        // because an installed plugin reaches every session; here the list is
        // built from nothing each turn, so `denied_plugins` has nothing to do.
        Ok(cmd)
    }

    fn read_line(&self, line: &str) -> Vec<Event> {
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };

        match frame["type"].as_str().unwrap_or_default() {
            // Assistant chunks are the reply arriving; anything the user said
            // is being echoed back and is already on screen.
            "message" => {
                if frame["role"].as_str() == Some("user") {
                    return Vec::new();
                }
                let text = frame["content"]
                    .as_str()
                    .or_else(|| frame["text"].as_str())
                    .unwrap_or_default();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![Event::Delta(text.to_string())]
                }
            }
            "tool_use" => vec![Event::Tool(
                frame["name"].as_str().unwrap_or("a tool").to_string(),
            )],
            "error" => vec![Event::Error(
                frame["message"]
                    .as_str()
                    .unwrap_or("the turn ended with an error")
                    .to_string(),
            )],
            "result" => vec![Event::Done {
                text: frame["response"]
                    .as_str()
                    .or_else(|| frame["result"].as_str())
                    .map(str::to_string),
                cost_usd: None,
                duration_ms: frame["stats"]["duration_ms"].as_u64(),
            }],
            // init announces the session, tool_result is the tool's own output:
            // neither is something to show.
            _ => Vec::new(),
        }
    }

    fn owns_transcript(&self) -> bool {
        // Headless runs take a prompt and stream a reply; there is no session to
        // resume. botcage keeps the conversation and sends it.
        false
    }

    fn tools(&self) -> ToolDelivery {
        // It has its own MCP client, so a bot's connectors are handed over as
        // servers rather than rebuilt as function definitions.
        ToolDelivery::Native
    }

    fn models(&self) -> Vec<Model> {
        vec![
            Model {
                key: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                hint: "The capable one, and the slower one.",
            },
            Model {
                key: "gemini-2.5-flash",
                name: "Gemini 2.5 Flash",
                hint: "Quick, and cheap enough to leave running.",
            },
        ]
    }
}

/// Every engine botcage knows about. A list rather than a constant, so adding
/// one is a line here and an implementation beside it.
pub fn all() -> Vec<Box<dyn Engine>> {
    vec![Box::new(ClaudeCode), Box::new(GeminiCli)]
}

/// The engine a bot asked for, or the default when it named none — every bot
/// created before this existed.
pub fn for_key(key: Option<&str>) -> Box<dyn Engine> {
    let wanted = key.unwrap_or(DEFAULT);
    all()
        .into_iter()
        .find(|engine| engine.key() == wanted)
        .unwrap_or_else(|| Box::new(ClaudeCode))
}

pub const DEFAULT: &str = "claude-code";

/// What each engine is and whether it can be used, for the settings screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub key: String,
    pub name: String,
    pub ready: Ready,
    pub owns_transcript: bool,
    pub tools: ToolDelivery,
    pub models: Vec<Model>,
}

#[tauri::command(async)]
pub fn engines() -> Vec<EngineInfo> {
    all()
        .into_iter()
        .map(|engine| EngineInfo {
            key: engine.key().to_string(),
            name: engine.name().to_string(),
            ready: engine.ready(),
            owns_transcript: engine.owns_transcript(),
            tools: engine.tools(),
            models: engine.models(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_without_an_engine_gets_the_default() {
        // Every bot made before engines existed has none recorded, and must
        // keep working exactly as it did.
        assert_eq!(for_key(None).key(), DEFAULT);
        assert_eq!(for_key(Some("claude-code")).key(), "claude-code");
        // An engine that was removed, or a state file from a newer build, must
        // not leave a bot with nothing to answer it.
        assert_eq!(for_key(Some("something-else")).key(), DEFAULT);
    }

    #[test]
    fn every_engine_can_carry_botcage_s_connectors() {
        // The connectors are botcage's own — a bot's GitHub should work
        // whatever answers for it — so an engine says how they reach the model,
        // not whether they may. Only a model that cannot call a function at all
        // is exempt.
        for engine in all() {
            assert_ne!(
                engine.tools(),
                ToolDelivery::None,
                "{} claims it cannot carry connectors",
                engine.name()
            );
        }
    }

    /// The reason for adding a second engine at all: to find out what botcage
    /// assumed. Claude Code keeps its own conversation; Gemini does not — and a
    /// turn runner written for the first would silently lose the thread on the
    /// second.
    #[test]
    fn engines_disagree_about_who_keeps_the_conversation() {
        let claude = for_key(Some("claude-code"));
        let gemini = for_key(Some("gemini-cli"));
        assert!(claude.owns_transcript());
        assert!(!gemini.owns_transcript());
        assert_ne!(
            claude.owns_transcript(),
            gemini.owns_transcript(),
            "if every engine agreed, the seam would not be earning anything"
        );
    }

    /// Against the shapes the CLI actually emits. This is the half of a turn
    /// that differs per engine, and the half that can be checked without
    /// running anything — so it is checked.
    #[test]
    fn a_claude_stream_becomes_botcage_events() {
        let claude = ClaudeCode;
        let read = |line: &str| claude.read_line(line);

        assert!(matches!(
            read(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Two PRs"}}}"#).as_slice(),
            [Event::Delta(text)] if text == "Two PRs"
        ));

        // Thinking arrives under its own key, not "text".
        assert!(matches!(
            read(r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"weighing it up"}}}"#).as_slice(),
            [Event::Thinking(text)] if text == "weighing it up"
        ));

        // A tool is announced when it is requested, which is what lets the app
        // say what a bot is doing before the result exists.
        assert!(matches!(
            read(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"one moment"},{"type":"tool_use","name":"Bash"}]}}"#).as_slice(),
            [Event::Tool(name)] if name == "Bash"
        ));

        assert!(matches!(
            read(r#"{"type":"result","is_error":false,"result":"done","total_cost_usd":0.0121,"duration_ms":8200}"#).as_slice(),
            [Event::Done { text: Some(text), cost_usd: Some(cost), duration_ms: Some(8200) }]
                if text == "done" && (cost - 0.0121).abs() < 1e-9
        ));

        // A failed turn is an error, not a completion with sad contents.
        assert!(matches!(
            read(r#"{"type":"result","is_error":true,"result":"the model refused"}"#).as_slice(),
            [Event::Error(why)] if why == "the model refused"
        ));

        assert!(matches!(
            read(r#"{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1750000000}}"#)
                .as_slice(),
            [Event::RateLimit {
                resets_at: Some(1750000000),
                ..
            }]
        ));

        // Frames botcage has nothing to say about, and a line cut in half by a
        // crash: both are silence rather than noise or a panic.
        assert!(read(r#"{"type":"system","subtype":"init"}"#).is_empty());
        assert!(read(r#"{"type":"stream_event","event":{"type":"message_start"}}"#).is_empty());
        assert!(read(r#"{"type":"resu"#).is_empty());
        assert!(read("").is_empty());
    }

    /// The command a turn runs, checked flag by flag.
    ///
    /// This moved out of the runner, and the failure mode of moving it is an
    /// argument quietly going missing — a bot that answers without its tools,
    /// or a conversation that starts again every message. None of that shows up
    /// as a crash, so it is asserted rather than eyeballed.
    #[test]
    fn a_turn_asks_for_everything_it_used_to() {
        let turn = Turn {
            session_id: "11111111-1111-4111-8111-111111111111".into(),
            resume: true,
            prompt: "morning".into(),
            system_prompt: "you are Engineer".into(),
            model: "opus".into(),
            cwd: std::env::temp_dir(),
            allowed_tools: "Read,Glob,mcp__github".into(),
            denied_plugins: vec!["notion".into()],
            mcp_servers: serde_json::json!({ "github": { "command": "x" } }),
            env: vec![("GITHUB_TOKEN".into(), "secret".into())],
            history: Vec::new(),
        };

        let Ok(cmd) = ClaudeCode.command(&turn) else {
            // No CLI on this machine; the flags cannot be inspected, and that
            // is a fact about the machine rather than a failure of the code.
            return;
        };
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let has = |flag: &str, value: &str| {
            args.windows(2)
                .any(|pair| pair[0] == flag && pair[1] == value)
        };

        assert!(args.iter().any(|a| a == "-p"), "not headless: {args:?}");
        assert!(has("--output-format", "stream-json"), "not streaming");
        assert!(
            args.iter().any(|a| a == "--include-partial-messages"),
            "no partial messages, so nothing would stream token by token"
        );
        assert!(has("--model", "opus"));
        assert!(has("--allowed-tools", "Read,Glob,mcp__github"));
        assert!(has("--append-system-prompt", "you are Engineer"));
        assert!(
            has("--disallowed-tools", "mcp__notion"),
            "a denied plugin must be denied by name, or scoping does nothing"
        );
        assert!(
            args.iter().any(|a| a.contains("disableClaudeAiConnectors")),
            "claude.ai's connectors must stay off — botcage supplies its own"
        );
        assert!(
            args.iter().any(|a| a.contains("mcpServers")),
            "the bot's connectors never reached it"
        );
        assert!(
            has("--resume", "11111111-1111-4111-8111-111111111111"),
            "a continuing conversation must resume, not start again"
        );
        assert_eq!(
            cmd.get_current_dir().map(|d| d.to_path_buf()),
            Some(std::env::temp_dir()),
            "a turn runs in the bot's own workspace"
        );
        assert!(
            cmd.get_envs()
                .any(|(k, v)| k == "GITHUB_TOKEN" && v == Some("secret".as_ref())),
            "a plugin's secret never reached the process"
        );

        // And a bot's first turn creates the session rather than resuming one
        // that does not exist — the difference that wedged a bot earlier today.
        let first = Turn {
            resume: false,
            ..turn
        };
        let cmd = ClaudeCode.command(&first).expect("command");
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.iter().any(|a| a == "--session-id"));
        assert!(!args.iter().any(|a| a == "--resume"));
    }

    /// Gemini's stream, mapped onto the same vocabulary.
    ///
    /// Written against documented event types rather than a binary — the CLI is
    /// not installed here — so this test is a statement of what botcage expects,
    /// and the first thing to run against a real one.
    #[test]
    fn a_gemini_stream_becomes_the_same_events() {
        let gemini = GeminiCli;
        let read = |line: &str| gemini.read_line(line);

        assert!(matches!(
            read(r#"{"type":"message","role":"assistant","content":"Two PRs"}"#).as_slice(),
            [Event::Delta(text)] if text == "Two PRs"
        ));

        // A user message echoed back is already on screen; showing it again
        // would duplicate what was just typed.
        assert!(read(r#"{"type":"message","role":"user","content":"morning"}"#).is_empty());

        assert!(matches!(
            read(r#"{"type":"tool_use","name":"read_file"}"#).as_slice(),
            [Event::Tool(name)] if name == "read_file"
        ));

        assert!(matches!(
            read(r#"{"type":"result","response":"done","stats":{"duration_ms":4100}}"#).as_slice(),
            [Event::Done { text: Some(text), cost_usd: None, duration_ms: Some(4100) }]
                if text == "done"
        ));

        assert!(matches!(
            read(r#"{"type":"error","message":"quota exhausted"}"#).as_slice(),
            [Event::Error(why)] if why == "quota exhausted"
        ));

        // Session metadata and a tool's own output are not things to show, and
        // a half-written line is silence rather than a panic.
        assert!(read(r#"{"type":"init","sessionId":"x"}"#).is_empty());
        assert!(read(r#"{"type":"tool_result","output":"…"}"#).is_empty());
        assert!(read(r#"{"type":"mess"#).is_empty());
    }

    fn entry(voice: crate::transcript::Voice, text: &str) -> crate::transcript::Entry {
        crate::transcript::Entry {
            voice,
            text: text.to_string(),
            at: 0,
        }
    }

    fn a_turn(cwd: std::path::PathBuf) -> Turn {
        Turn {
            session_id: "s1".into(),
            resume: false,
            prompt: "which ones?".into(),
            system_prompt: "You are Engineer, and you review pull requests.".into(),
            model: "gemini-2.5-pro".into(),
            cwd,
            allowed_tools: "Read,Glob".into(),
            denied_plugins: vec!["notion".into()],
            mcp_servers: serde_json::json!({ "github": { "command": "gh-mcp" } }),
            env: vec![],
            history: vec![],
        }
    }

    /// The whole point of keeping a transcript: a reply that follows from the
    /// one before it, on an engine that cannot remember either.
    #[test]
    fn a_conversation_reaches_an_engine_that_cannot_remember_one() {
        let mut turn = a_turn(std::env::temp_dir());

        // With nothing behind it, a prompt is sent exactly as typed — no
        // preamble explaining that there is no preamble.
        assert_eq!(with_history(&turn), "which ones?");

        turn.history = vec![
            entry(crate::transcript::Voice::User, "morning"),
            entry(
                crate::transcript::Voice::Bot,
                "morning — two PRs need review",
            ),
        ];
        let sent = with_history(&turn);
        assert!(sent.contains("morning — two PRs need review"));
        assert!(
            sent.ends_with("which ones?"),
            "the question being asked must come last: {sent}"
        );
        assert!(
            sent.find("morning").unwrap() < sent.find("which ones?").unwrap(),
            "oldest first, or the model reads the conversation backwards"
        );
        assert_eq!(
            sent.matches("which ones?").count(),
            1,
            "the new prompt must not also appear as history"
        );

        // A turn that failed recorded its question before it failed. Asking it
        // again must not read as though it had already been asked and answered.
        turn.history
            .push(entry(crate::transcript::Voice::User, "which ones?"));
        let retried = with_history(&turn);
        assert_eq!(
            retried.matches("which ones?").count(),
            1,
            "a retried question appears twice: {retried}"
        );
        assert!(retried.contains("two PRs need review"), "and loses nothing");

        // The same, on a bot whose only recorded turn is the one that failed:
        // nothing is left, so the prompt goes as typed.
        turn.history = vec![entry(crate::transcript::Voice::User, "which ones?")];
        assert_eq!(with_history(&turn), "which ones?");
    }

    /// What Claude Code takes as flags, Gemini reads from the working
    /// directory — so building its command writes files, and this is the part
    /// that can be checked without the binary.
    #[test]
    fn gemini_leaves_the_bot_s_instructions_and_connectors_where_it_looks() {
        let cwd = std::env::temp_dir().join("botcage-gemini-files");
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).expect("workspace");

        let mut turn = a_turn(cwd.clone());
        // A file the bot wrote itself, which botcage has no business dropping.
        std::fs::create_dir_all(cwd.join(".gemini")).unwrap();
        std::fs::write(
            cwd.join(".gemini/settings.json"),
            r#"{"theme":"Dracula","mcpServers":{"stale":{"command":"gone"}}}"#,
        )
        .unwrap();

        write_instructions(&cwd, &turn.system_prompt).expect("instructions");
        write_settings(&cwd, &turn.mcp_servers).expect("settings");

        let md = std::fs::read_to_string(cwd.join("GEMINI.md")).expect("GEMINI.md");
        assert!(
            md.contains("You are Engineer"),
            "a bot with no role is a different bot"
        );
        assert!(
            md.contains("botcage"),
            "the bot can see this file; it must say who owns it"
        );

        let settings: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cwd.join(".gemini/settings.json")).unwrap(),
        )
        .expect("settings are still valid JSON");
        assert!(
            settings["mcpServers"]["github"].is_object(),
            "the bot's connectors never reached it: {settings}"
        );
        assert!(
            settings["mcpServers"]["stale"].is_null(),
            "a connector that was revoked has to actually disappear"
        );
        assert_eq!(
            settings["theme"], "Dracula",
            "only mcpServers is botcage's to decide"
        );

        // And a bot granted nothing is offered nothing, rather than keeping
        // what it had last turn.
        turn.mcp_servers = serde_json::json!({});
        write_settings(&cwd, &turn.mcp_servers).expect("settings");
        let settings: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cwd.join(".gemini/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(settings["mcpServers"], serde_json::json!({}));
    }

    /// Which of the two ways an engine takes its prompt, declared by whether it
    /// asks for a pipe. The runner writes to stdin when there is one, so an
    /// engine that also took the prompt as an argument would be asked twice.
    #[test]
    fn an_engine_that_took_the_prompt_as_an_argument_is_not_told_it_twice() {
        let cwd = std::env::temp_dir().join("botcage-gemini-stdin");
        let _ = std::fs::remove_dir_all(&cwd);
        std::fs::create_dir_all(&cwd).expect("workspace");

        let Ok(cmd) = GeminiCli.command(&a_turn(cwd)) else {
            // No CLI here, which is a fact about the machine.
            return;
        };
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--prompt" && pair[1] == "which ones?"),
            "the prompt never reached the command: {args:?}"
        );
        assert!(
            args.windows(2)
                .any(|pair| pair[0] == "--output-format" && pair[1] == "stream-json"),
            "not streaming, so nothing would appear until the turn ended"
        );
        assert!(
            !args.iter().any(|a| a == "--resume"),
            "there is no session to resume; the conversation is in the prompt"
        );
    }

    #[test]
    fn the_registry_describes_itself() {
        let listed = engines();
        assert!(
            !listed.is_empty(),
            "botcage must know of at least one engine"
        );
        for engine in &listed {
            assert!(!engine.key.is_empty());
            assert!(!engine.name.is_empty());
            // Not usable is fine; not saying why is not.
            assert!(engine.ready.usable || engine.ready.missing.is_some());
            // An engine with no model to ask for cannot be picked, and a picker
            // that offers it is a picker that produces a broken bot.
            assert!(!engine.models.is_empty(), "{} offers no model", engine.name);
            for model in &engine.models {
                assert!(!model.key.is_empty() && !model.hint.is_empty());
            }
        }

        // No two engines may claim the same key: a bot stores one, and the
        // wrong match would answer as the wrong thing.
        let mut keys: Vec<&str> = listed.iter().map(|e| e.key.as_str()).collect();
        keys.sort_unstable();
        let count = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), count, "two engines share a key");
    }
}
