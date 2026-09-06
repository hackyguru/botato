//! botcage's own hosted inference, for people who would rather not collect
//! keys from ten companies before their first bot says anything.
//!
//! It is an option and never a requirement. Everything botcage does works
//! against Claude Code, Ollama on this machine, or any of the providers in the
//! catalogue, and this adds one more row to that list rather than standing in
//! front of it. Which is also why there is so little code here: the gateway
//! speaks the same OpenAI-shaped API as every other provider, so `inference.rs`
//! already knows how to talk to it. What is left is the part that is ours —
//! how a key arrives, and how much is left on it.
//!
//! ## Signing in
//!
//! A device flow, because the alternative is asking somebody to copy a secret
//! out of a browser and into a desktop app, and a secret that has been through
//! a clipboard has been somewhere neither end can see.
//!
//! The app asks for a code, shows it, and waits. The person types it into a
//! page they are already signed into, and the key arrives on its own. Nothing
//! is typed twice and nothing sits in a paste buffer.
//!
//! ```text
//!   POST {base}/device/code   -> { code, verify_url, token, expires_in, interval }
//!   POST {base}/device/poll   -> { status: "pending" | "ready" | "denied" | "expired", key? }
//! ```
//!
//! The `token` is the app's half and never leaves this machine; the `code` is
//! the human's half and is meant to be read aloud. Both are needed, so a code
//! shoulder-surfed off a screen is worth nothing on its own.

use std::process::Command;

use serde::Serialize;

/// Where the gateway lives.
///
/// The one thing to change when it has a home. `BOTCAGE_GATEWAY` overrides it,
/// which is how this gets developed against something running on localhost
/// without a build that points at a stub escaping into the world.
const HOSTED: &str = "https://api.botcage.app";

/// The provider id. Also the keychain entry the key is filed under, through
/// `catalogue::key_for`, so this is the same string in three places on purpose.
pub const ID: &str = "botcage";

pub fn base() -> String {
    std::env::var("BOTCAGE_GATEWAY")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| HOSTED.into())
        .trim_end_matches('/')
        .to_string()
}

/// What a sign-in gives the window to put on screen.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signin {
    /// The bit a person reads and types. Short, and grouped, because it is
    /// going to be copied by eye.
    pub code: String,
    /// Where they type it.
    pub verify_url: String,
    /// The app's half of the exchange. Opaque here; the gateway made it and
    /// the gateway checks it.
    pub token: String,
    /// Seconds before the code stops working, so the window can say so rather
    /// than spinning forever.
    pub expires_in: u64,
    /// How often the gateway is willing to be asked. Its number rather than
    /// ours: it is the one that knows what it costs.
    pub interval: u64,
}

/// How a sign-in is going.
///
/// "Denied" and "expired" are separate from an error on purpose. Neither is a
/// failure of the app — one is somebody changing their mind and the other is
/// somebody going to make tea — and both want their own sentence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum Waiting {
    Pending,
    Ready,
    Denied,
    Expired,
}

fn post(path: &str, body: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}{path}", base());
    let out = Command::new("curl")
        .args(["-s", "-m", "20", "-X", "POST", &url])
        .args(["-H", "Content-Type: application/json"])
        .args(["-H", "Accept: application/json"])
        .args(["--data", body])
        .output()
        .map_err(|e| format!("could not reach the gateway: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|_| {
        let said = String::from_utf8_lossy(&out.stdout);
        if said.trim().is_empty() {
            "the gateway did not answer".to_string()
        } else {
            format!(
                "unexpected reply: {}",
                said.chars().take(160).collect::<String>()
            )
        }
    })
}

/// Begin. Returns the code to show and the token to wait on.
#[tauri::command(async)]
pub fn gateway_sign_in() -> Result<Signin, String> {
    let reply = post("/device/code", "{}")?;
    let text = |name: &str| -> Result<String, String> {
        reply[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| format!("the gateway did not say {name}"))
    };
    Ok(Signin {
        code: text("code")?,
        verify_url: text("verify_url")?,
        token: text("token")?,
        // Defaults rather than errors: these only pace the waiting, and a
        // gateway that forgets to send them should not stop somebody signing
        // in. Fifteen minutes and three seconds are the usual ones.
        expires_in: reply["expires_in"].as_u64().unwrap_or(900),
        interval: reply["interval"].as_u64().unwrap_or(3).clamp(1, 30),
    })
}

