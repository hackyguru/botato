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

/// The face a bot may give itself, in the vocabulary the app draws.
///
/// Named here as well as in the UI because this is what a bot reads: the words
/// are the whole palette, and a tool that accepts anything would produce a bot
/// asking for a wizard hat and getting nothing.
const LOOKS: &[(&str, &[&str])] = &[
    (
        "head",
        &["circle", "squircle", "drop", "bean", "egg", "shield"],
    ),
    ("eyes", &["dot", "wide", "sleepy", "ring", "tall", "wink"]),
    (
        "brow",
        &["none", "flat", "angled", "raised", "thick", "quirk"],
    ),
    ("smile", &["soft", "wide", "curl", "flat", "open", "tiny"]),
    (
        "mark",
        // Things worn as well as things grown: asked for a cowboy hat, a bot
        // could only report that the menu had none, which was honest and
        // useless.
        &[
            "none", "antenna", "tuft", "cheeks", "band", "bolt", "cowboy", "cap", "bow", "halo",
        ],
    ),
];

/// The shapes a bot may compose when the wardrobe has nothing that fits.
///
/// Numbers and an enum, never markup: a model that can emit SVG into the app's
/// own chrome is a sanitiser to maintain forever, and one that can emit a
/// rectangle is a rectangle. Anything anyone asks for — a monocle, a scarf, a
/// crown — is three or four of these.
const SHAPES: &[&str] = &["ellipse", "rect", "ring", "triangle", "line"];

/// Colours a part may take. A bot's own colour and its ink are named rather
/// than spelled, so an invention still looks like it belongs to this app
/// rather than to whichever model drew it.
const FILLS: &[&str] = &["skin", "ink", "light", "dark"];

/// At most this many shapes in one mark. A hat is two; a face wearing nine is
/// not wearing anything, it is covered.
const MOST_PARTS: usize = 6;

fn number(
    value: &Value,
    name: &str,
    low: f64,
    high: f64,
    refused: &mut Vec<String>,
) -> Option<f64> {
    let Some(found) = value.as_f64() else {
        refused.push(format!("{name} must be a number"));
        return None;
    };
    if found < low || found > high {
        refused.push(format!(
            "{name} must be between {low} and {high}, not {found}"
        ));
        return None;
    }
    Some(found)
}

/// Check a bot's drawing, shape by shape, and say precisely what is wrong.
///
/// Precisely, because the reader is a model that will try again: "parts[1].w
/// must be between 1 and 200" is a fixable complaint and "invalid input" is
/// another round trip.
fn check_parts(parts: &Value) -> Result<Value, String> {
    let Some(list) = parts.as_array() else {
        return Err("parts must be a list of shapes".into());
    };
    if list.is_empty() {
        return Err("parts is empty — give at least one shape, or use a mark from the list".into());
    }
    if list.len() > MOST_PARTS {
        return Err(format!(
            "{} shapes is too many; {MOST_PARTS} is the most a face can carry",
            list.len()
        ));
    }

    let mut refused = Vec::new();
    let mut clean = Vec::new();
    for (at, part) in list.iter().enumerate() {
        let mut one = serde_json::Map::new();
        let where_ = format!("parts[{at}]");

        match part["shape"].as_str() {
            Some(shape) if SHAPES.contains(&shape) => {
                one.insert("shape".into(), Value::String(shape.into()));
            }
            other => refused.push(format!(
                "{where_}.shape is {:?}; pick one of: {}",
                other.unwrap_or("missing"),
                SHAPES.join(", ")
            )),
        }

        // Percentages of the face box, and outside it is allowed: a hat sits
        // above the head, which is what negative y is for.
        for (name, low, high) in [("x", -60.0, 160.0), ("y", -80.0, 160.0)] {
            if let Some(found) = number(
                &part[name],
                &format!("{where_}.{name}"),
                low,
                high,
                &mut refused,
            ) {
                one.insert(name.into(), Value::from(found));
            }
        }
        for name in ["w", "h"] {
            if let Some(found) = number(
                &part[name],
                &format!("{where_}.{name}"),
                1.0,
                200.0,
                &mut refused,
            ) {
                one.insert(name.into(), Value::from(found));
            }
        }
        for (name, low, high) in [("r", 0.0, 50.0), ("rot", -180.0, 180.0)] {
            if part.get(name).is_some() {
                if let Some(found) = number(
                    &part[name],
                    &format!("{where_}.{name}"),
                    low,
                    high,
                    &mut refused,
                ) {
                    one.insert(name.into(), Value::from(found));
                }
            }
        }

        let fill = part["fill"]
            .as_str()
            .unwrap_or("skin")
            .trim()
            .to_lowercase();
        let hex = fill.starts_with('#')
            && (fill.len() == 7 || fill.len() == 4)
            && fill[1..].chars().all(|c| c.is_ascii_hexdigit());
        if hex || FILLS.contains(&fill.as_str()) {
            one.insert("fill".into(), Value::String(fill));
        } else {
            refused.push(format!(
                "{where_}.fill is \"{fill}\"; use a hex value like #b07d4a, or one of: {}",
                FILLS.join(", ")
            ));
        }

        clean.push(Value::Object(one));
    }

    if refused.is_empty() {
        Ok(Value::Array(clean))
    } else {
        Err(refused.join("\n"))
    }
}

