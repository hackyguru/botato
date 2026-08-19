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
/// Not built yet: the Claude Code runner still assembles its own command in
/// `lib.rs`. Moving it behind this is the next step, and this is the shape it
/// moves into — written down now so a second engine has something to implement
/// against rather than a shape inferred from the first one.
#[allow(dead_code)]
///
/// Deliberately not a command line: what an engine is *given* is a prompt, who
/// the bot is, what it may use and where it works. How that becomes a process,
/// a request, or a local inference loop is the engine's business.
pub struct Turn {
    pub bot_id: String,
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
}

/// What botcage understands, whatever produced it.
///
/// The desktop's runner still emits these as loose strings; this is the same
/// vocabulary, typed, ready for the move.
#[allow(dead_code)]
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

        let mut cmd = std::process::Command::new(&bin);
        cmd.current_dir(&turn.cwd)
            .args(["--output-format", "stream-json"])
            .args(["--model", &turn.model])
            .args(["--prompt", &turn.prompt])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (var, value) in &turn.env {
            cmd.env(var, value);
        }

        // Written against the documented flags rather than a binary: the CLI is
        // not installed here, so this is the part to check first on a machine
        // that has it. Two things are known to be missing — a bot's system
        // prompt, which Gemini takes from a file rather than a flag, and its
        // MCP servers, which it reads from settings rather than an argument.
        // Both are why this engine is not yet offered in the picker.
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
            bot_id: "b1".into(),
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
        }
    }
}
