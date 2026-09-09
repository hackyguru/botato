//! The phone's half of botato's peer-to-peer link.
//!
//! A phone cannot reach a laptop that sits behind a home router, and JavaScript
//! cannot speak QUIC or punch holes through a NAT — so this is the one piece of
//! the mobile app that has to be native. It is deliberately the smallest thing
//! that works: connect to a laptop by public key, carry an HTTP request over
//! that connection, and hold one stream open for events.
//!
//! It knows nothing about bots, messages or settings. The same JavaScript that
//! talks to a laptop over the local network talks to it through here, so the
//! app has one implementation of botato and two ways of reaching it.
//!
//! Calls block rather than being async across the FFI boundary. Swift and
//! Kotlin both call them off the main thread (Expo's async functions run on a
//! background queue), and blocking keeps the binding surface small enough to
//! reason about — an async FFI here would buy nothing the phone can feel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

uniffi::setup_scaffolding!();

/// Must match the desktop. A mismatch is refused during the QUIC handshake
/// rather than becoming a confusing error later.
const ALPN: &[u8] = b"botato/1";

/// Long enough to cross a relay on a bad mobile connection, short enough that a
/// laptop that is actually asleep is reported rather than waited on.
const TIMEOUT: Duration = Duration::from_secs(20);

/// How long the address learned at pairing time gets before the key is tried
/// instead. Short, because a stale route usually fails fast and waiting the full
/// timeout on it would double how long a laptop that simply moved takes to
/// answer.
const FIRST_TRY: Duration = Duration::from_secs(6);

/// How long an event stream may say nothing before it is presumed dead. The
/// desktop pings every twenty seconds precisely so this can be decided.
const SILENCE: Duration = Duration::from_secs(45);

/// Not named `message`: UniFFI maps these onto Kotlin exceptions, where a
/// `message` field collides with the one every Throwable already has, and the
/// generated bindings do not compile. Found by building for Android.
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum P2pError {
    /// The laptop could not be reached: asleep, offline, or not running botato.
    #[error("{reason}")]
    Unreachable { reason: String },
    /// It was reached, but something in between went wrong.
    #[error("{reason}")]
    Failed { reason: String },
}

fn unreachable(reason: impl std::fmt::Display) -> P2pError {
    P2pError::Unreachable {
        reason: reason.to_string(),
    }
}

fn failed(reason: impl std::fmt::Display) -> P2pError {
    P2pError::Failed {
        reason: reason.to_string(),
    }
}

/// One runtime for the whole app: an endpoint is expensive to build and holds
/// the connection to the relay network, so it is made once and kept.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the p2p runtime could not start")
    })
}

/// What the desktop answered.
#[derive(uniffi::Record)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

/// Where event frames go. Implemented on the Swift and Kotlin side, which hand
/// them to JavaScript — the app then treats them exactly like the frames it
/// reads from a local HTTP stream.
#[uniffi::export(callback_interface)]
pub trait EventSink: Send + Sync {
    /// One server-sent event frame, already stripped of its framing.
    fn on_frame(&self, name: String, data: String);
    /// Whether the stream is up, so the app can say so honestly.
    fn on_state(&self, connected: bool);
}

/// A live link to one laptop.
#[derive(uniffi::Object)]
pub struct Peer {
    endpoint: iroh::Endpoint,
    address: iroh::EndpointAddr,
    /// The laptop's public key on its own. Everything else about an address
    /// goes stale — the port changes on every restart, the addresses when it
    /// moves network — but this does not, so it is what the fallback dials.
    key: iroh::EndpointId,
    listening: AtomicBool,
}

#[uniffi::export]
impl Peer {
    /// Open an endpoint on this phone and note which laptop to talk to.
    ///
    /// The connection itself is made per request: a phone loses its network
    /// constantly, and a connection established at pairing time would be stale
    /// by the time anyone used it.
    #[uniffi::constructor]
    pub fn connect(address: String) -> Result<Arc<Self>, P2pError> {
        let address = parse_address(&address)?;

        let endpoint = runtime().block_on(async {
            iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .bind()
                .await
        })
        .map_err(|e| failed(format!("this phone could not open a connection: {e}")))?;

        Ok(Arc::new(Peer {
            endpoint,
            key: address.id,
            address,
            listening: AtomicBool::new(false),
        }))
    }

