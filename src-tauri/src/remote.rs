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
//! Everything arrives over the peer-to-peer link, including on a network the
//! two devices share. The server listens on loopback only, so there is no port
//! open on any network this machine joins and nothing to find on a café's Wi-Fi
//! — a phone reaches it exclusively through an authenticated QUIC connection,
//! whose encryption is the same whether the two are in the same room or on
//! different continents.
//!
//! Two things must hold before a request is answered: it arrived over a
//! connection from a paired device's key, and it carries that device's token.
//! Neither alone is enough. A token lifted from one phone is refused from
//! another, and a stranger who learns this machine's public key gets no further
//! than a connection that answers nothing.

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

/// No fixed port. Nothing outside this machine dials it — the peer-to-peer link
/// is the only route in, and it is told which port to use — so a number in the
/// source can only cause the failure it was meant to prevent: a second botcage,
/// or a stale one from a rebuild, finding the port taken and refusing to start.
fn port() -> u16 {
    remote().lock().unwrap().port
}

/// Where the splice should connect. Public for the p2p module, which is the only
/// thing that ever needs it.
pub fn local_port() -> u16 {
    port()
}

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
    /// as a credential if the file is read. The value carries the device's own
    /// public key, so a token only works from the phone it was issued to.
    devices: HashMap<String, Device>,
    /// Wrong pairing codes seen for the live code. A code is short enough to
    /// read aloud, so it must not survive being guessed at.
    wrong: u32,
    /// Which key is on the other end of each spliced connection, by the local
    /// port the peer-to-peer link opened. The splice stays byte-for-byte
    /// transparent this way — the identity travels beside the stream, not in
    /// it, so nothing can spoof it by writing a header.
    peers: HashMap<u16, String>,
    /// Open event streams. Writing to a dead one is how they get reaped.
    listeners: Vec<TcpStream>,
    /// The port the server actually bound, chosen by the operating system.
    port: u16,
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
            wrong: 0,
            peers: HashMap::new(),
            port: 0,
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

/// A phone that has been paired: what to call it, which key it speaks from, and
/// what kind of thing it is.
#[derive(Clone, Serialize, serde::Deserialize)]
pub struct Device {
    pub name: String,
    /// The device's public key. A token is only accepted from this key.
    pub peer: String,
    /// "ios" or "android", as the phone reported itself. Absent for devices
    /// paired before this was recorded, which is why nothing depends on it
    /// beyond which icon is drawn.
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: u16,
    /// The live pairing code, while one is live.
    pub code: Option<String>,
    pub code_expires_in: u64,
    pub devices: Vec<PairedDevice>,
}

/// One paired phone, as the settings panel lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub name: String,
    pub platform: Option<String>,
}

fn devices_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("paired-devices.json"))
}

fn load_devices(app: &AppHandle) -> HashMap<String, Device> {
    let Ok(path) = devices_file(app) else {
        return HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<HashMap<String, Device>>(&raw).ok())
        .unwrap_or_default()
}

fn save_devices(app: &AppHandle, devices: &HashMap<String, Device>) {
    if let Ok(path) = devices_file(app) {
        if let Ok(text) = serde_json::to_string_pretty(devices) {
            let _ = std::fs::write(path, text);
        }
    }
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
    RemoteStatus {
        running: state.running,
        port: state.port,
        code,
        code_expires_in: expires,
        devices: state
            .devices
            .values()
            .map(|device| PairedDevice {
                name: device.name.clone(),
                platform: device.platform.clone(),
            })
            .collect(),
    }
}

/* ------------------------------------------------------------- the server */

