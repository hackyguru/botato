//! The desktop, exposed to a bot's Claude Code session as an MCP server.
//!
//! Runs as `botcage --mcp <controlPort>`: the same binary the GUI lives in, so
//! there is no Node or Python runtime to depend on, on any platform. Speaks
//! newline-delimited JSON-RPC on stdin/stdout and forwards each tool call to the
//! container's control API on the loopback port it was given.
//!
//! Nothing may be written to stdout except protocol messages — diagnostics go
//! to stderr, which Claude Code captures separately.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::sandbox;

/// Everything the server needs to act for one bot, handed over as environment
/// variables by the app when it registers this server with Claude Code.
pub struct Bot {
    pub id: String,
    pub workspace: PathBuf,
    pub brand: sandbox::BotBrand,
}

/// Fallback when the bot was started without a size, matching the Dockerfile.
const SCREEN: (u32, u32) = (1440, 900);

/// What this bot's display actually measures: the tool descriptions quote it as
/// the coordinate space, so a stale number makes the bot click in the wrong place.
fn screen_of(bot: &Bot) -> (u32, u32) {
    let parsed = bot.brand.screen.as_deref().and_then(|size| {
        let (w, h) = size.split_once('x')?;
        Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
    });
    parsed.unwrap_or(SCREEN)
}

/* --------------------------------------------------------------- transport */

pub(crate) fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<(u16, Vec<u8>), String> {
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(3))
        .map_err(|e| format!("the desktop is not reachable on port {port}: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(240)));

    let payload = body.unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        payload.len()
    );
    stream
        .write_all(head.as_bytes())
        .map_err(|e| e.to_string())?;
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;

    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("malformed response from the desktop")?;
    let status = String::from_utf8_lossy(&raw[..split])
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);

    Ok((status, raw[split + 4..].to_vec()))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 0x3F) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/* ------------------------------------------------------------------- tools */

