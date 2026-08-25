//! Speaking MCP as a client, for engines that cannot.
//!
//! botcage has had an MCP *server* since the beginning — [`crate::mcp`], the
//! desktop handed to a bot. What it has never had is the other half. It did not
//! need one: Claude Code and Gemini both bring their own MCP client and their
//! own tool loop, so botcage's job was to name the servers and get out of the
//! way.
//!
//! A hosted model brings neither. `POST /chat/completions` returns a request to
//! call a function and stops; whoever asked has to execute it and ask again.
//! That is why a bot on [`crate::inference::OpenAiCompatible`] has had no tools
//! at all — not because the model cannot call one, but because nothing here
//! could answer when it did.
//!
//! So this is the missing half: start the servers a bot's connectors amount to,
//! ask what they can do, and call them. The connectors are unchanged. An OAuth
//! flow someone completed once should not have to be repeated because they
//! changed which model answers, and this module is what makes that true.
//!
//! Two things are worth knowing about the shape of it.
//!
//! The transport is separated from the process. [`Link`] speaks JSON-RPC over
//! any reader and writer, so the protocol can be tested with two pipes in
//! memory and no child at all — which matters, because a bug here looks like a
//! bot that mysteriously has no tools, and that is a bad thing to debug through
//! a subprocess.
//!
//! Every call has a deadline. A server that never answers must cost a turn one
//! tool, not the whole turn: the pipes a child process gives us cannot be read
//! with a timeout, so each connection has a thread that does nothing but read
//! lines into a channel, and the channel is what gets waited on.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use serde_json::{json, Value};

/// The version botcage's own server answers with. Naming the same one here
/// keeps the two halves of this codebase talking about the same protocol.
const PROTOCOL: &str = "2025-06-18";

/// How long a server gets to finish starting up and answer for itself.
const HANDSHAKE: Duration = Duration::from_secs(20);

/// How long one tool call gets. Generous, because a connector may be making a
/// network request of its own, but not unbounded: a turn that never ends looks
/// exactly like a bot that has hung.
const CALL: Duration = Duration::from_secs(120);

/// JSON-RPC over a pair of streams, with a deadline on every exchange.
///
/// Deliberately knows nothing about processes. The tests hand it pipes.
pub struct Link {
    out: Box<dyn Write + Send>,
    lines: Receiver<String>,
    next: i64,
    /// Answers that arrived before the question they belong to was asked, or
    /// while a different one was being waited on. Kept rather than dropped: a
    /// reply read and discarded is gone, and the request it belonged to would
    /// then wait out its whole deadline for something already delivered.
    stash: Vec<Value>,
}

impl Link {
    /// Take a reader and a writer and start pulling lines off the reader.
    ///
    /// The thread ends when the reader does, which is what happens when the
    /// child on the other end exits.
    pub fn open(input: Box<dyn BufRead + Send>, output: Box<dyn Write + Send>) -> Self {
        let (tx, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in input.lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    // Nobody is listening any more: the connection was dropped.
                    break;
                }
            }
        });
        Link {
            out: output,
            lines,
            next: 1,
            stash: Vec::new(),
        }
    }

    /// Tell the server something without expecting an answer.
    fn notify(&mut self, method: &str) -> Result<(), String> {
        let frame = json!({ "jsonrpc": "2.0", "method": method });
        writeln!(self.out, "{frame}").map_err(|e| format!("could not write to the server: {e}"))?;
        self.out
            .flush()
            .map_err(|e| format!("could not write to the server: {e}"))
    }

    /// Ask, and wait for the answer to this particular question.
    ///
    /// Frames that are not the reply — notifications, progress, an id we never
    /// sent — are skipped rather than treated as an error. So is anything that
    /// is not JSON: servers are told to keep stdout for protocol traffic, and
    /// some of them print anyway. Being tolerant of that is the difference
    /// between a connector that works and one that does not.
    fn request(&mut self, method: &str, params: Value, wait: Duration) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;

        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        writeln!(self.out, "{frame}").map_err(|e| format!("could not write to the server: {e}"))?;
        self.out
            .flush()
            .map_err(|e| format!("could not write to the server: {e}"))?;

        // It may already be here, if it arrived while an earlier question was
        // being waited on.
        if let Some(at) = self.stash.iter().position(|f| f["id"].as_i64() == Some(id)) {
            return answer(self.stash.remove(at));
        }

        let deadline = std::time::Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return Err(format!("the server did not answer {method} in time"));
            }
            let line = match self.lines.recv_timeout(left) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(format!("the server did not answer {method} in time"))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(format!("the server stopped before answering {method}"))
                }
            };

            let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            match frame["id"].as_i64() {
                Some(other) if other == id => return answer(frame),
                // Somebody's answer, just not this question's. Keep it.
                Some(_) => self.stash.push(frame),
                // A notification. Nothing here waits on those.
                None => {}
            }
        }
    }
}

