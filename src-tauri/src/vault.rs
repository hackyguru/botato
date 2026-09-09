//! A bot's own credentials — the ones it needs to log into something.
//!
//! Not the same thing as the keys in `connectors.rs`. Those are botato's: an
//! API key for a model provider, an OAuth token for a connector, held by the
//! app and handed to a server as a header. The bot never sees them and has no
//! reason to. This is the other kind — the password to the thing a bot is
//! meant to be using on its own desktop — and until now a bot that acquired
//! one had nowhere to put it but a file in its workspace, in plain text.
//!
//! ## The bot can spend a credential; it cannot read one
//!
//! This is the whole design, and it is worth being precise about why, because
//! "encrypted keystore" sounds like the answer and mostly is not.
//!
//! Encryption at rest protects against somebody with the disk: a stolen
//! laptop, a backup, another account on the machine. It does nothing at all
//! against the threat that actually exists here, which is that the thing
//! holding the secret is a language model with tools. A password in a model's
//! context can be talked out of it by a web page the bot is reading, and it is
//! written into the transcript on the way past. Encrypting the file it came
//! from changes none of that.
//!
//! So the secret never enters the conversation. `use_credential` looks the
//! value up on this side, types it into whatever has focus on that bot's
//! desktop, and answers "done". The model learns that a credential called
//! "grafana" exists and that it was typed. It does not learn what it is, which
//! means it cannot leak what it is — not to a prompt injection, not into a
//! transcript, not into a screenshot of its own chat.
//!
//! Reading one back into the model is deliberately not offered. If a case ever
//! genuinely needs it, that should be its own switch, off by default, rather
//! than a capability every bot quietly has.
//!
//! ## Scope
//!
//! Filed per bot. A name in one bot's vault means nothing in another's, so
//! handing a bot a credential is not handing it to the roster. They go through
//! `connectors`' store, which is the login keychain on macOS and the Secret
//! Service on Linux — one place that already knows how to keep a secret, not a
//! second one invented here.

use serde::Serialize;

/// Where one bot's credential is filed. The bot id is in the key rather than
/// in a list, so there is no index to keep in step and no way to read a name
/// out of one bot's vault while holding another's.
fn slot(bot: &str, name: &str) -> String {
    format!("vault.{bot}.{name}")
}

/// The names a bot has, kept beside the secrets rather than derived from them.
///
/// A keychain can look a secret up but not enumerate ours, so the list of
/// names is its own entry. Names only: knowing that "grafana" exists is what
/// lets a bot decide to use it, and is worth nothing to anybody who learns it.
fn index_slot(bot: &str) -> String {
    format!("vault.{bot}.__names")
}

fn names(bot: &str) -> Vec<String> {
    crate::connectors::read_secret(&index_slot(bot))
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn set_names(bot: &str, list: &[String]) {
    if let Ok(body) = serde_json::to_string(list) {
        let _ = crate::connectors::write_secret(&index_slot(bot), &body);
    }
}

/// A credential's name, and nothing else about it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub name: String,
}

/// What this bot has. Names only, deliberately — there is no path in this
/// module that returns a secret to anything but the keyboard of that bot's
/// own desktop.
pub fn list(bot: &str) -> Vec<Credential> {
    names(bot)
        .into_iter()
        .map(|name| Credential { name })
        .collect()
}

/// Put one in, or replace it.
pub fn put(bot: &str, name: &str, secret: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a credential needs a name".into());
    }
    if name.starts_with("__") {
        return Err("names starting with __ are reserved".into());
    }
    if secret.is_empty() {
        return Err("a credential needs a value".into());
    }
    crate::connectors::write_secret(&slot(bot, name), secret)?;
    let mut list = names(bot);
    if !list.iter().any(|held| held == name) {
        list.push(name.to_string());
        set_names(bot, &list);
    }
    Ok(())
}

/// Take one out. The secret goes first: an index entry with no secret behind
/// it is a name that does nothing, which is untidy, and a secret with no index
/// entry is a credential nobody can see but everybody still has.
pub fn forget(bot: &str, name: &str) {
    crate::connectors::forget_secret(&slot(bot, name));
    let list: Vec<String> = names(bot).into_iter().filter(|held| held != name).collect();
    set_names(bot, &list);
}

/// The value, for the one caller that is allowed it.
///
/// Crate-private and it stays that way. The only thing that calls this is the
/// tool that types it into a desktop; nothing hands it to an engine, writes it
/// to a transcript, or returns it over the command boundary to the window.
pub(crate) fn secret(bot: &str, name: &str) -> Option<String> {
    crate::connectors::read_secret(&slot(bot, name))
}

/* ----------------------------------------------------------- the commands */

#[tauri::command(async)]
pub fn vault_list(bot_id: String) -> Vec<Credential> {
    list(&bot_id)
}

#[tauri::command(async)]
pub fn vault_put(bot_id: String, name: String, secret: String) -> Result<(), String> {
    put(&bot_id, &name, &secret)
}

#[tauri::command(async)]
pub fn vault_forget(bot_id: String, name: String) {
    forget(&bot_id, &name);
}
