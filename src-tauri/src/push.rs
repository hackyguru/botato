//! Notifications to a phone, sent by this machine.
//!
//! iOS will only wake an app that is not running for a notification that came
//! through Apple's push service. No socket survives the app being suspended
//! and no laptop on the same network can do it directly, so something has to
//! talk to Apple — and the usual answer is to rent somebody's relay, hand it
//! your notifications, and put a third party between a person and their own
//! bots.
//!
//! This machine talks to Apple itself. It holds an APNs key, signs a token
//! with it, and posts to `api.push.apple.com`. Apple is in between because it
//! is their operating system and there is no way around that; nobody else is.
//! The phone's own screen promises that, and it stays true.
//!
//! What it needs is one file. In the Apple developer account, under Keys, a
//! key with the Apple Push Notifications service enabled: a `.p8`, downloadable
//! once, plus its ten-character key id and the team id. Without them nothing
//! here does anything and the settings row says so.
//!
//! The request goes out through `curl`, which every machine botato runs on
//! already has and which speaks the HTTP/2 that APNs requires. Linking an HTTP
//! stack for one small POST would add megabytes to a binary that is proud of
//! being eleven.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Where the key and its two numbers live, once somebody has set them.
#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    /// The ten characters Apple prints next to the key.
    pub key_id: String,
    /// The team the key belongs to.
    pub team_id: String,
    /// The app being notified. Kept here rather than hard-coded so a rebuild
    /// under a different identifier does not need a recompile to reach itself.
    pub topic: String,
}

fn home(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "no data directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn key_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home(app)?.join("apns-key.p8"))
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(home(app)?.join("apns.json"))
}

/// What the settings screen needs to know: is this set up, and for what.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub ready: bool,
    pub key_id: Option<String>,
    pub team_id: Option<String>,
    pub topic: Option<String>,
}

#[tauri::command]
pub fn push_state(app: AppHandle) -> State {
    match config(&app) {
        Some(c) => State {
            ready: true,
            key_id: Some(c.key_id),
            team_id: Some(c.team_id),
            topic: Some(c.topic),
        },
        None => State {
            ready: false,
            key_id: None,
            team_id: None,
            topic: None,
        },
    }
}

/// The key and its numbers, if all of them are there. Missing any one of them
/// is the same as having none: a key without its id cannot be presented, and
/// an id without a key cannot be signed with.
pub fn config(app: &AppHandle) -> Option<Config> {
    let key = key_file(app).ok()?;
    if !key.is_file() {
        return None;
    }
    let raw = std::fs::read_to_string(config_file(app).ok()?).ok()?;
    let c: Config = serde_json::from_str(&raw).ok()?;
    (!c.key_id.is_empty() && !c.team_id.is_empty() && !c.topic.is_empty()).then_some(c)
}