/// A reply, as a result or the server's own account of what went wrong.
fn answer(frame: Value) -> Result<Value, String> {
    if !frame["error"].is_null() {
        return Err(frame["error"]["message"]
            .as_str()
            .unwrap_or("the server refused the request")
            .to_string());
    }
    Ok(frame["result"].clone())
}

/// One tool, as the server describes it.
#[derive(Debug, Clone)]
pub struct Tool {
    /// What the server calls it.
    pub name: String,
    pub description: String,
    /// JSON Schema for the arguments, passed to the model untouched.
    pub schema: Value,
}

/// One running server.
pub struct Connection {
    link: Link,
    child: Option<std::process::Child>,
}

impl Connection {
    /// Start a server from the same config Claude Code would have been given.
    ///
    /// Reading the entry botcage already builds, rather than a second format,
    /// means a connector is configured once and works on every engine.
    pub fn start(config: &Value) -> Result<Self, String> {
        let command = config["command"]
            .as_str()
            .ok_or("this connector has no command to run")?;

        let mut cmd = std::process::Command::new(command);
        if let Some(args) = config["args"].as_array() {
            for arg in args.iter().filter_map(|a| a.as_str()) {
                cmd.arg(arg);
            }
        }
        if let Some(env) = config["env"].as_object() {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    cmd.env(key, value);
                }
            }
        }

        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Its diagnostics are its own business, and a full pipe nobody
            // reads is a server that blocks forever.
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {command}: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin on the server")?;
        let stdout = child.stdout.take().ok_or("no stdout on the server")?;

        Ok(Connection {
            link: Link::open(Box::new(BufReader::new(stdout)), Box::new(stdin)),
            child: Some(child),
        })
    }

    /// The opening exchange every MCP server expects before anything else.
    pub fn initialize(&mut self) -> Result<(), String> {
        self.link.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL,
                "capabilities": {},
                "clientInfo": { "name": "botcage", "version": env!("CARGO_PKG_VERSION") },
            }),
            HANDSHAKE,
        )?;
        // Required by the specification, and some servers will answer nothing
        // else until they have seen it.
        self.link.notify("notifications/initialized")
    }

    /// Everything this server can do.
    ///
    /// Paged, because a server with many tools is entitled to hand them over a
    /// few at a time and a client that ignores the cursor silently loses the
    /// rest.
    pub fn tools(&mut self) -> Result<Vec<Tool>, String> {
        let mut found = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(at) => json!({ "cursor": at }),
                None => json!({}),
            };
            let result = self.link.request("tools/list", params, HANDSHAKE)?;
            for tool in result["tools"].as_array().unwrap_or(&Vec::new()) {
                let Some(name) = tool["name"].as_str() else {
                    continue;
                };
                found.push(Tool {
                    name: name.to_string(),
                    description: tool["description"].as_str().unwrap_or_default().to_string(),
                    schema: match &tool["inputSchema"] {
                        Value::Object(_) => tool["inputSchema"].clone(),
                        // A tool that takes nothing still needs a schema saying
                        // so, or the model is left to guess.
                        _ => json!({ "type": "object", "properties": {} }),
                    },
                });
            }
            match result["nextCursor"].as_str() {
                Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
                _ => return Ok(found),
            }
        }
    }

    /// Run one tool and render whatever came back as text.
    pub fn call(&mut self, tool: &str, arguments: &Value) -> Result<String, String> {
        let result = self.link.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
            CALL,
        )?;
        Ok(render(&result))
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Turn a tool result into the text a model will be shown.
///
/// A model reads one thing: text. Content it cannot read is named rather than
/// dropped, so "I got an image back" is a thing the bot can say instead of
/// appearing to have received nothing. An error is returned as text too — a
/// tool that failed is information the model can act on, and hiding it produces
/// a bot that quietly gives up.
fn render(result: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for item in result["content"].as_array().unwrap_or(&Vec::new()) {
        match item["type"].as_str() {
            Some("text") => parts.push(item["text"].as_str().unwrap_or_default().to_string()),
            Some(kind) => parts.push(format!("[{kind} content, which cannot be shown here]")),
            None => {}
        }
    }
    // Some servers answer with structured content and no rendering of it.
    if parts.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            if !structured.is_null() {
                parts.push(structured.to_string());
            }
        }
    }
    let text = parts.join("\n");
    if result["isError"].as_bool() == Some(true) {
        return format!("the tool reported an error: {text}");
    }
    if text.is_empty() {
        return "(the tool returned nothing)".to_string();
    }
    text
}