    /// Make one request and read the whole answer.
    pub fn request(
        &self,
        method: String,
        path: String,
        token: Option<String>,
        body: Option<String>,
    ) -> Result<Response, P2pError> {
        runtime().block_on(async {
            let connection = self.dial().await?;
            let (mut send, mut recv) = connection
                .open_bi()
                .await
                .map_err(|e| failed(format!("could not open a stream: {e}")))?;

            let request = http_request(&method, &path, token.as_deref(), body.as_deref());
            send.write_all(request.as_bytes())
                .await
                .map_err(|e| failed(format!("could not send the request: {e}")))?;
            send.finish().map_err(|e| failed(e))?;

            let raw = recv
                .read_to_end(8 * 1024 * 1024)
                .await
                .map_err(|e| failed(format!("could not read the answer: {e}")))?;
            parse_response(&raw)
        })
    }

    /// Hold a stream open and hand every frame to the sink. Blocks until the
    /// stream ends or `stop` is called, so the caller runs it on its own thread.
    pub fn listen(&self, token: Option<String>, sink: Box<dyn EventSink>) -> Result<(), P2pError> {
        self.listening.store(true, Ordering::SeqCst);
        let result = runtime().block_on(async {
            // Report a failed dial as the stream going down. Returning the
            // error alone told the phone nothing, so it scheduled one retry,
            // that retry failed just as quietly, and the light stayed amber
            // even after the laptop came back.
            let connection = match self.dial().await {
                Ok(connection) => connection,
                Err(e) => {
                    sink.on_state(false);
                    return Err(e);
                }
            };
            let (mut send, mut recv) = connection
                .open_bi()
                .await
                .map_err(|e| failed(format!("could not open the event stream: {e}")))?;
            send.write_all(http_request("GET", "/api/events", token.as_deref(), None).as_bytes())
                .await
                .map_err(|e| failed(format!("could not start the event stream: {e}")))?;

            // Not connected until the laptop says so. Reporting it on the way
            // out means an event stream the laptop refuses — a stale token, an
            // unpaired device — still looks live for a moment, and then looks
            // like a network problem, which is the wrong thing to go and fix.
            let mut pending = String::new();
            let mut buf = vec![0u8; 8 * 1024];
            loop {
                match recv.read(&mut buf).await {
                    Ok(Some(read)) if read > 0 => {
                        pending.push_str(&String::from_utf8_lossy(&buf[..read]));
                        if let Some(end) = pending.find("\r\n\r\n") {
                            let head = pending[..end].to_string();
                            if !head.starts_with("HTTP/1.1 200") {
                                sink.on_state(false);
                                let why = head.lines().next().unwrap_or("refused").to_string();
                                return Err(failed(format!("the laptop refused the stream: {why}")));
                            }
                            pending = pending[end + 4..].to_string();
                            break;
                        }
                    }
                    Ok(_) => {
                        sink.on_state(false);
                        return Err(failed("the laptop closed the stream"));
                    }
                    Err(e) => {
                        sink.on_state(false);
                        return Err(failed(format!("the event stream stopped: {e}")));
                    }
                }
            }
            sink.on_state(true);

            // Whatever arrived with the headers may already hold whole frames.
            while let Some(at) = pending.find("\n\n") {
                let frame: String = pending.drain(..at + 2).collect();
                if let Some((name, data)) = parse_frame(&frame) {
                    sink.on_frame(name, data);
                }
            }
            // Frames arrive split across reads as often as not, so whole frames
            // are cut from a buffer rather than assumed per read.
            while self.listening.load(Ordering::SeqCst) {
                // Bounded, because a read on a laptop that went away does not
                // fail — QUIC waits on a peer that may still come back, so the
                // phone sat believing it was listening while nothing arrived.
                // Requests kept working on new connections, which is what made
                // it look like a bot thinking forever rather than a dead
                // stream. The desktop pings every twenty seconds, so silence
                // for more than twice that means gone.
                let read = tokio::time::timeout(SILENCE, recv.read(&mut buf)).await;
                let Ok(read) = read else {
                    sink.on_state(false);
                    return Err(failed("the laptop stopped sending"));
                };
                match read {
                    Ok(Some(read)) if read > 0 => {
                        pending.push_str(&String::from_utf8_lossy(&buf[..read]));
                        while let Some(at) = pending.find("\n\n") {
                            let frame: String = pending.drain(..at + 2).collect();
                            if let Some((name, data)) = parse_frame(&frame) {
                                sink.on_frame(name, data);
                            }
                        }
                    }
                    Ok(_) => break,
                    Err(e) => {
                        sink.on_state(false);
                        return Err(failed(format!("the event stream stopped: {e}")));
                    }
                }
            }
            sink.on_state(false);
            Ok(())
        });
        self.listening.store(false, Ordering::SeqCst);
        result
    }

