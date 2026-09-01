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
    /// Who else is on this machine, by name. A bot cannot put work on a
    /// colleague's calendar without knowing the colleague exists, and names
    /// are what one bot calls another — ids are botcage's business.
    pub colleagues: Vec<String>,
    /// Whether this bot needs somewhere to read and write files.
    ///
    /// Only for an engine that has no file tools of its own. Claude Code and
    /// Gemini arrive with better ones, and offering a second, worse set would
    /// mean a bot choosing between them for no reason.
    pub files: bool,
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

/// The schedules a bot may set, in the vocabulary the calendar draws.
const EVERY: &[&str] = &["once", "week", "day", "weekday", "hour", "minutes"];

/// Work one bot puts on another's calendar — or its own.
///
/// The same handoff as a face: this server is a separate process that will
/// have exited before anything can be shown, so it writes what it wants and
/// the window applies it when the turn ends. The window resolves the name,
/// because the roster is its business and can change while a turn runs.
fn set_routine(bot: &Bot, args: &Value) -> Value {
    let name = args["name"].as_str().unwrap_or_default().trim();
    let instruction = args["instruction"].as_str().unwrap_or_default().trim();
    if name.is_empty() || instruction.is_empty() {
        return text_result(
            "a routine needs a name and an instruction — the instruction is what the bot will be \
             asked, in the words you would use yourself"
                .to_string(),
            true,
        );
    }

    let every = args["every"]
        .as_str()
        .unwrap_or("day")
        .trim()
        .to_lowercase();
    if !EVERY.contains(&every.as_str()) {
        return text_result(
            format!(
                "every must be one of: {}, not \"{every}\"",
                EVERY.join(", ")
            ),
            true,
        );
    }

    // Whose calendar. Absent means the bot's own, which is the commonest case
    // and the one that needs no permission from anybody.
    let whose = args["bot"].as_str().unwrap_or_default().trim();
    if !whose.is_empty()
        && !bot
            .colleagues
            .iter()
            .any(|other| other.eq_ignore_ascii_case(whose))
    {
        return text_result(
            format!(
                "there is no bot called \"{whose}\" on this machine. There is: {}",
                if bot.colleagues.is_empty() {
                    "nobody else".to_string()
                } else {
                    bot.colleagues.join(", ")
                }
            ),
            true,
        );
    }

    let at = args["at"].as_str().unwrap_or("09:00").trim().to_string();
    let mut wanted = serde_json::Map::new();
    wanted.insert("name".into(), Value::String(name.to_string()));
    wanted.insert("instruction".into(), Value::String(instruction.to_string()));
    wanted.insert("every".into(), Value::String(every.clone()));
    wanted.insert("at".into(), Value::String(at.clone()));
    if !whose.is_empty() {
        wanted.insert("bot".into(), Value::String(whose.to_string()));
    }
    for (key, low, high) in [("day", 0.0, 6.0), ("minutes", 1.0, 720.0)] {
        if let Some(found) = args[key].as_f64() {
            if found < low || found > high {
                return text_result(format!("{key} must be between {low} and {high}"), true);
            }
            wanted.insert(key.into(), Value::from(found));
        }
    }
    if let Some(date) = args["date"].as_str() {
        wanted.insert("date".into(), Value::String(date.trim().to_string()));
    }

    // Appended rather than written: a bot may set several in one turn, and a
    // second one must not silently replace the first.
    let path = bot.workspace.join("routines.jsonl");
    let line = format!("{}\n", Value::Object(wanted));
    let wrote = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));

    match wrote {
        Err(e) => text_result(format!("could not write the routine: {e}"), true),
        Ok(()) => text_result(
            format!(
                "scheduled \"{name}\" for {} — {}{}. It appears on the calendar when this turn \
                 ends, marked as added by you.",
                if whose.is_empty() { "yourself" } else { whose },
                match every.as_str() {
                    "minutes" => "every few minutes".to_string(),
                    "hour" => "every hour".to_string(),
                    "once" => format!("once at {at}"),
                    "week" => format!("weekly at {at}"),
                    "weekday" => format!("every weekday at {at}"),
                    _ => format!("every day at {at}"),
                },
                ""
            ),
            false,
        ),
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

/// The most a question can offer. Four is the point past which a row of
/// buttons stops being a glance and starts being a menu — and a bot with five
/// answers in mind is a bot that should be asking something narrower.
const MOST_OPTIONS: usize = 4;

/// How long one answer may be. A button is read sideways at a glance; anything
/// longer belongs in the question.
const LONGEST_OPTION: usize = 24;

/// Put a question to the user with its answers ready to press.
///
/// Written to a file and picked up when the turn ends, exactly as a new face
/// is: the process asking has exited by the time anybody sees the question, so
/// what it leaves behind is a note rather than a live prompt.
fn set_ask(bot: &Bot, args: &Value) -> Value {
    let question = args["question"].as_str().unwrap_or_default().trim();

    let Some(given) = args["options"].as_array() else {
        return text_result(
            "options must be a list of answers, like [\"Log it\", \"Skip\"]".to_string(),
            true,
        );
    };

    let mut options: Vec<String> = Vec::new();
    for one in given {
        let Some(text) = one.as_str() else {
            return text_result("every option must be a string".to_string(), true);
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > LONGEST_OPTION {
            return text_result(
                format!(
                    "\"{text}\" is too long for a button — {LONGEST_OPTION} characters at most. \
                     Put the detail in the question."
                ),
                true,
            );
        }
        // Two buttons reading the same thing is a choice that cannot be made.
        if options.iter().any(|had| had.eq_ignore_ascii_case(text)) {
            continue;
        }
        options.push(text.to_string());
    }

    if options.len() < 2 {
        return text_result(
            "a question needs at least two different answers — with one there is nothing to \
             choose. Just ask in your reply instead."
                .to_string(),
            true,
        );
    }
    if options.len() > MOST_OPTIONS {
        return text_result(
            format!(
                "{MOST_OPTIONS} answers at most, and you gave {}. Ask something narrower.",
                options.len()
            ),
            true,
        );
    }

    let asked = json!({ "question": question, "options": options });
    let path = bot.workspace.join("ask.json");
    match std::fs::write(&path, asked.to_string()) {
        Err(e) => text_result(format!("could not leave the question: {e}"), true),
        Ok(()) => text_result(
            format!(
                "asked — {} will be buttons under your reply when this turn ends. Whichever is \
                 pressed arrives as the user's next message.",
                options
                    .iter()
                    .map(|one| format!("\"{one}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            false,
        ),
    }
}

/// How many shortcuts a bot may offer. Past eight the list stops being a
/// menu of what this bot does and becomes a manual.
const MOST_COMMANDS: usize = 8;

/// Declare the shortcuts this bot answers to.
///
/// A slash command is a name for a job the bot does often, so that reaching
/// for it costs a word instead of a sentence — and, as much as that, so that
/// somebody who has never spoken to this bot can see what it is for by typing
/// one character.
fn set_commands(bot: &Bot, args: &Value) -> Value {
    let Some(given) = args["commands"].as_array() else {
        return text_result(
            "commands must be a list, each with a name and what it does".to_string(),
            true,
        );
    };
    if given.len() > MOST_COMMANDS {
        return text_result(
            format!(
                "{MOST_COMMANDS} at most, and you listed {}. Keep the ones somebody would reach \
                 for weekly.",
                given.len()
            ),
            true,
        );
    }

    let mut clean: Vec<Value> = Vec::new();
    for one in given {
        let name = one["name"].as_str().unwrap_or_default().trim().trim_start_matches('/');
        let what = one["what"].as_str().unwrap_or_default().trim();
        if name.is_empty() || what.is_empty() {
            return text_result(
                "every command needs a name and a line saying what it does".to_string(),
                true,
            );
        }
        // A handle, for the same reason a channel's name is one: it is typed
        // after a "/" and a space would end it.
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return text_result(
                format!(
                    "\"{name}\" cannot be a command name — letters, digits, - and _ only, and no \
                     spaces: it is typed after a slash."
                ),
                true,
            );
        }
        if name.chars().count() > 20 {
            return text_result(format!("\"{name}\" is too long — 20 characters at most"), true);
        }
        if clean
            .iter()
            .any(|had| had["name"].as_str().unwrap_or_default().eq_ignore_ascii_case(name))
        {
            continue;
        }
        clean.push(json!({ "name": name.to_lowercase(), "what": what }));
    }

    let path = bot.workspace.join("commands.json");
    // An empty list is a bot withdrawing its shortcuts, which is a thing it is
    // allowed to do — so the file is written either way rather than skipped.
    match std::fs::write(&path, Value::Array(clean.clone()).to_string()) {
        Err(e) => text_result(format!("could not write the commands: {e}"), true),
        Ok(()) if clean.is_empty() => {
            text_result("cleared — you offer no shortcuts now.".to_string(), false)
        }
        Ok(()) => text_result(
            format!(
                "done — typing \"/\" now offers {}. They appear when this turn ends.",
                clean
                    .iter()
                    .map(|one| format!("/{}", one["name"].as_str().unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            false,
        ),
    }
}

fn tool_specs(bot: &Bot) -> Value {
    let mut specs = base_specs(bot);
    // Added rather than built in, because most bots already have better ones.
    if bot.files {
        if let Some(list) = specs.as_array_mut() {
            list.extend(crate::files::specs());
        }
    }
    specs
}

fn base_specs(bot: &Bot) -> Value {
    let (w, h) = screen_of(bot);
    json!([
        {
            "name": "ask",
            "description":
                "Ask the user something and put the answers under your reply as buttons. \
                 Whichever they press arrives as their next message, in their own words, and \
                 you carry on from there.\n\n\
                 Use it whenever your reply ends in a question that has a small number of \
                 sensible answers — which is most of them. A routine that fires while nobody is \
                 at the machine is the clearest case: a question that needs a sentence typed \
                 back gets answered tomorrow, and one that needs a thumb gets answered now.\n\n\
                 Ask it in your reply as well, in your own voice. The buttons are a shortcut for \
                 the answer, not a substitute for the question — a bare row of words under a \
                 silent reply reads as a form.\n\n\
                 question: what you are asking, one line. Optional if your reply already says \
                 it plainly, which it usually should.\n\
                 options: two to four short answers, a couple of words each, in the order you \
                 would say them. Put the likeliest first.\n\n\
                 Not for open questions. \"What did you eat?\" has no buttons; \"Log it now, or \
                 tonight?\" does. If you cannot name the answers, just ask.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "What you are asking, one line.",
                    },
                    "options": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description":
                            "Two to four short answers, likeliest first. A couple of words each.",
                    },
                },
                "required": ["options"],
            },
        },
        {
            "name": "set_commands",
            "description":
                "Declare the shortcuts you answer to. Typing \"/\" in a conversation you are part \
                 of lists them, and picking one writes it into the message — so a job somebody \
                 asks you for weekly costs them a word instead of a sentence.\n\n\
                 The larger point is that somebody who has never spoken to you can see what you \
                 are for by typing one character. Name the things you actually do, in the words \
                 the user would use, not the ones you would.\n\n\
                 Set them when you are given a job or when the user asks what you can do, and \
                 revise them when the work changes. Sending the list replaces it; sending an \
                 empty list withdraws them.\n\n\
                 commands: up to eight, each a name and a line. name is typed after a slash — \
                 letters, digits, - and _, no spaces. what is one short line, shown beside it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "commands": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "what": { "type": "string" },
                            },
                            "required": ["name", "what"],
                        },
                    },
                },
                "required": ["commands"],
            },
        },
        {
            "name": "schedule",
            "description": format!(
                "Put standing work on a calendar — your own, or another bot's. A routine is an \
                 instruction that arrives in that bot's conversation on a schedule and is \
                 answered exactly as if the user had typed it.\n\n\
                 Use it when somebody asks for something recurring, and when you and another bot \
                 agree that they should be doing something regularly: you can schedule it for \
                 them rather than reminding them each time.\n\n\
                 bot: whose calendar. Leave it out for your own. On this machine: {}.\n\
                 name: what it is called, a few words.\n\
                 instruction: what that bot will be asked, written the way the user would write \
                 it — the bot receiving it sees only this.\n\
                 every: once, week, day, weekday, hour, or minutes.\n\
                 at: HH:MM, for all but the minutes kind.\n\
                 day: 0-6 with Sunday 0, for the weekly kind. date: YYYY-MM-DD, for once. \
                 minutes: the gap, for the minutes kind.\n\n\
                 It is added openly: the calendar shows you as the author, the user sees it \
                 appear, and they can delete it in one click. Scheduling something for somebody \
                 else is a thing to say you are doing, not a thing to slip in.",
                if bot.colleagues.is_empty() {
                    "there are no other bots yet".to_string()
                } else {
                    bot.colleagues.join(", ")
                }
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "bot": { "type": "string" },
                    "name": { "type": "string" },
                    "instruction": { "type": "string" },
                    "every": { "type": "string" },
                    "at": { "type": "string" },
                    "day": { "type": "number" },
                    "date": { "type": "string" },
                    "minutes": { "type": "number" }
                },
                "required": ["name", "instruction", "every"]
            }
        },
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
    if name == "schedule" {
        return set_routine(bot, &params["arguments"]);
    }
    // Also before the desktop: a question is for the person, and has nothing
    // to do with whether this bot has a machine switched on.
    if name == "ask" {
        return set_ask(bot, &params["arguments"]);
    }
    if name == "set_commands" {
        return set_commands(bot, &params["arguments"]);
    }

    // A bot's own folder, for an engine that cannot open a file itself. Before
    // the desktop too: these are the same directory the desktop mounts as
    // ~/work, and reading it does not require the machine to be switched on.
    if bot.files {
        if let Some(done) = crate::files::call(&bot.workspace, name, &params["arguments"]) {
            return match done {
                Ok(said) => text_result(said, false),
                Err(why) => text_result(why, true),
            };
        }
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
            colleagues: vec!["Ops".into(), "Research".into()],
            files: false,
        }
    }

    /// Which bots are handed a way into the filesystem, and which are not.
    ///
    /// Two failures live here and neither announces itself. Offering these to
    /// a Claude Code bot gives it a second, worse Read to choose between. Not
    /// offering them to a hosted bot leaves it unable to open its own notes,
    /// which is most of what a bot is for. So the flag is asserted from both
    /// sides.
    #[test]
    fn only_a_bot_without_file_tools_of_its_own_is_given_these() {
        let named = |bot: &Bot| -> Vec<String> {
            tool_specs(bot)
                .as_array()
                .expect("tools")
                .iter()
                .filter_map(|t| t["name"].as_str().map(str::to_string))
                .collect()
        };

        let mut bot = a_bot("gating");
        let without = named(&bot);
        assert!(without.contains(&"set_appearance".to_string()));
        assert!(
            !without.iter().any(|name| name == "read_file"),
            "an engine with its own Read must not be offered a second one: {without:?}"
        );

        bot.files = true;
        let with = named(&bot);
        for tool in ["read_file", "write_file", "list_files", "find_in_files"] {
            assert!(with.contains(&tool.to_string()), "{tool} missing: {with:?}");
        }
        // And it did not lose anything by gaining them.
        assert!(with.contains(&"set_appearance".to_string()));

        // The names the app grants must be the names the server answers to. If
        // these drift, a bot is granted tools that do not exist and offered
        // tools it is not allowed — in silence, both ways.
        for name in crate::files::NAMES.split(',') {
            let bare = name.trim_start_matches("mcp__desktop__");
            assert!(
                with.contains(&bare.to_string()),
                "{name} is granted but not served"
            );
        }
    }

    /// Asking for one is answered, and only for a bot that has them.
    #[test]
    fn a_file_tool_is_refused_to_a_bot_that_was_not_given_it() {
        let mut bot = a_bot("dispatch");
        std::fs::write(bot.workspace.join("notes.md"), "the deadline is Friday").expect("a note");

        bot.files = true;
        let said = call_tool(
            &bot,
            &json!({ "name": "read_file", "arguments": { "path": "notes.md" } }),
        );
        assert_ne!(said["isError"], true, "{said}");
        assert!(said["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Friday"));

        // Without the flag it is not this server's tool at all, and falls
        // through to the desktop, which has never heard of it either.
        bot.files = false;
        let refused = call_tool(
            &bot,
            &json!({ "name": "read_file", "arguments": { "path": "notes.md" } }),
        );
        assert_eq!(refused["isError"], true, "{refused}");
    }

    /// A row of buttons is only worth having if pressing one is a real choice,
    /// so the shapes that are not a choice are refused rather than drawn.
    #[test]
    fn a_question_needs_answers_worth_pressing() {
        let bot = a_bot("asking");

        // One answer is not a choice — there is nothing to decide.
        let one = set_ask(&bot, &json!({ "options": ["OK"] }));
        assert_eq!(one["isError"], true, "{one}");

        // Nor is the same answer twice, however it is capitalised.
        let same = set_ask(&bot, &json!({ "options": ["Log it", "log it"] }));
        assert_eq!(same["isError"], true, "{same}");

        // Past four a row of buttons is a menu.
        let many = set_ask(
            &bot,
            &json!({ "options": ["One", "Two", "Three", "Four", "Five"] }),
        );
        assert_eq!(many["isError"], true, "{many}");

        // A sentence is not a button; the detail belongs in the question.
        let essay = set_ask(
            &bot,
            &json!({ "options": ["Yes", "Log it now and also remind me tomorrow morning"] }),
        );
        assert_eq!(essay["isError"], true, "{essay}");

        assert!(
            !bot.workspace.join("ask.json").exists(),
            "nothing refused should have been written"
        );
    }

    /// What a good one leaves behind, which is what the window reads.
    #[test]
    fn a_question_is_left_where_the_window_looks() {
        let bot = a_bot("asked");
        let said = set_ask(
            &bot,
            &json!({ "question": "Log it now?", "options": ["Log it", "  ", "Skip"] }),
        );
        assert_ne!(said["isError"], true, "{said}");

        let left: Value =
            serde_json::from_str(&std::fs::read_to_string(bot.workspace.join("ask.json")).unwrap())
                .unwrap();
        assert_eq!(left["question"], "Log it now?");
        // The empty one is dropped rather than drawn as a nameless button.
        assert_eq!(left["options"], json!(["Log it", "Skip"]));
    }

    /// A command name is typed after a slash, so the shapes that could not be
    /// typed there are refused rather than written and never matched.
    #[test]
    fn a_command_name_has_to_be_typeable_after_a_slash() {
        let bot = a_bot("commanding");

        let spaced = set_commands(
            &bot,
            &json!({ "commands": [{ "name": "log meal", "what": "log a meal" }] }),
        );
        assert_eq!(spaced["isError"], true, "{spaced}");

        let empty = set_commands(&bot, &json!({ "commands": [{ "name": "log", "what": "" }] }));
        assert_eq!(empty["isError"], true, "{empty}");

        let many: Vec<Value> = (0..9)
            .map(|n| json!({ "name": format!("c{n}"), "what": "something" }))
            .collect();
        let crowded = set_commands(&bot, &json!({ "commands": many }));
        assert_eq!(crowded["isError"], true, "{crowded}");

        assert!(
            !bot.workspace.join("commands.json").exists(),
            "nothing refused should have been written"
        );
    }

    /// What a good list leaves behind, including the two normalisations the
    /// window relies on: no leading slash, and lower case.
    #[test]
    fn commands_are_stored_as_they_will_be_typed() {
        let bot = a_bot("commands");
        let said = set_commands(
            &bot,
            &json!({ "commands": [
                { "name": "/Log", "what": "log a meal" },
                { "name": "log", "what": "a duplicate, ignored" },
                { "name": "today", "what": "today's totals" },
            ] }),
        );
        assert_ne!(said["isError"], true, "{said}");

        let left: Value = serde_json::from_str(
            &std::fs::read_to_string(bot.workspace.join("commands.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            left,
            json!([
                { "name": "log", "what": "log a meal" },
                { "name": "today", "what": "today's totals" },
            ])
        );
    }

    /// Withdrawing them is a thing a bot may do, and has to be told apart from
    /// never having said anything — so an empty list is still written.
    #[test]
    fn an_empty_list_withdraws_them() {
        let bot = a_bot("withdrawing");
        set_commands(&bot, &json!({ "commands": [{ "name": "log", "what": "log it" }] }));
        let said = set_commands(&bot, &json!({ "commands": [] }));

        assert_ne!(said["isError"], true, "{said}");
        assert_eq!(
            std::fs::read_to_string(bot.workspace.join("commands.json")).unwrap(),
            "[]",
            "the file has to exist and say none, not simply be absent"
        );
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
                colleagues: vec!["Ops".into()],
                files: false,
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

#[cfg(test)]
mod schedule_tests {
    use super::*;

    fn a_bot(name: &str) -> Bot {
        let dir = std::env::temp_dir().join(format!("botcage-sched-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("workspace");
        Bot {
            id: "b1".into(),
            workspace: dir,
            brand: Default::default(),
            colleagues: vec!["Ops".into(), "Research & Writing".into()],
            files: false,
        }
    }

    fn written(bot: &Bot) -> Vec<Value> {
        std::fs::read_to_string(bot.workspace.join("routines.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("valid json"))
            .collect()
    }

    /// The point of the whole thing: work that lands on somebody else's week.
    #[test]
    fn a_bot_can_put_work_on_a_colleagues_calendar() {
        let bot = a_bot("other");
        let said = set_routine(
            &bot,
            &json!({
                "bot": "ops",
                "name": "Morning backup check",
                "instruction": "Check last night's backup finished and say so in one line.",
                "every": "weekday",
                "at": "08:30"
            }),
        );
        assert_ne!(said["isError"], true, "{said}");

        let all = written(&bot);
        assert_eq!(all.len(), 1);
        assert_eq!(
            all[0]["bot"], "ops",
            "case is the window's problem, not this one"
        );
        assert_eq!(all[0]["every"], "weekday");
        assert_eq!(all[0]["at"], "08:30");
    }

    /// A name nobody answers to is refused with the list, because the reader is
    /// a model that can try again — and because inventing a target would put
    /// work on the wrong bot's calendar, which is worse than doing nothing.
    #[test]
    fn scheduling_for_a_bot_that_does_not_exist_says_who_does() {
        let bot = a_bot("missing");
        let why = set_routine(
            &bot,
            &json!({ "bot": "Finance", "name": "x", "instruction": "y", "every": "day" }),
        );
        assert_eq!(why["isError"], true);
        let text = why["content"][0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("Finance") && text.contains("Ops"), "{text}");
        assert!(
            !bot.workspace.join("routines.jsonl").exists(),
            "nothing is written when the target is nobody"
        );
    }

    #[test]
    fn its_own_calendar_needs_no_name_and_a_schedule_must_be_one_we_draw() {
        let bot = a_bot("self");
        assert_ne!(
            set_routine(
                &bot,
                &json!({ "name": "Tidy up", "instruction": "z", "every": "day" })
            )["isError"],
            true
        );
        assert!(written(&bot)[0].get("bot").is_none(), "absent means itself");

        let why = set_routine(
            &bot,
            &json!({ "name": "x", "instruction": "y", "every": "fortnight" }),
        );
        assert_eq!(why["isError"], true);
        assert!(why["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("weekday"));
    }

    /// Several in one turn is an ordinary thing to want — "put these three
    /// checks on Ops" — and the second must not replace the first.
    #[test]
    fn a_turn_may_schedule_more_than_one_thing() {
        let bot = a_bot("several");
        for name in ["First", "Second", "Third"] {
            set_routine(
                &bot,
                &json!({ "bot": "Ops", "name": name, "instruction": "do it", "every": "day" }),
            );
        }
        let all = written(&bot);
        assert_eq!(all.len(), 3);
        assert_eq!(all[2]["name"], "Third");
    }

    #[test]
    fn a_routine_without_an_instruction_is_refused() {
        let bot = a_bot("empty");
        assert_eq!(
            set_routine(&bot, &json!({ "name": "Something", "every": "day" }))["isError"],
            true
        );
    }
}