fn tool_specs(bot: &Bot) -> Value {
    let (w, h) = screen_of(bot);
    json!([
        {
            "name": "start_desktop",
            "description":
                "Switch on this bot's computer. The desktop is not always running — it stops when \
                 idle — and every other desktop tool needs it up, so call this first when a task \
                 needs the machine and the others report it is off. Takes a few seconds, and the \
                 user sees it happen. There is no matching stop: an idle desktop switches itself \
                 off.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "screenshot",
            "description": format!(
                "Look at the desktop. Returns a PNG of the whole screen at its native {w}x{h}, \
                 so pixel positions in the image are exactly the coordinates the click and move \
                 tools take. Take one before your first interaction with the GUI, and again after \
                 any action whose result you need to confirm — clicking and typing are blind \
                 otherwise. Optional `width` scales the image down to save tokens, but then you \
                 must scale coordinates back up yourself; leave it unset unless you are only \
                 reading text."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "width": { "type": "integer", "description": "Scale the image to this width in pixels. Omit for native size." }
                }
            }
        },
        {
            "name": "exec",
            "description":
                "Run a bash command on the desktop machine (Debian, unprivileged user `bot`, \
                 passwordless sudo available for apt). Prefer this over clicking whenever the task \
                 can be done from a shell: it is faster, cheaper, and far more reliable than \
                 driving the GUI, and it returns real output instead of pixels. Use it to install \
                 packages, move files, run scripts, or check what happened. Launch GUI apps with a \
                 trailing `&`, e.g. `browser https://example.com &`.\n\n\
                 Commands start in ~/work, which is the same directory as your own working \
                 directory on the app side — anything you leave there, the user can open on their \
                 own machine, and it is the right default for real output. ~/Desktop is only what \
                 shows on your screen, and the rest of the filesystem is yours alone. Returns exit \
                 code, stdout, and stderr.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "cmd": { "type": "string", "description": "The bash command line to run." },
                    "cwd": { "type": "string", "description": "Absolute directory to run in. Defaults to ~/work." },
                    "timeout": { "type": "integer", "description": "Seconds before the command is killed (default 120)." }
                },
                "required": ["cmd"]
            }
        },
        {
            "name": "replay",
            "description":
                "Repeat a demonstration the user recorded for you, exactly as they performed it — \
                 pass the slug, which is the folder name under teach/. This costs nothing and is \
                 deterministic, so prefer it over re-deriving clicks from screenshots when the job \
                 is to do the same thing again. Screenshot afterwards to confirm; if the screen has \
                 moved on since the recording, fall back to screenshot plus click with fresh \
                 coordinates.",
            "inputSchema": {
                "type": "object",
                "properties": { "slug": { "type": "string", "description": "Folder name under teach/." } },
                "required": ["slug"]
            }
        },
        {
            "name": "click",
            "description": format!(
                "Click at a point on the screen, in real screen pixels with the origin at the \
                 top-left of a {w}x{h} display. The pointer moves there first. Screenshot \
                 afterwards to see what happened."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "x": { "type": "integer" },
                    "y": { "type": "integer" },
                    "button": { "type": "string", "enum": ["left", "middle", "right"], "description": "Default left." },
                    "count": { "type": "integer", "description": "2 for a double-click. Default 1." }
                },
                "required": ["x", "y"]
            }
        },
        {
            "name": "move",
            "description": "Move the pointer without clicking — useful for hover menus and tooltips.",
            "inputSchema": {
                "type": "object",
                "properties": { "x": { "type": "integer" }, "y": { "type": "integer" } },
                "required": ["x", "y"]
            }
        },
        {
            "name": "type",
            "description":
                "Type text into whatever currently has keyboard focus. This does not press Enter — \
                 send a separate `key` call with \"Return\" when you need it. Click the field first \
                 if focus is not already where you want it.",
            "inputSchema": {
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }
        },
        {
            "name": "key",
            "description":
                "Press a key or chord, named the way X does: \"Return\", \"Tab\", \"Escape\", \
                 \"BackSpace\", \"ctrl+l\", \"ctrl+shift+t\", \"alt+Tab\", \"super\". One press per call.",
            "inputSchema": {
                "type": "object",
                "properties": { "keys": { "type": "string" } },
                "required": ["keys"]
            }
        },
        {
            "name": "scroll",
            "description":
                "Scroll the mouse wheel where the pointer currently is. Positive scrolls up, \
                 negative scrolls down; the magnitude is wheel clicks.",
            "inputSchema": {
                "type": "object",
                "properties": { "amount": { "type": "integer" } },
                "required": ["amount"]
            }
        }
    ])
}

