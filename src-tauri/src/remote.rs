//! The desktop's side of the phone client: a small HTTP server that lets a
//! paired device drive this copy of botcage.
//!
//! Almost nothing is implemented here twice. Bots, threads and settings live in
//! the desktop window's own storage, not in Rust, so this server does not try to
//! own them — a request from the phone is handed to the running window, which
//! answers it with the same code the desktop UI uses. That is what makes parity
//! free rather than a second implementation to keep in step.
//!
//! Live output is the exception, and goes the other way: a bot's tokens already
//! originate in Rust, so subscribers are fed straight from the same emit that
//! feeds the window.
//!
//! No async runtime and no HTTP crate: a thread per connection, like the OAuth
//! callback listener this is modelled on. The whole point of the app is a 2 MB
//! download.
//!
//! Reachability is Tailscale's job, not ours. On a tailnet the phone reaches the
//! laptop from anywhere with no ports forwarded and no account of ours in the
//! middle. This server binds to every interface and refuses anything without a
//! token, so it is equally correct on a home network.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Chosen to sit outside the ranges macOS hands out for ephemeral ports, so a
/// restart does not find it taken by something else.
pub const PORT: u16 = 8767;

/// A pairing code is short enough to type off a screen, so it must not live
/// long. Five minutes is enough to walk to the sofa and fetch your phone.
const PAIRING_SECONDS: u64 = 300;

/// How long a phone's request may wait for the desktop window to answer. Long
/// enough for a slow paint, short enough that a wedged window reports as broken
/// rather than hanging the phone.
const RELAY_TIMEOUT: Duration = Duration::from_secs(20);

struct Remote {
    running: bool,
    /// Live pairing code and the moment it expires.
    code: Option<(String, u64)>,
    /// Paired devices, by SHA-256 of their token: nothing here can be replayed
    /// as a credential if the file is read.
    devices: HashMap<String, String>,
    /// Open event streams. Writing to a dead one is how they get reaped.
    listeners: Vec<TcpStream>,
    /// Requests handed to the desktop window, awaiting its answer.
    pending: HashMap<u64, Sender<Result<Value, String>>>,
    next_id: u64,
}

impl Default for Remote {
    fn default() -> Self {
        Remote {
            running: false,
            code: None,
            devices: HashMap::new(),
            listeners: Vec::new(),
            pending: HashMap::new(),
            next_id: 1,
        }
    }
}

fn remote() -> &'static Mutex<Remote> {
    static REMOTE: OnceLock<Mutex<Remote>> = OnceLock::new();
    REMOTE.get_or_init(|| Mutex::new(Remote::default()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn hash(token: &str) -> String {
    crate::oauth::sha256(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/* ------------------------------------------------------------------- state */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: u16,
    /// The live pairing code, while one is live.
    pub code: Option<String>,
    pub code_expires_in: u64,
    pub devices: Vec<String>,
    /// Addresses this machine can be reached on, tailnet first.
    pub addresses: Vec<String>,
    pub tailscale: bool,
}

fn devices_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("paired-devices.json"))
}

fn load_devices(app: &AppHandle) -> HashMap<String, String> {
    let Ok(path) = devices_file(app) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
        .unwrap_or_default()
}

fn save_devices(app: &AppHandle, devices: &HashMap<String, String>) {
    if let Ok(path) = devices_file(app) {
        if let Ok(text) = serde_json::to_string_pretty(devices) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Every address a phone could be told to use. A tailnet address (Tailscale's
/// 100.64.0.0/10 range) comes first because it is the one that still works away
/// from the house.
fn addresses() -> Vec<String> {
    let output = if cfg!(target_os = "macos") {
        std::process::Command::new("ifconfig").output()
    } else {
        std::process::Command::new("ip")
            .args(["-4", "addr"])
            .output()
    };
    let Ok(out) = output else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);

    let mut found: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let rest = line
            .strip_prefix("inet ")
            .or_else(|| line.strip_prefix("inet4 "));
        let Some(rest) = rest else { continue };
        let Some(address) = rest.split_whitespace().next() else {
            continue;
        };
        // Linux prints a prefix length; macOS does not.
        let address = address.split('/').next().unwrap_or(address).to_string();
        if address.starts_with("127.") || found.contains(&address) {
            continue;
        }
        found.push(address);
    }
    found.sort_by_key(|address| !is_tailnet(address));
    found
}

/// Tailscale hands out addresses from the carrier-grade NAT range, 100.64/10.
fn is_tailnet(address: &str) -> bool {
    let mut parts = address.split('.');
    let (Some(100), Some(second)) = (
        parts.next().and_then(|p| p.parse::<u8>().ok()),
        parts.next().and_then(|p| p.parse::<u16>().ok()),
    ) else {
        return false;
    };
    (64..=127).contains(&second)
}

#[tauri::command(async)]
pub fn remote_status(app: AppHandle) -> RemoteStatus {
    let mut state = remote().lock().unwrap();
    if state.devices.is_empty() {
        state.devices = load_devices(&app);
    }
    let (code, expires) = match &state.code {
        Some((code, at)) if *at > now() => (Some(code.clone()), at - now()),
        _ => (None, 0),
    };
    let addresses = addresses();
    RemoteStatus {
        running: state.running,
        port: PORT,
        code,
        code_expires_in: expires,
        devices: state.devices.values().cloned().collect(),
        tailscale: addresses.iter().any(|a| is_tailnet(a)),
        addresses,
    }
}

/* ------------------------------------------------------------- the server */

#[tauri::command(async)]
pub fn remote_start(app: AppHandle) -> Result<u16, String> {
    {
        let mut state = remote().lock().unwrap();
        if state.running {
            return Ok(PORT);
        }
        state.devices = load_devices(&app);
    }

    let listener = TcpListener::bind(("0.0.0.0", PORT))
        .map_err(|e| format!("could not listen on port {PORT}: {e}"))?;
    remote().lock().unwrap().running = true;

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            if !remote().lock().unwrap().running {
                break;
            }
            let app = app.clone();
            std::thread::spawn(move || handle(app, stream));
        }
    });
    Ok(PORT)
}