    /// End the event stream started by `listen`.
    pub fn stop(&self) {
        self.listening.store(false, Ordering::SeqCst);
    }

    /// This phone's own identity, for anything that wants to name it.
    pub fn id(&self) -> String {
        self.endpoint.id().to_string()
    }
}

impl Peer {
    /// A fresh connection per use. iroh reuses paths under the hood, so this is
    /// cheap after the first, and it means a phone that changed network between
    /// two messages simply reconnects instead of failing.
    async fn dial(&self) -> Result<iroh::endpoint::Connection, P2pError> {
        // What was learned at pairing time: usually a direct route, and the
        // fastest way in while it still holds.
        let known = tokio::time::timeout(
            FIRST_TRY,
            self.endpoint.connect(self.address.clone(), ALPN),
        )
        .await;
        if let Ok(Ok(connection)) = known {
            return Ok(connection);
        }

        // Then by key alone. A laptop that restarted listens on a different
        // port, one that moved network has different addresses, and one that
        // changed relay is somewhere else entirely — none of which change the
        // key. This is the answer to "I am out and cannot get back in".
        tokio::time::timeout(
            TIMEOUT,
            self.endpoint.connect(iroh::EndpointAddr::from(self.key), ALPN),
        )
        .await
        .map_err(|_| unreachable("your laptop did not answer — is it awake?"))?
        .map_err(|e| unreachable(format!("could not reach your laptop: {e}")))
    }
}

/// A laptop is named either by its full address — public key, home relay and
/// whatever direct addresses it knows of itself — or by its public key alone.
///
/// Pairing carries the full address, so the first connection needs no lookup and
/// works the moment the code is scanned. Afterwards the key alone is enough:
/// addresses change every time a laptop moves between networks, and the key
/// never does.
fn parse_address(text: &str) -> Result<iroh::EndpointAddr, P2pError> {
    let text = text.trim();
    if let Ok(address) = serde_json::from_str::<iroh::EndpointAddr>(text) {
        return Ok(address);
    }
    text.parse::<iroh::EndpointId>()
        .map(Into::into)
        .map_err(|_| unreachable("that is not a botato address"))
}

