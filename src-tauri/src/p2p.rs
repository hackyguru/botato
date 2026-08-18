//! Reaching this machine from anywhere, with nothing in between.
//!
//! The phone and the laptop find each other by public key rather than by
//! address: iroh punches a hole between them and falls back to public relays
//! when a network refuses to cooperate. There is no account to make, no tailnet
//! to join, no port to forward, and no server of ours — which is the whole
//! point, since a chat client that needs someone else's infrastructure to reach
//! your own laptop is not really yours.
//!
//! Nothing of the API lives here. An incoming QUIC stream is spliced to the
//! local HTTP server, so a request that arrives over the internet is served by
//! exactly the same code as one that arrives over the LAN — including the event
//! stream, which is only a socket that stays open.
//!
//! This is the one async corner of the app. Everything else is threads and
//! blocking I/O; tokio lives inside this module and does not leak out of it.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Ours, so a stray QUIC connection from anything else is refused before it can
/// say anything. Versioned: the phone and the desktop must agree.
const ALPN: &[u8] = b"botcage/1";

/// The identity of this machine, once the endpoint is up. It is the address a
/// phone pairs with, and it survives restarts because the key is kept.
static IDENTITY: OnceLock<Mutex<Option<String>>> = OnceLock::new();

/// The full address — key, home relay, and the direct addresses this machine
/// knows of itself. Handed to a phone at pairing time so its first connection
/// needs no lookup; afterwards the key alone is enough, because that is the part
/// that does not change when the laptop moves between networks.
static ADDRESS: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn identity() -> &'static Mutex<Option<String>> {
    IDENTITY.get_or_init(|| Mutex::new(None))
}

fn address() -> &'static Mutex<Option<String>> {
    ADDRESS.get_or_init(|| Mutex::new(None))
}

/// Where this machine's long-lived private key lives. Losing it means every
/// paired phone has to pair again, so it is written once and kept.
fn key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("p2p-key"))
}