#[tauri::command(async)]
pub fn remote_stop() {
    let mut state = remote().lock().unwrap();
    state.running = false;
    state.code = None;
    state.listeners.clear();
    // The accept loop is woken by its next connection; a stopped server refuses
    // every request in the meantime.
}

/// Show a code the phone can be paired with. Replaces any live one, so a code
/// read aloud and then abandoned cannot be used later.
#[tauri::command(async)]
pub fn remote_pairing_code() -> Result<String, String> {
    let raw = crate::oauth::random_token(8);
    let digits: String = raw
        .bytes()
        .filter(|b| b.is_ascii_alphanumeric())
        .take(6)
        .map(|b| b.to_ascii_uppercase() as char)
        .collect();
    let code = if digits.len() == 6 {
        digits
    } else {
        format!("{digits:X<6}")
    };
    remote().lock().unwrap().code = Some((code.clone(), now() + PAIRING_SECONDS));
    Ok(code)
}

#[tauri::command(async)]
pub fn remote_forget_devices(app: AppHandle) {
    let mut state = remote().lock().unwrap();
    state.devices.clear();
    save_devices(&app, &state.devices);
}

/// The desktop window's answer to a request the phone made.
#[tauri::command(async)]
pub fn remote_reply(id: u64, ok: bool, payload: Value) {
    let sender = remote().lock().unwrap().pending.remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(if ok {
            Ok(payload)
        } else {
            Err(payload.as_str().unwrap_or("the desktop app failed").into())
        });
    }
}

/// Hand a request to the desktop window and wait for its answer. This is the
/// whole trick: the window has the state and the logic, so the phone gets
/// whatever the desktop can do without any of it being written twice.
fn relay(app: &AppHandle, kind: &str, payload: Value) -> Result<Value, String> {
    let (sender, receiver) = channel();
    let id = {
        let mut state = remote().lock().unwrap();
        let id = state.next_id;
        state.next_id += 1;
        state.pending.insert(id, sender);
        id
    };

    app.emit(
        "remote-request",
        json!({ "id": id, "kind": kind, "payload": payload }),
    )
    .map_err(|e| e.to_string())?;

    match receiver.recv_timeout(RELAY_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            remote().lock().unwrap().pending.remove(&id);
            Err("the desktop app did not answer — is its window open?".into())
        }
    }
}

/* -------------------------------------------------------------- streaming */