/// Re-issue a recorded demonstration's events. Deterministic, and free — the
/// model spends nothing beyond the one tool call.
fn replay(port: u16, workspace: Option<&PathBuf>, slug: &str) -> Value {
    let Some(root) = workspace else {
        return text_result("no workspace was passed to the desktop server".into(), true);
    };
    if slug.contains("..") || slug.contains('/') {
        return text_result(format!("not a demonstration slug: {slug}"), true);
    }

    let path = root.join("teach").join(slug).join("steps.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => return text_result(format!("cannot read {}: {err}", path.display()), true),
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            return text_result(format!("{} is not valid JSON: {err}", path.display()), true)
        }
    };
    let Some(events) = parsed["events"].as_array() else {
        return text_result("the demonstration has no events".into(), true);
    };

    let mut done = 0;
    for event in events {
        let (endpoint, body) = match event["t"].as_str().unwrap_or_default() {
            "click" => (
                "click",
                json!({ "x": event["x"], "y": event["y"], "button": event["button"] }),
            ),
            "move" => ("move", json!({ "x": event["x"], "y": event["y"] })),
            "key" => ("key", json!({ "keys": event["keys"] })),
            "type" => ("type", json!({ "text": event["text"] })),
            "scroll" => ("scroll", json!({ "amount": event["amount"] })),
            other => return text_result(format!("unknown event type: {other}"), true),
        };

        if let Err(err) = request(
            port,
            "POST",
            &format!("/{endpoint}"),
            Some(&body.to_string()),
        ) {
            return text_result(format!("replay stopped after {done} events: {err}"), true);
        }
        done += 1;

        // Give the desktop time to react — longer after a keypress likely to
        // navigate or submit.
        let settle = if event["keys"] == "Return" { 1400 } else { 350 };
        std::thread::sleep(Duration::from_millis(settle));
    }

    text_result(
        format!("replayed {done} recorded events from {slug}. Screenshot to confirm the result."),
        false,
    )
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn call_tool(bot: &Bot, params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    if name == "start_desktop" {
        let log = |_state: &str, _line: &str| {};
        return match sandbox::ensure_desktop(&bot.id, &bot.brand, &bot.workspace, None, &log) {
            Ok(_) => {
                sandbox::touch(&bot.id);
                text_result(
                    "the desktop is up. Screenshot it to see where things stand.".into(),
                    false,
                )
            }
            Err(err) => text_result(format!("could not start the desktop: {err}"), true),
        };
    }

    // Every other tool needs a running desktop; say so plainly rather than
    // failing with a connection error.
    let Some(port) = sandbox::control_port_for(&bot.id) else {
        return text_result(
            "the desktop is switched off — call start_desktop first, then retry.".into(),
            true,
        );
    };
    sandbox::touch(&bot.id);
    let workspace = Some(&bot.workspace);

    if name == "replay" {
        return replay(port, workspace, args["slug"].as_str().unwrap_or_default());
    }

    if name == "screenshot" {
        let path = match args["width"].as_u64() {
            Some(width) if width > 0 => format!("/screenshot?width={width}"),
            _ => "/screenshot".to_string(),
        };
        return match request(port, "GET", &path, None) {
            Err(err) => text_result(err, true),
            Ok((200, body)) => json!({
                "content": [{ "type": "image", "data": base64(&body), "mimeType": "image/png" }]
            }),
            Ok((status, body)) => text_result(
                format!(
                    "the desktop returned {status}: {}",
                    String::from_utf8_lossy(&body)
                ),
                true,
            ),
        };
    }

    let action = match name {
        "exec" | "click" | "move" | "type" | "key" | "scroll" => name,
        other => return text_result(format!("no such tool: {other}"), true),
    };

    match request(port, "POST", &format!("/{action}"), Some(&args.to_string())) {
        Err(err) => text_result(err, true),
        Ok((_, body)) => {
            let raw = String::from_utf8_lossy(&body).to_string();
            let parsed: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));

            if action == "exec" {
                let code = parsed["code"].as_i64().unwrap_or(-1);
                let out = parsed["stdout"].as_str().unwrap_or("");
                let err = parsed["stderr"].as_str().unwrap_or("");
                let mut report = format!("exit {code}");
                if !out.is_empty() {
                    report.push_str(&format!("\n\nstdout:\n{out}"));
                }
                if !err.is_empty() {
                    report.push_str(&format!("\n\nstderr:\n{err}"));
                }
                return text_result(report, code != 0);
            }

            let failed = parsed.get("ok").and_then(Value::as_bool) == Some(false);
            text_result(if failed { raw } else { "done".to_string() }, failed)
        }
    }
}

/* ------------------------------------------------------------------- server */

pub fn serve(bot: Bot) {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in BufReader::new(stdin.lock()).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message["method"].as_str().unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

        let outcome = match method {
            "initialize" => Some(json!({
                "protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "botcage-desktop", "version": env!("CARGO_PKG_VERSION") }
            })),
            "tools/list" => Some(json!({ "tools": tool_specs(&bot) })),
            "tools/call" => Some(call_tool(&bot, &params)),
            "ping" => Some(json!({})),
            _ => None,
        };

        // Requests carry an id and need a reply; notifications carry none.
        let Some(id) = id else { continue };
        let reply = match outcome {
            Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            None => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("unsupported method: {method}") }
            }),
        };

        if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}