/// Every server one bot's connectors amount to, and the tools they add up to.
///
/// Started for a turn and killed when it ends. That costs a process launch per
/// turn, which is worth it for the thing it buys: no lifecycle to get wrong, no
/// server left running for a bot nobody is talking to, and no state carried
/// between two turns that were meant to be independent.
#[derive(Default)]
pub struct Bench {
    servers: HashMap<String, Connection>,
    /// Emitted name → (server, tool). Kept rather than parsed back out of the
    /// name, because the name given to the model has been sanitised and may
    /// have been truncated, and guessing which tool a mangled name meant is how
    /// a bot ends up calling the wrong one.
    routes: HashMap<String, (String, String)>,
    /// What the model is told it can call.
    definitions: Vec<Value>,
    /// Connectors that would not start, with the reason. Not fatal: a bot with
    /// one broken connector should still have the others.
    pub broken: Vec<(String, String)>,
}

/// Whether a bot is allowed this tool, by the list botcage already computes.
///
/// This is a permissions boundary, and on Claude Code it is enforced by the
/// engine: `--allowed-tools` is what stops a bot with no computer taking a
/// screenshot, even though the desktop server offers one to everybody. An
/// engine where botcage runs the loop has no such argument to pass, so the
/// enforcement has to happen here or not at all. Not at all would mean a bot's
/// reach quietly depended on which model it used.
///
/// A bare `mcp__<server>` permits everything that server offers, which is how
/// the list is written for connectors — one entry, and a connector that gains a
/// tool later needs no change.
pub fn permitted(allowed: &str, name: &str) -> bool {
    allowed.split(',').map(str::trim).any(|rule| {
        if rule.is_empty() {
            return false;
        }
        if rule == name {
            return true;
        }
        // A prefix rule, and only on the boundary between parts: mcp__github
        // covers mcp__github__create_issue and must not cover a server called
        // mcp__github_enterprise.
        name.starts_with(rule) && name[rule.len()..].starts_with("__")
    })
}