/// Feed anything the desktop is told to every paired phone that is listening.
/// Called from the same place the window's events come from, so the phone sees
/// a reply arrive token by token exactly as the desktop does.
pub fn broadcast(event: &str, payload: &Value) {
    let frame = format!("event: {event}\ndata: {payload}\n\n");
    let mut state = remote().lock().unwrap();
    if state.listeners.is_empty() {
        return;
    }
    state
        .listeners
        .retain_mut(|stream| stream.write_all(frame.as_bytes()).is_ok() && stream.flush().is_ok());
}

/* ---------------------------------------------------------------- serving */

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut length = 0usize;
    let mut token = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            let value = value.trim();
            if name.eq_ignore_ascii_case("content-length") {
                length = value.parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("authorization") {
                token = value.strip_prefix("Bearer ").map(str::to_string);
            }
        }
    }

    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    Some(Request {
        method,
        path,
        token,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn send(stream: &mut TcpStream, status: &str, body: &Value) {
    let text = body.to_string();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn handle(app: AppHandle, mut stream: TcpStream) {
    let Some(request) = read_request(&mut stream) else {
        return;
    };
    let path = request.path.split('?').next().unwrap_or("").to_string();

    if request.method == "OPTIONS" {
        send(&mut stream, "204 No Content", &json!({}));
        return;
    }

    // Unauthenticated, on purpose: a phone has to be able to find out what it
    // is talking to before it has a token.
    if path == "/api/health" {
        let version = app.package_info().version.to_string();
        send(
            &mut stream,
            "200 OK",
            &json!({ "app": "botcage", "version": version }),
        );
        return;
    }

    if path == "/api/pair" && request.method == "POST" {
        pair(&app, &mut stream, &request);
        return;
    }

    if !authorised(&request) {
        send(
            &mut stream,
            "401 Unauthorized",
            &json!({ "error": "pair this device in botcage's settings first" }),
        );
        return;
    }

    if path == "/api/events" {
        subscribe(stream);
        return;
    }

    // Everything else is the desktop window's business.
    let payload: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
    let kind = path.strip_prefix("/api/").unwrap_or("");
    if kind.is_empty() {
        send(
            &mut stream,
            "404 Not Found",
            &json!({ "error": "no such route" }),
        );
        return;
    }
    match relay(&app, kind, payload) {
        Ok(value) => send(&mut stream, "200 OK", &value),
        Err(why) => send(&mut stream, "502 Bad Gateway", &json!({ "error": why })),
    }
}

fn authorised(request: &Request) -> bool {
    let Some(token) = &request.token else {
        return false;
    };
    let state = remote().lock().unwrap();
    state.running && state.devices.contains_key(&hash(token))
}

fn pair(app: &AppHandle, stream: &mut TcpStream, request: &Request) {
    let body: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
    let given = body["code"].as_str().unwrap_or("").to_uppercase();
    let name = body["name"].as_str().unwrap_or("a phone").to_string();

    let mut state = remote().lock().unwrap();
    let valid = match &state.code {
        Some((code, expires)) => *expires > now() && !given.is_empty() && given == *code,
        None => false,
    };
    if !valid {
        drop(state);
        send(
            stream,
            "403 Forbidden",
            &json!({ "error": "that code is wrong or has expired" }),
        );
        return;
    }

    let token = crate::oauth::random_token(32);
    // A code is good for one device, so a shoulder-surfed code cannot be reused.
    state.code = None;
    state.devices.insert(hash(&token), name);
    let devices = state.devices.clone();
    drop(state);
    save_devices(app, &devices);

    send(stream, "200 OK", &json!({ "token": token }));
}

/// Hold the connection open and stream events until the phone goes away.
fn subscribe(mut stream: TcpStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\n\
                Connection: keep-alive\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        return;
    }
    let _ = stream.flush();
    remote().lock().unwrap().listeners.push(stream);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_addresses_are_recognised() {
        assert!(is_tailnet("100.101.102.103"));
        assert!(is_tailnet("100.64.0.1"));
        assert!(is_tailnet("100.127.255.254"));
        // Neighbouring ranges are ordinary public addresses, not a tailnet.
        assert!(!is_tailnet("100.63.0.1"));
        assert!(!is_tailnet("100.128.0.1"));
        assert!(!is_tailnet("192.168.1.4"));
        assert!(!is_tailnet("10.0.0.2"));
        assert!(!is_tailnet("not an address"));
    }

    #[test]
    fn tokens_are_stored_only_as_hashes() {
        let token = "a-token-that-must-not-be-recoverable";
        let digest = hash(token);
        assert_eq!(digest.len(), 64);
        assert!(!digest.contains("token"));
        assert_eq!(digest, hash(token), "hashing must be stable");
        assert_ne!(digest, hash("another"));
    }

    /// The whole path a phone takes, against a real socket: refuse without a
    /// token, refuse a wrong code, pair with the right one, then accept the
    /// token it was given. Everything here would otherwise be discovered on a
    /// phone, which is the worst place to debug it.
    #[test]
    fn a_phone_can_pair_and_then_be_let_in() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpStream;

        // A listener of our own, so the test needs no running app and no fixed
        // port: the routing under test is the same.
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().unwrap().port();
        {
            let mut state = remote().lock().unwrap();
            state.running = true;
            state.devices.clear();
            state.code = Some(("ABC123".into(), now() + 60));
        }

        std::thread::spawn(move || {
            for stream in listener.incoming().take(5) {
                let Ok(mut stream) = stream else { continue };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let path = request.path.split('?').next().unwrap_or("").to_string();
                if path == "/api/pair" {
                    // pair() needs an AppHandle only to persist; exercise the
                    // decision and the token mint here.
                    let body: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
                    let given = body["code"].as_str().unwrap_or("").to_uppercase();
                    let mut state = remote().lock().unwrap();
                    let valid =
                        matches!(&state.code, Some((code, at)) if *at > now() && given == *code);
                    if !valid {
                        drop(state);
                        send(
                            &mut stream,
                            "403 Forbidden",
                            &json!({ "error": "wrong code" }),
                        );
                        continue;
                    }
                    let token = crate::oauth::random_token(32);
                    state.code = None;
                    state.devices.insert(hash(&token), "test phone".into());
                    drop(state);
                    send(&mut stream, "200 OK", &json!({ "token": token }));
                } else if !authorised(&request) {
                    send(
                        &mut stream,
                        "401 Unauthorized",
                        &json!({ "error": "pair first" }),
                    );
                } else {
                    send(&mut stream, "200 OK", &json!({ "hello": "phone" }));
                }
            }
        });

        let call =
            |method: &str, path: &str, token: Option<&str>, body: &str| -> (String, String) {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
                let auth = token
                    .map(|t| format!("Authorization: Bearer {t}\r\n"))
                    .unwrap_or_default();
                let request = format!(
                    "{method} {path} HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(request.as_bytes()).unwrap();
                let mut reader = BufReader::new(stream);
                let mut status = String::new();
                reader.read_line(&mut status).unwrap();
                let mut rest = String::new();
                reader.read_to_string(&mut rest).unwrap();
                let body = rest.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                (status.trim().to_string(), body)
            };

        let (status, _) = call("GET", "/api/state", None, "");
        assert!(
            status.contains("401"),
            "no token must be refused, got {status}"
        );

        let (status, _) = call("POST", "/api/pair", None, r#"{"code":"NOPE12"}"#);
        assert!(
            status.contains("403"),
            "a wrong code must be refused, got {status}"
        );

        let (status, body) = call(
            "POST",
            "/api/pair",
            None,
            r#"{"code":"abc123","name":"test phone"}"#,
        );
        assert!(
            status.contains("200"),
            "the right code must pair, got {status}"
        );
        let token = serde_json::from_str::<Value>(&body).unwrap()["token"]
            .as_str()
            .expect("a token")
            .to_string();
        assert!(token.len() > 20, "token looks too short: {token}");

        let (status, body) = call("GET", "/api/state", Some(&token), "");
        assert!(
            status.contains("200"),
            "the paired token must be accepted, got {status}"
        );
        assert!(body.contains("phone"), "unexpected body {body}");

        // The code is spent, so a second device cannot reuse an overheard one.
        let (status, _) = call("POST", "/api/pair", None, r#"{"code":"ABC123"}"#);
        assert!(
            status.contains("403"),
            "a used code must not pair again, got {status}"
        );

        let mut state = remote().lock().unwrap();
        state.running = false;
        state.devices.clear();
    }
}