/// The desktop speaks ordinary HTTP, so this speaks it too rather than
/// inventing a second protocol for the same server.
fn http_request(method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> String {
    let body = body.unwrap_or("");
    let auth = token
        .map(|t| format!("Authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    format!(
        "{method} {path} HTTP/1.1\r\nHost: botato\r\n{auth}Content-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn parse_response(raw: &[u8]) -> Result<Response, P2pError> {
    let text = String::from_utf8_lossy(raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| failed("the answer was not a complete response"))?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| failed("the answer had no status"))?;
    Ok(Response {
        status,
        body: body.to_string(),
    })
}

/// One server-sent event frame into its name and data.
fn parse_frame(frame: &str) -> Option<(String, String)> {
    let mut name = String::from("message");
    let mut data = String::new();
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            name = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push_str(rest.trim());
        }
    }
    // Comment frames — the desktop's greeting and its pings — carry no data and
    // are not events; they only prove the link is alive.
    if data.is_empty() {
        return None;
    }
    Some((name, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_ordinary_http() {
        let request = http_request("POST", "/api/state", Some("abc"), Some("{}"));
        assert!(request.starts_with("POST /api/state HTTP/1.1\r\n"));
        assert!(request.contains("Authorization: Bearer abc\r\n"));
        assert!(request.contains("Content-Length: 2\r\n"));
        assert!(request.ends_with("\r\n\r\n{}"));

        // No token, no header — an unpaired phone must not send an empty one.
        assert!(!http_request("GET", "/api/health", None, None).contains("Authorization"));
    }

    #[test]
    fn responses_are_split_from_their_headers() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{\"ok\":1}\n";
        let response = parse_response(raw).expect("parse");
        assert_eq!(response.status, 200);
        assert_eq!(response.body.trim(), "{\"ok\":1}");

        assert_eq!(parse_response(b"HTTP/1.1 401 Unauthorized\r\n\r\n").unwrap().status, 401);
        assert!(parse_response(b"nonsense").is_err());
    }

    #[test]
    fn frames_are_read_whole() {
        assert_eq!(
            parse_frame("event: bot-event\ndata: {\"kind\":\"delta\"}\n\n"),
            Some(("bot-event".into(), "{\"kind\":\"delta\"}".into()))
        );

        // The desktop's "your bots and rooms have changed" frame carries no
        // detail, because the answer to it is always to read the snapshot
        // again. It still has to survive the rule below that throws away
        // frames with no data — those are the keep-alive pings — which is why
        // it is sent as a JSON null rather than as nothing at all.
        assert_eq!(
            parse_frame("event: stale\ndata: null\n\n"),
            Some(("stale".into(), "null".into())),
            "a phone that never hears this goes on showing a deleted room"
        );
        // The desktop's greeting and heartbeats are comments, not events.
        assert_eq!(parse_frame(": connected\n\n"), None);
        assert_eq!(parse_frame(": ping\n\n"), None);
    }

    /// The whole phone-side path against a stand-in for the desktop: an iroh
    /// endpoint with botato's ALPN, splicing streams to a local HTTP server.
    /// Everything above this line is parsing; this is the part that either
    /// works on a phone or does not.
    #[test]
    #[ignore = "talks to the network; run explicitly"]
    fn a_phone_can_reach_a_laptop() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 2048];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    if request.contains("/api/events") {
                        // The token has to reach the laptop, or the stream is
                        // refused — which is exactly the bug this now covers.
                        assert!(
                            request.contains("Authorization: Bearer tok"),
                            "the event stream must carry the token: {request}"
                        );
                        let _ = stream.write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: connected\n\n",
                        );
                        let _ = stream.flush();
                        for i in 0..3 {
                            std::thread::sleep(Duration::from_millis(80));
                            let _ = stream.write_all(
                                format!("event: bot-event\ndata: {{\"n\":{i}}}\n\n").as_bytes(),
                            );
                            let _ = stream.flush();
                        }
                    } else {
                        let body = format!("{{\"saw\":\"{}\"}}", request.lines().next().unwrap_or(""));
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        );
                        let _ = stream.flush();
                    }
                });
            }
        });

        // The desktop half, as botato implements it.
        let laptop_id = runtime().block_on(async move {
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .expect("bind laptop");
            let id = serde_json::to_string(&endpoint.addr()).expect("address");
            tokio::spawn(async move {
                while let Some(incoming) = endpoint.accept().await {
                    tokio::spawn(async move {
                        let Ok(connection) = incoming.await else { return };
                        while let Ok((send, recv)) = connection.accept_bi().await {
                            tokio::spawn(async move {
                                let Ok(mut local) =
                                    tokio::net::TcpStream::connect(("127.0.0.1", port)).await
                                else {
                                    return;
                                };
                                let mut remote = tokio::io::join(recv, send);
                                let _ =
                                    tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                            });
                        }
                    });
                }
            });
            id
        });

        let peer = Peer::connect(laptop_id).expect("connect");
        let answer = peer
            .request("POST".into(), "/api/state".into(), Some("tok".into()), Some("{}".into()))
            .expect("request");
        assert_eq!(answer.status, 200);
        assert!(answer.body.contains("POST /api/state"), "body was {}", answer.body);
        println!("  request over p2p → {} {}", answer.status, answer.body.trim());

        // And the event stream, which is the half that has to stay open.
        struct Collect(std::sync::Mutex<Vec<String>>, Arc<AtomicBool>);
        impl EventSink for Collect {
            fn on_frame(&self, name: String, data: String) {
                self.0.lock().unwrap().push(format!("{name}:{data}"));
            }
            fn on_state(&self, connected: bool) {
                self.1.store(connected, Ordering::SeqCst);
            }
        }
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let up = Arc::new(AtomicBool::new(false));
        let peer2 = peer.clone();
        let sink_seen = seen.clone();
        let sink_up = up.clone();
        let listener = std::thread::spawn(move || {
            struct Shared(Arc<std::sync::Mutex<Vec<String>>>, Arc<AtomicBool>);
            impl EventSink for Shared {
                fn on_frame(&self, name: String, data: String) {
                    self.0.lock().unwrap().push(format!("{name}:{data}"));
                }
                fn on_state(&self, connected: bool) {
                    self.1.store(connected, Ordering::SeqCst);
                }
            }
            let _ = peer2.listen(Some("tok".into()), Box::new(Shared(sink_seen, sink_up)));
        });
        std::thread::sleep(Duration::from_millis(900));
        peer.stop();
        let _ = listener.join();

        let frames = seen.lock().unwrap().clone();
        println!("  frames over p2p: {frames:?}");
        assert!(frames.len() >= 3, "expected the streamed frames, got {frames:?}");
        assert!(frames[0].starts_with("bot-event:"), "unexpected frame {}", frames[0]);
    }
}