impl Bench {
    /// Start everything in the config botcage already builds for an engine, and
    /// offer only what this bot is allowed.
    ///
    /// Never fails as a whole. A connector that will not start is recorded and
    /// skipped, because the alternative — one bad server costing a bot every
    /// tool it has — is worse than the thing it was protecting against.
    pub fn open(config: &Value, allowed: &str) -> Self {
        let mut bench = Bench::default();
        let Some(servers) = config.as_object() else {
            return bench;
        };

        for (name, entry) in servers {
            match Connection::start(entry).and_then(|mut server| {
                server.initialize()?;
                let tools = server.tools()?;
                Ok((server, tools))
            }) {
                Ok((server, tools)) => {
                    for tool in tools {
                        let called = bench.name_for(name, &tool.name);
                        if !permitted(allowed, &called) {
                            // Offered by the server, not granted to this bot.
                            // Dropped here rather than refused at call time: a
                            // model told about a tool it may not use will spend
                            // the turn trying.
                            bench.routes.remove(&called);
                            continue;
                        }
                        bench.definitions.push(json!({
                            "type": "function",
                            "function": {
                                "name": called,
                                "description": tool.description,
                                "parameters": tool.schema,
                            }
                        }));
                    }
                    bench.servers.insert(name.clone(), server);
                }
                Err(why) => bench.broken.push((name.clone(), why)),
            }
        }
        bench
    }

    /// What to call a tool when talking to the model.
    ///
    /// Spelled the way Claude Code spells it — `mcp__server__tool` — so that
    /// the allowed and denied lists botcage already computes mean the same
    /// thing on every engine. A bot's permissions should not change because the
    /// thing answering for it did.
    ///
    /// Function names are limited to 64 characters of a restricted alphabet, so
    /// this may sanitise and truncate. A collision after truncation gets a
    /// numeric suffix: two tools that answer to the same name is a bot calling
    /// the wrong one, which is worse than an ugly name.
    fn name_for(&mut self, server: &str, tool: &str) -> String {
        let clean = |s: &str| -> String {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        };
        let full = format!("mcp__{}__{}", clean(server), clean(tool));
        let mut name: String = full.chars().take(64).collect();
        let mut n = 2;
        while self.routes.contains_key(&name) {
            let suffix = format!("_{n}");
            name = full
                .chars()
                .take(64 - suffix.len())
                .collect::<String>()
                .to_string()
                + &suffix;
            n += 1;
        }
        self.routes
            .insert(name.clone(), (server.to_string(), tool.to_string()));
        name
    }

    /// The tools, in the shape a chat-completions request wants them.
    pub fn definitions(&self) -> &[Value] {
        &self.definitions
    }

    /// Run a tool the model asked for, by the name the model was given.
    ///
    /// Returns text either way. A model that asked for something impossible
    /// needs to be told so in the one channel it can read; returning an error
    /// to the runner instead would end the turn over a recoverable mistake.
    pub fn call(&mut self, name: &str, arguments: &Value) -> String {
        let Some((server, tool)) = self.routes.get(name).cloned() else {
            return format!("there is no tool called {name}");
        };
        let Some(connection) = self.servers.get_mut(&server) else {
            return format!("the connector behind {name} is not running");
        };
        match connection.call(&tool, arguments) {
            Ok(text) => text,
            Err(why) => format!("the tool could not be run: {why}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::{Arc, Mutex};

    /// A writer the test can read back, so we can check what was sent.
    #[derive(Clone, Default)]
    struct Spy(Arc<Mutex<Vec<u8>>>);

    impl Write for Spy {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Spy {
        fn sent(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).expect("a frame"))
                .collect()
        }
    }

    fn link_over(replies: &str) -> (Link, Spy) {
        let spy = Spy::default();
        let link = Link::open(
            Box::new(Cursor::new(replies.to_string())),
            Box::new(spy.clone()),
        );
        (link, spy)
    }

    #[test]
    fn a_reply_is_matched_to_the_question_that_asked_it() {
        // Two answers, arriving in the wrong order, with a notification in the
        // middle. A client that assumes the next line is its answer gets this
        // wrong, and what it gets wrong is one tool's result appearing as
        // another's.
        let (mut link, spy) = link_over(
            r#"{"jsonrpc":"2.0","method":"notifications/progress","params":{}}
{"jsonrpc":"2.0","id":2,"result":{"second":true}}
{"jsonrpc":"2.0","id":1,"result":{"first":true}}
"#,
        );
        let first = link.request("one", json!({}), Duration::from_secs(2)).ok();
        let second = link.request("two", json!({}), Duration::from_secs(2)).ok();

        assert_eq!(first, Some(json!({ "first": true })));
        assert_eq!(second, Some(json!({ "second": true })));

        let sent = spy.sent();
        assert_eq!(sent[0]["method"], "one");
        assert_eq!(sent[0]["id"], 1);
        assert_eq!(sent[1]["id"], 2);
    }

    #[test]
    fn noise_on_the_wire_is_stepped_over() {
        // Servers are told to keep stdout for protocol traffic. Some of them
        // log there anyway, and a client that treats the first line as gospel
        // reports a broken connector for a server that is working.
        let (mut link, _) = link_over(
            "starting up...\nnot json either\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":1}}\n",
        );
        assert_eq!(
            link.request("hello", json!({}), Duration::from_secs(2)),
            Ok(json!({ "ok": 1 }))
        );
    }