/// What a bot writes when it changes its own appearance.
///
/// A file rather than a call back into the app: this server is a separate
/// process, spawned per turn, and it already has the one thing it needs — the
/// bot's own workspace. The window picks it up when the turn ends. No socket,
/// no port, and nothing to be running for it to work.
fn set_look(bot: &Bot, args: &Value) -> Value {
    let mut chosen = serde_json::Map::new();
    let mut refused = Vec::new();

    for (trait_name, allowed) in LOOKS {
        let Some(want) = args[*trait_name].as_str() else {
            continue;
        };
        let want = want.trim().to_lowercase();
        if allowed.contains(&want.as_str()) {
            chosen.insert((*trait_name).to_string(), Value::String(want));
        } else {
            refused.push(format!(
                "{trait_name} cannot be \"{want}\" — pick one of: {}",
                allowed.join(", ")
            ));
        }
    }

    // A colour is anything the app can paint, so it is checked for shape
    // rather than membership.
    if let Some(colour) = args["colour"].as_str().or_else(|| args["color"].as_str()) {
        let colour = colour.trim();
        let ok = colour.starts_with('#')
            && (colour.len() == 7 || colour.len() == 4)
            && colour[1..].chars().all(|c| c.is_ascii_hexdigit());
        if ok {
            chosen.insert("colour".into(), Value::String(colour.to_string()));
        } else {
            refused.push(format!(
                "colour must be a hex value like #30d158, not \"{colour}\""
            ));
        }
    }

    // A drawing of its own, when nothing in the wardrobe fits.
    if let Some(parts) = args.get("parts").filter(|p| !p.is_null()) {
        match check_parts(parts) {
            Err(why) => return text_result(why, true),
            Ok(clean) => {
                chosen.insert("mark".into(), Value::String("custom".into()));
                chosen.insert("parts".into(), clean);
            }
        }
    }

    if !refused.is_empty() {
        return text_result(refused.join("\n"), true);
    }
    if chosen.is_empty() {
        return text_result(
            "nothing to change — name at least one of head, eyes, brow, smile, mark or colour"
                .to_string(),
            true,
        );
    }

    let path = bot.workspace.join("face.json");
    match std::fs::write(&path, Value::Object(chosen.clone()).to_string()) {
        Err(e) => text_result(format!("could not write the new face: {e}"), true),
        Ok(()) => text_result(
            format!(
                "done — {}. It changes on screen when this turn ends.",
                chosen
                    .iter()
                    .map(|(k, v)| format!("{k} {}", v.as_str().unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            false,
        ),
    }
}

fn tool_specs(bot: &Bot) -> Value {
    let (w, h) = screen_of(bot);
    json!([
        {
            "name": "set_appearance",
            "description": format!(
                "Change how you look. You are drawn as a face in botcage: a head, eyes, brows, a                  resting smile, an optional mark, and a colour. Call this when the user asks you                  to change your appearance, or when you want to — you own your own face. Every                  field is optional; the ones you leave out stay as they are.\n\n                 head: {}\neyes: {}\nbrow: {}\nsmile: {}\nmark: {}\n                 colour: a hex value like #30d158.\n\n                 The smile is only how your mouth rests — your expression still follows what you                  are doing, so you will grin when a task lands whatever you set here. Nothing                  outside these words exists: pick the closest thing that does,                  say what you picked, and name what was not available rather than inventing it.                  Hats do exist — cowboy is a cowboy hat, cap is a peaked cap, and halo and bow                  are what they sound like. And if the list genuinely has nothing for what was                  asked, draw it yourself with `parts`: a few shapes will make a monocle, a                  scarf or a crown. Prefer the named marks when one fits — they are tuned to                  read at small sizes — and reach for shapes when none does.",
                LOOKS[0].1.join(", "), LOOKS[1].1.join(", "), LOOKS[2].1.join(", "),
                LOOKS[3].1.join(", "), LOOKS[4].1.join(", ")
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "head": { "type": "string" },
                    "eyes": { "type": "string" },
                    "brow": { "type": "string" },
                    "smile": { "type": "string" },
                    "mark": { "type": "string" },
                    "colour": { "type": "string" },
                    "parts": {
                        "type": "array",
                        "description":
                            "Draw something the mark list has not got — a monocle, a scarf, a \
                             crown. Up to six shapes, and giving this sets your mark to your own \
                             drawing.\n\n\
                             Coordinates are percentages of your face, and x and y are the \
                             centre of the shape: 0,0 is your top-left corner, 50,50 is the \
                             middle of your face, 100,100 is bottom-right. Negative y is above \
                             your head, which is where a hat goes. w and h are percentages of \
                             your face too, so w:100 is exactly as wide as you are.\n\n\
                             shape: ellipse, rect, ring, triangle or line. r rounds a rect's \
                             corners (0-50). rot turns a shape in degrees. fill takes a hex \
                             value, or skin (your own colour), ink (your features), light or \
                             dark.\n\n\
                             A cowboy hat is two shapes: an ellipse at x50 y-4 w100 h15 for the \
                             brim, and a rect at x50 y-19 w46 h27 r40 for the crown, both in a \
                             leather colour. Build outward from that: the brim goes behind the \
                             crown because it is listed first, and things listed later are drawn \
                             on top.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "shape": { "type": "string" },
                                "x": { "type": "number" },
                                "y": { "type": "number" },
                                "w": { "type": "number" },
                                "h": { "type": "number" },
                                "r": { "type": "number" },
                                "rot": { "type": "number" },
                                "fill": { "type": "string" }
                            },
                            "required": ["shape", "x", "y", "w", "h"]
                        }
                    }
                }
            }
        },
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

    // Answered before the desktop is consulted: a bot's face is its own, and
    // has nothing to do with whether it has a computer.
    if name == "set_appearance" {
        return set_look(bot, &params["arguments"]);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn a_bot(name: &str) -> Bot {
        let dir = std::env::temp_dir().join(format!("botcage-face-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace");
        Bot {
            id: "b1".into(),
            workspace: dir,
            brand: Default::default(),
        }
    }

    /// A bot asked for a hat is the case this tool exists to handle well: it
    /// cannot have one, and the answer has to say so rather than fail silently
    /// or write a face nobody can draw.
    #[test]
    fn a_look_outside_the_vocabulary_is_refused_by_name() {
        let bot = a_bot("refuse");
        let said = set_look(&bot, &json!({ "mark": "hat" }));

        assert_eq!(said["isError"], true);
        let text = said["content"][0]["text"].as_str().unwrap_or_default();
        assert!(
            text.contains("hat"),
            "the refusal must name what was asked for"
        );
        assert!(
            text.contains("antenna"),
            "and list what is available instead: {text}"
        );
        assert!(
            !bot.workspace.join("face.json").exists(),
            "nothing may be written when nothing was valid"
        );
    }

    #[test]
    fn a_face_a_bot_can_have_is_written_for_the_window_to_pick_up() {
        let bot = a_bot("accept");
        let said = set_look(
            &bot,
            &json!({ "head": "bean", "mark": "antenna", "colour": "#30d158" }),
        );
        assert_ne!(said["isError"], true, "{said}");

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(bot.workspace.join("face.json")).unwrap(),
        )
        .expect("valid json");
        assert_eq!(written["head"], "bean");
        assert_eq!(written["mark"], "antenna");
        assert_eq!(written["colour"], "#30d158");
        assert!(
            written.get("eyes").is_none(),
            "a trait not mentioned must be left alone rather than reset"
        );
    }

    #[test]
    fn a_colour_has_to_be_one() {
        let bot = a_bot("colour");
        assert_eq!(
            set_look(&bot, &json!({ "colour": "greenish" }))["isError"],
            true
        );
        assert_ne!(set_look(&bot, &json!({ "color": "#fff" }))["isError"], true);
    }

    #[test]
    fn asking_for_nothing_says_so() {
        let bot = a_bot("empty");
        assert_eq!(set_look(&bot, &json!({}))["isError"], true);
    }
}

#[cfg(test)]
mod drawing_tests {
    use super::*;

    /// The case the shape language exists for: something nobody put in the
    /// wardrobe, composed out of two rectangles and an ellipse.
    #[test]
    fn a_bot_can_draw_what_the_wardrobe_has_not_got() {
        let bot = {
            let dir = std::env::temp_dir().join("botcage-face-draw");
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Bot {
                id: "b1".into(),
                workspace: dir,
                brand: Default::default(),
            }
        };

        let said = set_look(
            &bot,
            &json!({ "parts": [
                { "shape": "ellipse", "x": 50, "y": -4,  "w": 100, "h": 15, "fill": "#b07d4a" },
                { "shape": "rect",    "x": 50, "y": -19, "w": 46,  "h": 27, "r": 40, "fill": "#b07d4a" }
            ]}),
        );
        assert_ne!(said["isError"], true, "{said}");

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(bot.workspace.join("face.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            written["mark"], "custom",
            "drawing something sets the mark to it"
        );
        assert_eq!(written["parts"].as_array().unwrap().len(), 2);
        assert_eq!(written["parts"][1]["r"], 40.0);
    }

    /// The reader of a refusal is a model that will try again, so it has to say
    /// which shape and which field — not "invalid input".
    #[test]
    fn a_bad_shape_is_refused_where_it_went_wrong() {
        let why = check_parts(&json!([
            { "shape": "ellipse", "x": 50, "y": 0, "w": 40, "h": 20 },
            { "shape": "hexagon", "x": 50, "y": 0, "w": 999, "h": 20, "fill": "puce" }
        ]))
        .unwrap_err();

        assert!(why.contains("parts[1].shape"), "{why}");
        assert!(
            why.contains("hexagon") && why.contains("ellipse"),
            "names what was asked and what exists: {why}"
        );
        assert!(
            why.contains("parts[1].w"),
            "and the out-of-range size: {why}"
        );
        assert!(why.contains("parts[1].fill"), "and the colour: {why}");
        assert!(
            !why.contains("parts[0]"),
            "but says nothing about the shape that was fine"
        );
    }

    #[test]
    fn a_face_cannot_be_covered_in_shapes() {
        let many: Vec<Value> = (0..7)
            .map(|_| json!({ "shape": "rect", "x": 50, "y": 50, "w": 10, "h": 10 }))
            .collect();
        assert!(check_parts(&Value::Array(many))
            .unwrap_err()
            .contains("too many"));
        assert!(check_parts(&json!([])).unwrap_err().contains("empty"));
    }

    /// Above the head is where a hat goes, so negative y has to be allowed —
    /// and somewhere far off the canvas must not be.
    #[test]
    fn a_shape_may_sit_above_the_head_but_not_in_the_next_county() {
        assert!(
            check_parts(&json!([{ "shape": "rect", "x": 50, "y": -30, "w": 40, "h": 20 }])).is_ok()
        );
        assert!(
            check_parts(&json!([{ "shape": "rect", "x": 50, "y": -400, "w": 40, "h": 20 }]))
                .is_err()
        );
    }
}