/// Ask once whether they have finished.
///
/// The key is written straight to the keychain rather than handed back to the
/// window: it is a secret, the front end has no use for it, and the row that
/// wants to know is asking `has_key` — which is a boolean.
#[tauri::command(async)]
pub fn gateway_sign_in_poll(token: String) -> Result<Waiting, String> {
    let reply = post(
        "/device/poll",
        &serde_json::json!({ "token": token }).to_string(),
    )?;
    match reply["status"].as_str().unwrap_or("pending") {
        "ready" => {
            let key = reply["key"]
                .as_str()
                .filter(|key| !key.trim().is_empty())
                .ok_or("the gateway said ready and sent no key")?;
            // Through the catalogue rather than straight to the keychain: it
            // is the thing that decides what a provider's key is filed under,
            // and a second opinion here is a key nobody can find later.
            crate::catalogue::provider_key_set(ID.into(), key.into())?;
            Ok(Waiting::Ready)
        }
        "denied" => Ok(Waiting::Denied),
        "expired" => Ok(Waiting::Expired),
        _ => Ok(Waiting::Pending),
    }
}

/* ------------------------------------------------- the row in the list */

/// The one row botcage supplies for itself.
///
/// Shaped like every other provider on purpose: `inference.rs` sees an
/// OpenAI-shaped base URL and a key, and does not need to know whose it is.
/// The difference is only in how the key arrives — a sign-in rather than a
/// paste — and `env` is empty because there is no variable anybody sets. It is
/// ours; there is no documentation elsewhere to name.
pub fn provider() -> crate::catalogue::Provider {
    crate::catalogue::Provider {
        id: ID.into(),
        name: "botcage".into(),
        api: format!("{}/v1", base()),
        env: Vec::new(),
        doc: "https://github.com/hackyguru/botcage".into(),
        has_key: crate::catalogue::key_for(ID).is_some(),
        // Whatever the gateway is offering today. Curated rather than a
        // catalogue, so the number is small and it changes without a release.
        models: models("").len(),
        local: false,
    }
}

/// What the gateway offers, as the catalogue's own row type.
///
/// Asked of the gateway rather than kept in a list here, because the whole
/// point of choosing a handful over a passthrough is that the handful can
/// change — a name is a promise about what a model is for, and keeping that
/// promise sometimes means pointing it somewhere else. A build from March
/// should not be showing March's menu.
///
/// Without a key there is nothing to show. That is not a failure state: it is
/// a provider you have not signed into, and the row says so.
pub fn models(query: &str) -> Vec<crate::catalogue::Listing> {
    let Some(key) = crate::catalogue::key_for(ID) else {
        return Vec::new();
    };
    let out = Command::new("curl")
        .args(["-sS", "-m", "6", &format!("{}/v1/models", base())])
        .args(["-H", &format!("Authorization: Bearer {key}")])
        .output();
    let Ok(out) = out else {
        return Vec::new();
    };
    let Ok(body) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return Vec::new();
    };

    let needle = query.trim().to_lowercase();
    body["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model["id"].as_str()?.to_string();
                    let name = model["name"].as_str().unwrap_or(&id).to_string();
                    if !needle.is_empty()
                        && !id.to_lowercase().contains(&needle)
                        && !name.to_lowercase().contains(&needle)
                    {
                        return None;
                    }
                    Some(crate::catalogue::Listing {
                        provider: ID.into(),
                        provider_name: "botcage".into(),
                        context: model["context"].as_u64(),
                        // Dollars per million tokens, like every other row in
                        // this list. Credits are how the account is topped up;
                        // they are not a second unit for the price of a model,
                        // and putting one in a column that reads "$1.00/M"
                        // everywhere else would make ours the only prices
                        // nobody could compare.
                        cost_in: model["price_in"].as_f64(),
                        cost_out: model["price_out"].as_f64(),
                        tools: model["tools"].as_bool().unwrap_or(true),
                        reasoning: model["reasoning"].as_bool().unwrap_or(false),
                        ready: true,
                        name,
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