    #[test]
    fn an_error_from_the_server_is_reported_in_its_own_words() {
        let (mut link, _) = link_over(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"no such repository"}}
"#,
        );
        assert_eq!(
            link.request("tools/call", json!({}), Duration::from_secs(2)),
            Err("no such repository".into())
        );
    }

    #[test]
    fn a_server_that_never_answers_costs_one_call_and_not_the_turn() {
        // The stream stays open and says nothing, which is the shape of a hung
        // server. The deadline is what stops a bot hanging with it.
        let (reader, _writer) = std::os::unix::net::UnixStream::pair().expect("a pair");
        let mut link = Link::open(
            Box::new(BufReader::new(reader)),
            Box::new(Vec::<u8>::new()) as Box<dyn Write + Send>,
        );
        let began = std::time::Instant::now();
        let answer = link.request("tools/list", json!({}), Duration::from_millis(150));
        assert!(answer.is_err(), "a silent server must not be waited on");
        assert!(began.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_result_becomes_something_a_model_can_read() {
        assert_eq!(
            render(&json!({ "content": [{ "type": "text", "text": "42 open" }] })),
            "42 open"
        );
        // Content a model cannot read is named rather than dropped: "I got an
        // image" is a thing a bot can say; silence is not.
        assert_eq!(
            render(&json!({ "content": [{ "type": "image", "data": "…" }] })),
            "[image content, which cannot be shown here]"
        );
        // A failure is text too. It is something the model can act on, and a
        // bot told nothing simply gives up.
        assert!(render(&json!({
            "content": [{ "type": "text", "text": "rate limited" }],
            "isError": true
        }))
        .contains("rate limited"));
        assert_eq!(
            render(&json!({ "content": [] })),
            "(the tool returned nothing)"
        );
    }

    #[test]
    fn tools_are_named_the_way_claude_code_names_them() {
        // The whole point: allowed_tools and denied_plugins are computed once,
        // in botcage's vocabulary, and mean the same thing whichever engine
        // ends up answering.
        let mut bench = Bench::default();
        assert_eq!(
            bench.name_for("github", "create_issue"),
            "mcp__github__create_issue"
        );
    }

    #[test]
    fn a_name_the_api_would_refuse_is_made_acceptable_without_becoming_ambiguous() {
        let mut bench = Bench::default();
        // Characters outside the allowed alphabet, and a name past the limit.
        let odd = bench.name_for("google.calendar", "list events");
        assert_eq!(odd, "mcp__google_calendar__list_events");

        let long = bench.name_for("server", &"t".repeat(120));
        assert!(long.len() <= 64);

        // Two tools truncated to the same thing must not answer to one name —
        // that is a bot calling the wrong tool, which is worse than an ugly
        // name.
        let again = bench.name_for("server", &"t".repeat(120));
        assert!(again.len() <= 64);
        assert_ne!(long, again);
    }

    /// The two halves of this codebase, talking to each other.
    ///
    /// Everything above tests the client against frames written by hand, which
    /// proves it reads what I think a server says. This proves it against a
    /// server: botcage's own, started from the same config an engine is handed.
    /// Ignored because it needs the binary built beside it, which is true after
    /// `cargo build` and not during `cargo test` on a clean checkout.
    #[test]
    #[ignore]
    fn a_real_server_can_be_started_asked_and_used() {
        let exe = std::env::current_exe()
            .expect("the test binary")
            .parent()
            .and_then(|p| p.parent())
            .expect("the target directory")
            .join("botcage");
        assert!(exe.exists(), "run `cargo build` first: {}", exe.display());

        let workspace = std::env::temp_dir().join("botcage-mcp-client-test");
        std::fs::create_dir_all(&workspace).expect("a workspace");

        // The entry botcage builds for every tool-carrying bot, verbatim.
        let config = json!({
            "command": exe.display().to_string(),
            "args": ["--mcp"],
            "env": {
                "BOTCAGE_BOT": "test",
                "BOTCAGE_COLLEAGUES": "",
                "BOTCAGE_WORKSPACE": workspace.display().to_string(),
                "BOTCAGE_BRAND": "{}",
            }
        });

        // Everything the desktop server offers, as a bot with a computer
        // would be granted it.
        let mut bench = Bench::open(&json!({ "desktop": config }), "mcp__desktop");
        assert!(bench.broken.is_empty(), "{:?}", bench.broken);
        assert!(
            !bench.definitions().is_empty(),
            "the server offered no tools"
        );

        // Named the way the rest of botcage names them, and shaped the way a
        // chat-completions request wants them.
        let names: Vec<&str> = bench
            .definitions()
            .iter()
            .filter_map(|d| d["function"]["name"].as_str())
            .collect();
        assert!(
            names.iter().all(|n| n.starts_with("mcp__desktop__")),
            "{names:?}"
        );
        assert!(bench
            .definitions()
            .iter()
            .all(|d| d["type"] == "function" && d["function"]["parameters"].is_object()));

        // And one actually runs. Which tool matters less than that the round
        // trip works: asked, executed, answered in text.
        let ran = names[0].to_string();
        let said = bench.call(&ran, &json!({}));
        assert!(!said.is_empty());
        assert!(
            !said.contains("no tool called") && !said.contains("is not running"),
            "{ran} → {said}"
        );
    }

    #[test]
    fn a_bot_is_offered_only_what_it_was_granted() {
        // The case that matters: the desktop server offers screenshot and exec
        // to everyone, and the allowed list is the only thing standing between
        // a bot with no computer and a bot driving one. On Claude Code that
        // list is an argument; here it has to be us.
        let without = "mcp__desktop__set_appearance,mcp__desktop__schedule";
        assert!(permitted(without, "mcp__desktop__set_appearance"));
        assert!(!permitted(without, "mcp__desktop__screenshot"));
        assert!(!permitted(without, "mcp__desktop__exec"));

        // A bare server rule covers everything it offers, which is how
        // connectors are written.
        assert!(permitted("Read,mcp__github", "mcp__github__create_issue"));

        // And only on a boundary: one connector's rule must not reach into
        // another whose name merely starts the same way.
        assert!(!permitted("mcp__github", "mcp__github_enterprise__deploy"));
        assert!(!permitted("", "mcp__github__anything"));
    }

    #[test]
    fn a_tool_nobody_has_is_answered_rather_than_thrown() {
        // A model that invents a tool name has made a recoverable mistake. It
        // needs to be told, in the one channel it can read.
        let mut bench = Bench::default();
        let said = bench.call("mcp__nowhere__nothing", &json!({}));
        assert!(said.contains("no tool called"), "{said}");
    }
}