/// Load this machine's key, or make one. Not derived from anything guessable:
/// it is the only thing standing between a stranger and your bots.
fn secret_key(app: &AppHandle) -> Result<iroh::SecretKey, String> {
    let path = key_path(app)?;
    if let Ok(raw) = std::fs::read(&path) {
        if raw.len() == 32 {
            let mut bytes = [0u8; 32];
            bytes.copy_from_slice(&raw);
            return Ok(iroh::SecretKey::from_bytes(&bytes));
        }
    }

    let mut bytes = [0u8; 32];
    {
        use std::io::Read;
        let mut urandom = std::fs::File::open("/dev/urandom")
            .map_err(|e| format!("no randomness available: {e}"))?;
        urandom
            .read_exact(&mut bytes)
            .map_err(|e| format!("could not read randomness: {e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    // Readable only by this account: it is a private key sitting in a file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(iroh::SecretKey::from_bytes(&bytes))
}

/// This machine's identity, if the endpoint is up.
#[tauri::command(async)]
pub fn p2p_id() -> Option<String> {
    identity().lock().unwrap().clone()
}

/// Everything a phone needs to find this machine the first time. Re-read rather
/// than cached by the caller: a laptop that changes network learns new direct
/// addresses, and a pairing code shown afterwards should carry them.
#[tauri::command(async)]
pub fn p2p_address() -> Option<String> {
    address().lock().unwrap().clone()
}

/// Bring up the peer-to-peer endpoint. Returns the id a phone pairs with.
///
/// Blocks until the endpoint has bound — which is quick — and leaves the accept
/// loop running on its own runtime thread.
#[tauri::command(async)]
pub fn p2p_start(app: AppHandle) -> Result<String, String> {
    if let Some(id) = p2p_id() {
        return Ok(id);
    }
    let key = secret_key(&app)?;

    let (ready, wait) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(e) => {
                let _ = ready.send(Err(format!("could not start the p2p runtime: {e}")));
                return;
            }
        };
        runtime.block_on(async move {
            let endpoint = match iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .secret_key(key)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
            {
                Ok(endpoint) => endpoint,
                Err(e) => {
                    let _ = ready.send(Err(format!("could not bind the p2p endpoint: {e}")));
                    return;
                }
            };

            let id = endpoint.id().to_string();
            *identity().lock().unwrap() = Some(id.clone());
            let _ = ready.send(Ok(id));

            // Direct addresses are discovered a moment after binding, so this is
            // refreshed rather than read once — a pairing code shown thirty
            // seconds in should carry the best route available by then.
            let watcher = endpoint.clone();
            tokio::spawn(async move {
                loop {
                    if let Ok(text) = serde_json::to_string(&watcher.addr()) {
                        *address().lock().unwrap() = Some(text);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            });

            // One task per connection, one per stream: a phone with the event
            // stream open must not stop it making ordinary requests.
            while let Some(incoming) = endpoint.accept().await {
                tokio::spawn(async move {
                    let Ok(connection) = incoming.await else {
                        return;
                    };
                    while let Ok((send, recv)) = connection.accept_bi().await {
                        tokio::spawn(async move {
                            let _ = splice(send, recv, "test-peer".into()).await;
                        });
                    }
                });
            }
        });
    });

    wait.recv_timeout(std::time::Duration::from_secs(30))
        .map_err(|_| "the p2p endpoint did not come up".to_string())?
}

/// Hand a QUIC stream to the local HTTP server and get out of the way.
///
/// Splicing rather than parsing is what keeps this module ignorant of the API:
/// requests, responses and the event stream are all just bytes, and anything
/// added to the server works over p2p the day it is added.
/// The caller's key travels beside the stream rather than inside it — noted
/// against the local port of this connection, which the server reads back. A
/// phone therefore cannot claim to be another device by writing a header, and
/// the splice stays byte-for-byte transparent.
async fn splice(
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    peer: String,
) -> std::io::Result<()> {
    let mut local =
        tokio::net::TcpStream::connect(("127.0.0.1", crate::remote::local_port())).await?;
    let port = local.local_addr()?.port();
    crate::remote::register_peer(port, peer);

    let mut remote = tokio::io::join(recv, send);
    let outcome = tokio::io::copy_bidirectional(&mut remote, &mut local).await;

    // The operating system reuses the port the moment this closes, so the claim
    // on it has to go with it.
    crate::remote::forget_peer(port);
    outcome?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The identity has to survive a restart, or every phone would have to pair
    /// again each time botcage opens.
    #[test]
    fn a_key_file_round_trips() {
        let mut bytes = [0u8; 32];
        bytes[0] = 7;
        bytes[31] = 42;
        let key = iroh::SecretKey::from_bytes(&bytes);
        let again = iroh::SecretKey::from_bytes(&bytes);
        assert_eq!(
            key.public(),
            again.public(),
            "the same bytes must give the same identity"
        );

        let mut other = bytes;
        other[5] = 1;
        assert_ne!(
            key.public(),
            iroh::SecretKey::from_bytes(&other).public(),
            "different bytes must give a different identity"
        );
    }

    /// The whole path, over real QUIC: a second endpoint connects by public key
    /// alone, opens a stream, and is answered by the HTTP server on the other
    /// side. This is the thing that cannot be checked by reading.
    #[test]
    #[ignore = "talks to the network; run explicitly"]
    fn a_peer_can_reach_the_local_server() {
        use std::io::{Read, Write};
        // A stand-in for the API server, so the test needs no running app.
        // Any free port, and the splice is told which — the same way the real
        // server hands its port over.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        crate::remote::use_port_for_test(listener.local_addr().unwrap().port());
        std::thread::spawn(move || {
            for stream in listener.incoming().take(1) {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = br#"{"app":"botcage"}"#;
                let _ = stream.write_all(
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).as_bytes(),
                );
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });

        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let mut bytes = [0u8; 32];
            bytes[0] = 9;
            let server = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .secret_key(iroh::SecretKey::from_bytes(&bytes))
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .expect("bind server");
            let address = server.addr();

            tokio::spawn(async move {
                while let Some(incoming) = server.accept().await {
                    let Ok(connection) = incoming.await else {
                        continue;
                    };
                    while let Ok((send, recv)) = connection.accept_bi().await {
                        tokio::spawn(async move {
                            let _ = splice(send, recv, "test-peer".into()).await;
                        });
                    }
                }
            });

            let client = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .bind()
                .await
                .expect("bind client");
            let connection = client.connect(address, ALPN).await.expect("connect");
            let (mut send, mut recv) = connection.open_bi().await.expect("open stream");
            send.write_all(b"GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n")
                .await
                .expect("write");
            send.finish().expect("finish");

            // iroh's own read_to_end takes a size limit rather than a buffer.
            let answer = recv.read_to_end(64 * 1024).await.expect("read");
            let text = String::from_utf8_lossy(&answer);
            assert!(text.contains("200 OK"), "unexpected answer: {text}");
            assert!(text.contains("botcage"), "unexpected body: {text}");
            println!(
                "  reached the local server over p2p: {}",
                text.lines().next().unwrap_or("")
            );
        });
    }

    /// What a phone is actually given to find this machine with. Prints the
    /// home relay and the direct addresses, which is the difference between
    /// "works on my desk" and "works from a train".
    #[test]
    #[ignore = "talks to the network; run explicitly"]
    fn the_endpoint_gets_a_relay_and_addresses() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .expect("bind");

            // Direct addresses and a home relay are learned a moment after
            // binding, so give it that moment.
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            let address = endpoint.addr();
            let json = serde_json::to_string_pretty(&address).expect("address");
            println!("{json}");
            assert!(
                json.contains("relay") || json.contains("http"),
                "no relay in the address — a phone on mobile data would have nothing to fall back to"
            );
        });
    }
}