/// Take a key file and remember it, having first checked it is a key.
///
/// Copied rather than referred to: a path into somebody's Downloads is a path
/// that stops working the week they tidy up, and a key that has gone missing
/// fails at the moment you most wanted the notification.
#[tauri::command]
pub fn push_setup(
    app: AppHandle,
    path: String,
    key_id: String,
    team_id: String,
    topic: String,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("cannot read that file: {e}"))?;
    if !raw.contains("BEGIN PRIVATE KEY") {
        return Err("that is not a .p8 key — Apple's file starts with BEGIN PRIVATE KEY".into());
    }
    // Signing with it now rather than at the first notification, so a wrong id
    // or a damaged key is a message here instead of silence later.
    token(&raw, key_id.trim(), team_id.trim())?;

    std::fs::write(key_file(&app)?, &raw).map_err(|e| e.to_string())?;
    let config = Config {
        key_id: key_id.trim().to_string(),
        team_id: team_id.trim().to_string(),
        topic: topic.trim().to_string(),
    };
    std::fs::write(
        config_file(&app)?,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/// Forget the key. The file goes, not just the settings — a key left on disk
/// after somebody said "stop" is a key they think they deleted.
#[tauri::command]
pub fn push_forget(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(key_file(&app)?);
    let _ = std::fs::remove_file(config_file(&app)?);
    Ok(())
}

#[derive(Serialize)]
struct Claims {
    iss: String,
    iat: u64,
}

/// The bearer token APNs wants: an ES256 JWT saying who is asking, signed with
/// the key. Good for an hour by Apple's rules; made fresh each time, because a
/// notification is rare enough that caching one would be optimising the thing
/// that is not slow.
fn token(key: &str, key_id: &str, team_id: &str) -> Result<String, String> {
    let mut head = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    head.kid = Some(key_id.to_string());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let claims = Claims {
        iss: team_id.to_string(),
        iat: now,
    };
    let signing = jsonwebtoken::EncodingKey::from_ec_pem(key.as_bytes())
        .map_err(|e| format!("that key will not load: {e}"))?;
    jsonwebtoken::encode(&head, &claims, &signing).map_err(|e| format!("cannot sign: {e}"))
}

/// Send one, to one phone.
///
/// `sandbox` follows the build on the phone rather than anything here: a token
/// from a development build only exists on Apple's sandbox host, and asking the
/// production host about it returns "BadDeviceToken", which sounds like a
/// broken token and is not.
#[tauri::command]
pub async fn push_send(
    app: AppHandle,
    token_hex: String,
    sandbox: bool,
    title: String,
    body: String,
) -> Result<(), String> {
    let Some(config) = config(&app) else {
        return Err("no push key set up".into());
    };
    let key = std::fs::read_to_string(key_file(&app)?).map_err(|e| e.to_string())?;
    let bearer = token(&key, &config.key_id, &config.team_id)?;

    let host = if sandbox {
        "api.sandbox.push.apple.com"
    } else {
        "api.push.apple.com"
    };
    let payload = serde_json::json!({
        "aps": {
            "alert": { "title": title, "body": body },
            "sound": "default",
        }
    })
    .to_string();

    let out = std::process::Command::new("curl")
        .args([
            "--http2",
            "--silent",
            "--show-error",
            // Long enough for a slow network and short enough that a
            // notification never holds anything else up.
            "--max-time",
            "10",
            "--write-out",
            "\n%{http_code}",
            "-X",
            "POST",
            "-H",
            &format!("authorization: bearer {bearer}"),
            "-H",
            &format!("apns-topic: {}", config.topic),
            "-H",
            "apns-push-type: alert",
            "-H",
            "apns-priority: 10",
            "-d",
            &payload,
            &format!("https://{host}/3/device/{token_hex}"),
        ])
        .output()
        .map_err(|e| format!("curl would not run: {e}"))?;

    let said = String::from_utf8_lossy(&out.stdout);
    let code = said.rsplit('\n').next().unwrap_or("").trim();
    if code == "200" {
        return Ok(());
    }
    // Apple's reasons are short and useful — BadDeviceToken, ExpiredToken,
    // TopicDisallowed — so they are passed through rather than flattened into
    // "could not send".
    let reason = said
        .rsplit_once('\n')
        .map(|(body, _)| body.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string());
    Err(format!("Apple refused it ({code}): {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A key Apple would never issue, in the shape one has: enough to prove the
    /// signer reads PEM and produces three dot-separated parts, without a real
    /// key going anywhere near the repository.
    const KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2\nOF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r\n1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G\n-----END PRIVATE KEY-----\n";

    #[test]
    fn a_token_is_three_parts_and_names_the_key() {
        let jwt = token(KEY, "ABCD123456", "TEAM123456").expect("a token");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "header, claims, signature");

        let head = base64_url(parts[0]);
        assert!(
            head.contains("\"kid\":\"ABCD123456\""),
            "names the key: {head}"
        );
        assert!(head.contains("ES256"), "the only algorithm APNs takes");

        let claims = base64_url(parts[1]);
        assert!(claims.contains("\"iss\":\"TEAM123456\""), "names the team");
    }

    #[test]
    fn a_key_that_is_not_a_key_is_refused_before_it_is_stored() {
        assert!(token("hello", "ABCD123456", "TEAM123456").is_err());
    }

    fn base64_url(part: &str) -> String {
        // Small enough to do by hand, and it keeps a decoder out of the
        // dependency list for the sake of one assertion.
        const SET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = 0u32;
        let mut have = 0;
        let mut out = Vec::new();
        for ch in part.bytes() {
            let Some(at) = SET.iter().position(|c| *c == ch) else {
                continue;
            };
            bits = (bits << 6) | at as u32;
            have += 6;
            if have >= 8 {
                have -= 8;
                out.push((bits >> have) as u8);
            }
        }
        String::from_utf8_lossy(&out).to_string()
    }
}
