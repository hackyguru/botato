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
    /// The turn finished. Cost is optional because not every engine bills.
    Done {
        cost_usd: Option<f64>,
    },
    /// The engine is waiting on a usage limit, and when it resets.
    RateLimit {
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

/// Every engine botcage knows about. A list rather than a constant, so adding
/// one is a line here and an implementation beside it.
pub fn all() -> Vec<Box<dyn Engine>> {
    vec![Box::new(ClaudeCode)]
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