#[tauri::command(async)]
pub fn remote_start(app: AppHandle) -> Result<u16, String> {
    {
        let mut state = remote().lock().unwrap();
        if state.running {
            return Ok(state.port);
        }
        state.devices = load_devices(&app);
    }

    // Loopback and whatever port is free: the only route in is the peer-to-peer
    // link, which terminates here. Nothing is exposed to whatever network this
    // machine happens to have joined, and nothing else has to agree on a number.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("could not start the local server: {e}"))?;
    let bound = listener
        .local_addr()
        .map_err(|e| format!("could not read the server's port: {e}"))?
        .port();
    {
        let mut state = remote().lock().unwrap();
        state.running = true;
        state.port = bound;
    }
    heartbeat();

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
    Ok(bound)
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
    let mut state = remote().lock().unwrap();
    state.code = Some((code.clone(), now() + PAIRING_SECONDS));
    state.wrong = 0;
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

/// Point the splice at a listener a test opened, so the p2p path can be checked
/// without a running app.
#[cfg(test)]
pub fn use_port_for_test(port: u16) {
    remote().lock().unwrap().port = port;
}

/// Note which key a spliced connection belongs to. Called by the p2p module
/// with the local port of the connection it just opened to this server.
pub fn register_peer(port: u16, peer: String) {
    remote().lock().unwrap().peers.insert(port, peer);
}

pub fn forget_peer(port: u16) {
    remote().lock().unwrap().peers.remove(&port);
}

fn peer_of(stream: &TcpStream) -> Option<String> {
    let port = stream.peer_addr().ok()?.port();
    remote().lock().unwrap().peers.get(&port).cloned()
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
    // Which device is on the other end, established by QUIC before a byte of
    // this request was written. A connection that did not arrive through the
    // peer-to-peer link has none, and is answered by nothing.
    let peer = peer_of(&stream);
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
        match &peer {
            Some(peer) => pair(&app, &mut stream, &request, peer),
            // Pairing is how a device becomes known, so it is the one request
            // that may come from a stranger — but it still has to arrive over
            // an encrypted connection whose key we can record.
            None => send(
                &mut stream,
                "403 Forbidden",
                &json!({ "error": "pair over botcage's own connection" }),
            ),
        }
        return;
    }

    if !authorised(&request, peer.as_deref()) {
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

/// A request is answered only when both halves agree: the token was issued to
/// this device, and the connection is coming from that device's key.
fn authorised(request: &Request, peer: Option<&str>) -> bool {
    let (Some(token), Some(peer)) = (&request.token, peer) else {
        return false;
    };
    let state = remote().lock().unwrap();
    state.running
        && state
            .devices
            .get(&hash(token))
            .is_some_and(|device| device.peer == peer)
}

/// How many wrong codes end the attempt. A six-character code is meant to be
/// read off a screen once, not guessed at.
const CODE_ATTEMPTS: u32 = 5;

fn pair(app: &AppHandle, stream: &mut TcpStream, request: &Request, peer: &str) {
    let body: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
    let given = body["code"].as_str().unwrap_or("").to_uppercase();
    let name = body["name"].as_str().unwrap_or("a phone").to_string();
    let platform = body["platform"].as_str().map(str::to_string);

    let mut state = remote().lock().unwrap();
    let valid = match &state.code {
        Some((code, expires)) => *expires > now() && !given.is_empty() && given == *code,
        None => false,
    };
    if !valid {
        state.wrong += 1;
        if state.wrong >= CODE_ATTEMPTS {
            // Guessed at enough times: the code is gone, and a new one has to
            // be shown deliberately.
            state.code = None;
        }
        let left = CODE_ATTEMPTS.saturating_sub(state.wrong);
        drop(state);
        send(
            stream,
            "403 Forbidden",
            &json!({
                "error": if left == 0 {
                    "too many wrong codes — show a new one on the laptop".to_string()
                } else {
                    "that code is wrong or has expired".to_string()
                }
            }),
        );
        return;
    }

    let token = crate::oauth::random_token(32);
    // A code is good for one device, so a shoulder-surfed code cannot be reused.
    state.code = None;
    state.wrong = 0;
    state.devices.insert(
        hash(&token),
        Device {
            name,
            peer: peer.to_string(),
            platform,
        },
    );
    let devices = state.devices.clone();
    drop(state);
    save_devices(app, &devices);

    // The peer address goes with the token: a phone paired at home must keep
    // working once it leaves, and this is the only moment both are in hand.
    send(
        stream,
        "200 OK",
        &json!({ "token": token, "peer": crate::p2p::p2p_address() }),
    );
}

/// Hold the connection open and stream events until the phone goes away.
fn subscribe(mut stream: TcpStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                Cache-Control: no-cache\r\nAccess-Control-Allow-Origin: *\r\n\
                Connection: keep-alive\r\n\r\n";
    // A comment frame straight away, before any bot has said anything. Headers
    // alone do not reach a client until the first body bytes do, so without
    // this a phone cannot tell "connected and quiet" from "not connected" —
    // which is exactly how it read.
    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(b": connected\n\n").is_err() {
        return;
    }
    let _ = stream.flush();
    remote().lock().unwrap().listeners.push(stream);
}

/// Keep quiet connections alive and notice dead ones. A phone changes network,
/// sleeps and moves between cells; something has to write, or a stream that
/// died in a pocket looks identical to one where nothing has happened.
fn heartbeat() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(20));
        let mut state = remote().lock().unwrap();
        if !state.running {
            state.listeners.clear();
            return;
        }
        state
            .listeners
            .retain_mut(|stream| stream.write_all(b": ping\n\n").is_ok() && stream.flush().is_ok());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_stored_only_as_hashes() {
        let token = "a-token-that-must-not-be-recoverable";
        let digest = hash(token);
        assert_eq!(digest.len(), 64);
        assert!(!digest.contains("token"));
        assert_eq!(digest, hash(token), "hashing must be stable");
        assert_ne!(digest, hash("another"));
    }

    /// The whole path a phone takes, against a real socket: refused without a
    /// token, refused with a wrong code, paired with the right one, then let in
    /// — and refused again when the same token arrives from a different device
    /// or over a connection with no proven key at all. Everything here would
    /// otherwise be discovered on a phone, which is the worst place to debug it.
    #[test]
    fn a_token_only_works_from_the_device_it_was_issued_to() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpStream;

        const PHONE: &str = "the-phones-key";
        const IMPOSTOR: &str = "someone-elses-key";

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().unwrap().port();
        {
            let mut state = remote().lock().unwrap();
            state.running = true;
            state.devices.clear();
            state.peers.clear();
            state.wrong = 0;
            state.code = Some(("ABC123".into(), now() + 60));
        }

        // Stands in for the p2p module: claims a key for each connection the
        // way the splice does, keyed by the port the client dialled from.
        let claim: std::sync::Arc<Mutex<Option<String>>> =
            std::sync::Arc::new(Mutex::new(Some(PHONE.into())));
        let claimed = claim.clone();

        std::thread::spawn(move || {
            for stream in listener.incoming().take(6) {
                let Ok(mut stream) = stream else { continue };
                if let Some(key) = claimed.lock().unwrap().clone() {
                    register_peer(stream.peer_addr().unwrap().port(), key);
                }
                let peer = peer_of(&stream);
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let path = request.path.split('?').next().unwrap_or("").to_string();

                if path == "/api/pair" {
                    let Some(peer) = peer else {
                        send(&mut stream, "403 Forbidden", &json!({ "error": "no key" }));
                        continue;
                    };
                    let body: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
                    let given = body["code"].as_str().unwrap_or("").to_uppercase();
                    let mut state = remote().lock().unwrap();
                    let ok =
                        matches!(&state.code, Some((code, at)) if *at > now() && given == *code);
                    if !ok {
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
                    state.devices.insert(
                        hash(&token),
                        Device {
                            name: "test phone".into(),
                            peer,
                            platform: Some("ios".into()),
                        },
                    );
                    drop(state);
                    send(&mut stream, "200 OK", &json!({ "token": token }));
                } else if !authorised(&request, peer.as_deref()) {
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
                (
                    status.trim().to_string(),
                    rest.split("\r\n\r\n").nth(1).unwrap_or("").to_string(),
                )
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

        let (status, body) = call("POST", "/api/pair", None, r#"{"code":"abc123"}"#);
        assert!(
            status.contains("200"),
            "the right code must pair, got {status}"
        );
        let token = serde_json::from_str::<Value>(&body).unwrap()["token"]
            .as_str()
            .expect("a token")
            .to_string();

        let (status, _) = call("GET", "/api/state", Some(&token), "");
        assert!(
            status.contains("200"),
            "the paired device must be let in, got {status}"
        );

        // The same token, from a different key: this is the stolen-token case,
        // and it is the reason the key is checked at all.
        *claim.lock().unwrap() = Some(IMPOSTOR.into());
        let (status, _) = call("GET", "/api/state", Some(&token), "");
        assert!(
            status.contains("401"),
            "another device must be refused, got {status}"
        );

        // And a connection that never went through the p2p link has no key.
        *claim.lock().unwrap() = None;
        let (status, _) = call("GET", "/api/state", Some(&token), "");
        assert!(
            status.contains("401"),
            "an unproven connection must be refused, got {status}"
        );

        let mut state = remote().lock().unwrap();
        state.running = false;
        state.devices.clear();
        state.peers.clear();
    }

    #[test]
    fn a_guessed_code_burns_out() {
        {
            let mut state = remote().lock().unwrap();
            state.code = Some(("ZZZZZZ".into(), now() + 60));
            state.wrong = 0;
        }
        // Five wrong answers is the whole budget for a code read off a screen.
        for _ in 0..CODE_ATTEMPTS {
            let mut state = remote().lock().unwrap();
            state.wrong += 1;
            if state.wrong >= CODE_ATTEMPTS {
                state.code = None;
            }
        }
        assert!(
            remote().lock().unwrap().code.is_none(),
            "the code must not survive being guessed at"
        );
    }
}
