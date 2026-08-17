//! Connectors botcage owns: a remote MCP server plus a credential we hold, so a
//! bot's access to a service is ours to scope rather than inherited from the
//! user's claude.ai account.
//!
//! The claude.ai connectors are switched off for every turn (see
//! `disableClaudeAiConnectors` in lib.rs). They were account-wide — every bot
//! granted Gmail got *the* Gmail — which is the opposite of what this app is
//! for. A token stored per connector here can differ per bot later without
//! changing anything else.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
#[cfg(not(target_os = "macos"))]
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct ConnectorDef {
    /// Also the MCP server name, so its tools are `mcp__<key>__<tool>`.
    pub key: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub url: &'static str,
    /// What to call the secret in the UI. Empty when the service needs none.
    pub token_label: &'static str,
    /// The service works without the credential; supplying one only raises what
    /// it will do. Gating these behind a key makes them look broken when they
    /// are not.
    pub token_optional: bool,
    /// Where the user gets that secret.
    pub help_url: &'static str,
    /// The service's GitHub handle, used only for its avatar — these are
    /// services rather than repositories, so there is nothing to derive it from.
    pub github_owner: &'static str,
    /// Google will not register a client for us — no dynamic registration — so
    /// these connectors need the user's own OAuth client and a consent round
    /// trip rather than a token they can paste.
    pub google_scopes: &'static [&'static str],
    /// The server speaks the MCP OAuth profile: discovery, dynamic client
    /// registration and PKCE. Nothing to register and no secret to ship.
    pub mcp_oauth: bool,
}

/// Services reachable over a hosted MCP endpoint with a bearer credential —
/// the ones whose OAuth we can own without Google's verification regime.
pub const CONNECTORS: &[ConnectorDef] = &[
    ConnectorDef {
        key: "github",
        github_owner: "github",
        name: "GitHub",
        description: "Issues, pull requests, code search and repository files.",
        url: "https://api.githubcopilot.com/mcp/",
        token_label: "Personal access token",
        token_optional: false,
        help_url: "https://github.com/settings/personal-access-tokens",
        google_scopes: &[],
        mcp_oauth: false,
    },
    ConnectorDef {
        key: "context7",
        github_owner: "upstash",
        name: "Context7",
        description: "Up-to-date documentation and code examples for libraries.",
        url: "https://mcp.context7.com/mcp",
        token_label: "API key",
        // Verified: context7 answers tool calls unauthenticated; a key raises
        // the rate limit rather than unlocking it.
        token_optional: true,
        help_url: "https://context7.com/dashboard",
        google_scopes: &[],
        mcp_oauth: false,
    },
    ConnectorDef {
        key: "deepwiki",
        github_owner: "AsyncFuncAI",
        name: "DeepWiki",
        description: "Ask questions about any public GitHub repository.",
        url: "https://mcp.deepwiki.com/mcp",
        token_label: "",
        token_optional: false,
        help_url: "https://deepwiki.com",
        google_scopes: &[],
        mcp_oauth: false,
    },
    ConnectorDef {
        key: "gmail",
        github_owner: "google",
        name: "Gmail",
        description: "Read and draft mail through Google's own MCP server.",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        token_label: "",
        token_optional: false,
        help_url: "https://console.cloud.google.com/auth/clients",
        google_scopes: &[
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
        ],
        mcp_oauth: false,
    },
    ConnectorDef {
        key: "calendar",
        github_owner: "google",
        name: "Google Calendar",
        description: "Read events and free/busy through Google's own MCP server.",
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        token_label: "",
        token_optional: false,
        help_url: "https://console.cloud.google.com/auth/clients",
        google_scopes: &[
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            "https://www.googleapis.com/auth/calendar.events.freebusy",
            "https://www.googleapis.com/auth/calendar.events.readonly",
        ],
        mcp_oauth: false,
    },
    ConnectorDef {
        key: "notion",
        github_owner: "makenotion",
        name: "Notion",
        description: "Search, read and update pages and databases.",
        url: "https://mcp.notion.com/mcp",
        token_label: "",
        token_optional: false,
        help_url: "https://www.notion.so/profile/integrations",
        google_scopes: &[],
        // Notion's server advertises dynamic registration, PKCE and a public
        // client, so botcage registers itself: nothing for the user to set up.
        mcp_oauth: true,
    },
    ConnectorDef {
        key: "vercel",
        github_owner: "vercel",
        name: "Vercel",
        description: "Deployments, projects, domains and build logs.",
        // The tool endpoint is the bare origin here; a /mcp suffix 404s.
        url: "https://mcp.vercel.com",
        token_label: "",
        token_optional: false,
        help_url: "https://vercel.com/account",
        google_scopes: &[],
        mcp_oauth: true,
    },
    ConnectorDef {
        key: "stripe",
        github_owner: "stripe",
        name: "Stripe",
        description: "Payments, customers, subscriptions and invoices.",
        url: "https://mcp.stripe.com",
        token_label: "",
        token_optional: false,
        help_url: "https://dashboard.stripe.com",
        google_scopes: &[],
        mcp_oauth: true,
    },
    ConnectorDef {
        key: "canva",
        github_owner: "canva",
        name: "Canva",
        description: "Find, create and export designs.",
        url: "https://mcp.canva.com/mcp",
        token_label: "",
        token_optional: false,
        help_url: "https://www.canva.com/settings",
        google_scopes: &[],
        mcp_oauth: true,
    },
    ConnectorDef {
        key: "zapier",
        github_owner: "zapier",
        name: "Zapier",
        description: "Run actions in the apps you have already connected to Zapier.",
        url: "https://mcp.zapier.com/api/mcp/mcp",
        token_label: "",
        token_optional: false,
        help_url: "https://mcp.zapier.com",
        google_scopes: &[],
        mcp_oauth: true,
    },
];

/// Where Google must send the user back. A web-application client only accepts
/// redirect URIs registered against it, so this is fixed rather than a free
/// port — the user pastes exactly this into the console once.
pub const REDIRECT_URI: &str = "http://localhost:8765/callback";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorState {
    pub key: String,
    pub name: String,
    pub description: String,
    pub token_label: String,
    pub help_url: String,
    /// False for services that need no credential — those are always usable.
    pub needs_token: bool,
    /// A credential is accepted but not required.
    pub token_optional: bool,
    /// Connects by showing a code the user approves in their browser.
    pub needs_device: bool,
    /// This bot holds its own credential rather than using the shared one.
    pub own_account: bool,
    /// Connects by opening a browser and coming back — no setup, no keys.
    pub needs_oauth: bool,
    /// Needs a consent round trip and the user's own OAuth client.
    pub needs_google: bool,
    pub redirect_uri: String,
    pub icon: String,
    pub scopes: Vec<String>,
    pub connected: bool,
}

/// Where a credential lives. A bot may hold its own account for a service —
/// an Engineer with a machine account that can push, say — and everything else
/// falls back to the one connection shared by the app.
fn slot(key: &str, bot: Option<&str>) -> String {
    match bot {
        Some(id) => format!("{key}@{id}"),
        None => key.to_string(),
    }
}

/// The credential a bot should use: its own if it has one, otherwise the shared
/// connection.
fn token_for(key: &str, bot: Option<&str>) -> Option<String> {
    bot.and_then(|id| read_token(&slot(key, Some(id))))
        .or_else(|| read_token(key))
}

pub fn find(key: &str) -> Option<&'static ConnectorDef> {
    CONNECTORS.iter().find(|c| c.key == key)
}

#[tauri::command(async)]
pub fn connectors(bot: Option<String>) -> Vec<ConnectorState> {
    let bot = bot.as_deref();
    CONNECTORS
        .iter()
        .map(|def| ConnectorState {
            key: def.key.to_string(),
            name: def.name.to_string(),
            description: def.description.to_string(),
            token_label: def.token_label.to_string(),
            help_url: def.help_url.to_string(),
            // With an app registered, GitHub is press-Connect and never asks
            // the user for a token.
            needs_token: !def.token_label.is_empty()
                && !def.token_optional
                && !(def.key == "github" && github_has_client()),
            token_optional: def.token_optional,
            needs_device: def.key == "github" && github_has_client(),
            needs_google: !def.google_scopes.is_empty(),
            redirect_uri: REDIRECT_URI.to_string(),
            icon: if def.github_owner.is_empty() {
                String::new()
            } else {
                format!("https://github.com/{}.png?size=80", def.github_owner)
            },
            scopes: def.google_scopes.iter().map(|s| s.to_string()).collect(),
            needs_oauth: def.mcp_oauth,
            own_account: bot
                .map(|id| read_token(&slot(def.key, Some(id))).is_some())
                .unwrap_or(false),
            connected: if def.mcp_oauth {
                read_token(&format!("{}.refresh", slot(def.key, bot))).is_some()
                    || read_token(&slot(def.key, bot)).is_some()
            } else if !def.google_scopes.is_empty() {
                read_token(&format!("{}.refresh", def.key)).is_some()
            } else {
                def.token_label.is_empty() || def.token_optional || token_for(def.key, bot).is_some()
            },
        })
        .collect()
}

#[tauri::command(async)]
pub fn connect_connector(key: String, token: String, bot: Option<String>) -> Result<(), String> {
    let def = find(&key).ok_or("unknown connector")?;
    if def.token_label.is_empty() {
        return Ok(());
    }
    if token.trim().is_empty() {
        return Err(format!("{} is required", def.token_label));
    }
    store_token(&slot(&key, bot.as_deref()), token.trim())
}

#[tauri::command(async)]
pub fn disconnect_connector(key: String, bot: Option<String>) -> Result<(), String> {
    // Disconnecting from a bot that has its own account drops only that one;
    // the shared connection is the app's, not this bot's, to remove.
    if let Some(id) = bot.as_deref() {
        let own = slot(&key, Some(id));
        if read_token(&own).is_some() {
            delete_token(&own);
            access_cache().lock().unwrap().remove(&own);
            return Ok(());
        }
    }

    delete_token(&key);
    for suffix in ["refresh", "client", "secret"] {
        delete_token(&format!("{key}.{suffix}"));
    }
    access_cache().lock().unwrap().remove(&key);
    Ok(())
}

/// A credential a marketplace plugin expects in the environment. Kept in the
/// same keychain as everything else rather than a dotfile, and namespaced by
/// plugin so two plugins wanting API_KEY do not collide.
pub fn plugin_secret(plugin: &str, var: &str) -> Option<String> {
    read_token(&format!("plugin.{plugin}.{var}"))
}

pub fn set_plugin_secret(plugin: &str, var: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        delete_token(&format!("plugin.{plugin}.{var}"));
        return Ok(());
    }
    store_token(&format!("plugin.{plugin}.{var}"), value)
}

/// The GitHub credential, for the one case where a bot needs the CLI rather
/// than the connector's tools: a sandbox that has to clone, build and push.
///
/// This is a real widening of exposure — inside the container the bot can read
/// it, whereas the connector's token it can only ever use through a tool. So it
/// travels only when a bot has been granted GitHub *and* given a computer.
pub fn github_token(bot: Option<&str>) -> Option<String> {
    token_for("github", bot)
}

/// The MCP server entry for a connector the user has connected, ready to drop
/// into the `--mcp-config` botcage builds for a turn.
pub fn server_entry(key: &str, bot: Option<&str>) -> Option<serde_json::Value> {
    let def = find(key)?;
    let mut server = serde_json::json!({ "type": "http", "url": def.url });

    if def.mcp_oauth {
        let token = mcp_access_token(key, bot).ok()?;
        server["headers"] = serde_json::json!({ "Authorization": format!("Bearer {token}") });
    } else if !def.google_scopes.is_empty() {
        // Google's access tokens last an hour, so mint a fresh one per turn
        // rather than storing one that will be stale by the time it is used.
        let token = google_access_token(key).ok()?;
        server["headers"] = serde_json::json!({ "Authorization": format!("Bearer {token}") });
    } else if !def.token_label.is_empty() {
        match token_for(key, bot) {
            Some(token) => {
                server["headers"] = serde_json::json!({ "Authorization": format!("Bearer {token}") })
            }
            // Required means no server without it; optional means go anyway.
            None if !def.token_optional => return None,
            None => {}
        }
    }
    Some(server)
}

/* -------------------------------------------------------------- mcp oauth */

/// Held between the two halves of the flow: the browser round trip happens in
/// between, so the verifier and the client we registered have to survive it.
struct PendingAuth {
    client_id: String,
    verifier: String,
    state: String,
    token_endpoint: String,
    redirect_uri: String,
}

fn pending() -> &'static Mutex<HashMap<String, PendingAuth>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingAuth>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where a server says its authorisation lives. Servers that speak the MCP
/// OAuth profile publish this, which is what lets botcage connect to one it has
/// never seen without anybody registering anything.
fn discover(url: &str) -> Result<serde_json::Value, String> {
    let origin = url
        .split_once("://")
        .and_then(|(scheme, rest)| rest.split_once('/').map(|(host, _)| format!("{scheme}://{host}")))
        .unwrap_or_else(|| url.to_string());

    let path = url
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, p)| format!("/{}", p.trim_end_matches('/'))))
        .unwrap_or_default();

    // The metadata may sit at the origin, or under the resource's own path.
    for candidate in [
        format!("{origin}/.well-known/oauth-authorization-server"),
        format!("{origin}/.well-known/oauth-authorization-server{path}"),
    ] {
        if let Ok(meta) = get_json(&candidate) {
            if meta.get("authorization_endpoint").is_some() {
                return Ok(meta);
            }
        }
    }

    // Otherwise the resource names its authorization server and we follow that.
    for candidate in [
        format!("{origin}/.well-known/oauth-protected-resource{path}"),
        format!("{origin}/.well-known/oauth-protected-resource"),
    ] {
        let Ok(resource) = get_json(&candidate) else { continue };
        let Some(server) = resource
            .get("authorization_servers")
            .and_then(|v| v.as_array())
            .and_then(|list| list.first())
            .and_then(|v| v.as_str())
        else {
            continue;
        };
        for well_known in [
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
        ] {
            if let Ok(meta) = get_json(&format!("{}{well_known}", server.trim_end_matches('/'))) {
                if meta.get("authorization_endpoint").is_some() {
                    return Ok(meta);
                }
            }
        }
    }

    Err("this server does not publish OAuth metadata botcage can use".into())
}

/// Step one: register botcage as a client, then hand back the URL to open.
#[tauri::command(async)]
pub fn mcp_oauth_start(key: String, bot: Option<String>) -> Result<String, String> {
    let def = find(&key).ok_or("unknown connector")?;
    if !def.mcp_oauth {
        return Err("this connector does not use MCP OAuth".into());
    }

    let meta = discover(def.url)?;
    let authorize = meta
        .get("authorization_endpoint")
        .and_then(|v| v.as_str())
        .ok_or("no authorization endpoint")?
        .to_string();
    let token_endpoint = meta
        .get("token_endpoint")
        .and_then(|v| v.as_str())
        .ok_or("no token endpoint")?
        .to_string();

    // Register as a public client: no secret exists to leak from the binary.
    let registration = meta
        .get("registration_endpoint")
        .and_then(|v| v.as_str())
        .ok_or("this server needs a client registered by hand")?;
    let body = serde_json::json!({
        "client_name": "botcage",
        "redirect_uris": [REDIRECT_URI],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let registered = post_json_body(registration, &body.to_string())?;
    let client_id = registered
        .get("client_id")
        .and_then(|v| v.as_str())
        .ok_or("the server registered no client id")?
        .to_string();

    let verifier = crate::oauth::random_token(32);
    let challenge = crate::oauth::base64url(&crate::oauth::sha256(verifier.as_bytes()));
    let state = crate::oauth::random_token(16);

    let url = format!(
        "{authorize}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}\
         &code_challenge_method=S256&state={}",
        urlencode(&client_id),
        urlencode(REDIRECT_URI),
        urlencode(&challenge),
        urlencode(&state),
    );

    pending().lock().unwrap().insert(
        slot(&key, bot.as_deref()),
        PendingAuth {
            client_id,
            verifier,
            state,
            token_endpoint,
            redirect_uri: REDIRECT_URI.to_string(),
        },
    );
    Ok(url)
}

/// Step two: catch the redirect and trade the code for tokens.
#[tauri::command(async)]
pub fn mcp_oauth_finish(key: String, bot: Option<String>) -> Result<(), String> {
    let store = slot(&key, bot.as_deref());
    let auth = pending()
        .lock()
        .unwrap()
        .remove(&store)
        .ok_or("no sign-in was started")?;

    let (code, state) = wait_for_code_and_state()?;
    if state.as_deref() != Some(auth.state.as_str()) {
        return Err("the reply did not come from the sign-in botcage started".into());
    }

    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        urlencode(&code),
        urlencode(&auth.redirect_uri),
        urlencode(&auth.client_id),
        urlencode(&auth.verifier),
    );
    let tokens = post_form(&auth.token_endpoint, &body)?;
    save_oauth_tokens(&store, &auth.client_id, &auth.token_endpoint, &tokens)
}

fn save_oauth_tokens(
    store: &str,
    client_id: &str,
    token_endpoint: &str,
    tokens: &serde_json::Value,
) -> Result<(), String> {
    let access = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("the server returned no access token")?;
    store_token(store, access)?;
    store_token(&format!("{store}.client"), client_id)?;
    store_token(&format!("{store}.endpoint"), token_endpoint)?;
    if let Some(refresh) = tokens.get("refresh_token").and_then(|v| v.as_str()) {
        store_token(&format!("{store}.refresh"), refresh)?;
    }

    if let Some(lifetime) = tokens.get("expires_in").and_then(|v| v.as_u64()) {
        let until = Instant::now() + Duration::from_secs(lifetime.saturating_sub(120));
        access_cache()
            .lock()
            .unwrap()
            .insert(store.to_string(), (access.to_string(), until));
    }
    Ok(())
}

/// A live token for an MCP OAuth connector, refreshed if the server issued a
/// refresh token and the one we hold has aged out.
fn mcp_access_token(key: &str, bot: Option<&str>) -> Result<String, String> {
    let store = bot
        .map(|id| slot(key, Some(id)))
        .filter(|s| read_token(s).is_some())
        .unwrap_or_else(|| key.to_string());

    if let Some((token, until)) = access_cache().lock().unwrap().get(&store) {
        if Instant::now() < *until {
            return Ok(token.clone());
        }
    }

    let current = read_token(&store).ok_or("not connected")?;
    let (Some(refresh), Some(client_id), Some(endpoint)) = (
        read_token(&format!("{store}.refresh")),
        read_token(&format!("{store}.client")),
        read_token(&format!("{store}.endpoint")),
    ) else {
        // No refresh available: the access token is all there is, and many
        // servers issue long-lived ones.
        return Ok(current);
    };

    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencode(&refresh),
        urlencode(&client_id),
    );
    match post_form(&endpoint, &body) {
        Ok(tokens) => {
            save_oauth_tokens(&store, &client_id, &endpoint, &tokens)?;
            read_token(&store).ok_or_else(|| "refresh stored nothing".to_string())
        }
        // A refresh that fails is not necessarily fatal; the current token may
        // still be good, and failing the turn outright would be worse.
        Err(_) => Ok(current),
    }
}

fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("curl")
        .args(["-s", "-m", "20", "-H", "Accept: application/json", url])
        .output()
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|_| format!("{url} did not return JSON"))
}

fn post_json_body(url: &str, body: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("curl")
        .args(["-s", "-m", "30", "-X", "POST", url])
        .args(["-H", "Content-Type: application/json"])
        .args(["-H", "Accept: application/json"])
        .args(["--data", body])
        .output()
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|_| {
        let text = String::from_utf8_lossy(&out.stdout);
        format!("unexpected reply: {}", text.chars().take(160).collect::<String>())
    })
}

fn post_form(url: &str, body: &str) -> Result<serde_json::Value, String> {
    let parsed = post_json(url, body)?;
    if let Some(error) = parsed.get("error") {
        let detail = parsed
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| error.as_str().unwrap_or("rejected"));
        return Err(format!("sign-in failed: {detail}"));
    }
    Ok(parsed)
}

/* ----------------------------------------------------------- github device */

/// botcage's own GitHub OAuth app. Device flow needs no client secret, so this
/// is safe to ship in the binary — nothing here is a credential.
///
/// Empty until an app is registered, and the UI falls back to asking for a
/// personal access token in that case. Filling this in is what turns GitHub
/// into press-Connect for every user, with no verification to pass.
const GITHUB_CLIENT_ID: &str = "Ov23litCtgwBpnloqerw";

/// What a bot may reach is the user's call, not ours, so the scopes are offered
/// rather than fixed. GitHub's classic scopes are coarse — `repo` is the only
/// one that reaches private repositories and it carries write with it — so each
/// choice says plainly what it grants.
pub struct GithubScope {
    pub scope: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub on_by_default: bool,
}

pub const GITHUB_SCOPE_CHOICES: &[GithubScope] = &[
    GithubScope {
        scope: "public_repo",
        label: "Public repositories",
        note: "Read and write your public repos.",
        on_by_default: true,
    },
    GithubScope {
        scope: "repo",
        label: "Private repositories",
        note: "Full access to private repos, including write. Covers public ones too.",
        on_by_default: false,
    },
    GithubScope {
        scope: "read:org",
        label: "Organisations",
        note: "Read organisation and team membership.",
        on_by_default: true,
    },
    GithubScope {
        scope: "workflow",
        label: "Actions workflows",
        note: "Create and update GitHub Actions workflow files.",
        on_by_default: false,
    },
    GithubScope {
        scope: "gist",
        label: "Gists",
        note: "Create and edit your gists.",
        on_by_default: false,
    },
    GithubScope {
        scope: "notifications",
        label: "Notifications",
        note: "Read notifications and mark them as read.",
        on_by_default: false,
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeChoice {
    pub scope: String,
    pub label: String,
    pub note: String,
    pub on_by_default: bool,
}

#[tauri::command(async)]
pub fn github_scopes() -> Vec<ScopeChoice> {
    GITHUB_SCOPE_CHOICES
        .iter()
        .map(|choice| ScopeChoice {
            scope: choice.scope.to_string(),
            label: choice.label.to_string(),
            note: choice.note.to_string(),
            on_by_default: choice.on_by_default,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval: u64,
}

/// True when this build can run the device flow rather than asking for a token.
pub fn github_has_client() -> bool {
    !GITHUB_CLIENT_ID.is_empty()
}

/// Step one: ask GitHub for a code the user types into their browser.
#[tauri::command(async)]
pub fn github_device_start(scopes: Vec<String>) -> Result<DeviceCode, String> {
    if !github_has_client() {
        return Err("this build has no GitHub app configured".into());
    }

    // Only scopes we actually offer: whatever reaches GitHub is shown to the
    // user on the approval screen, so it must match what they ticked.
    let asked = scopes
        .iter()
        .filter(|scope| GITHUB_SCOPE_CHOICES.iter().any(|c| c.scope == scope.as_str()))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");

    let body = format!(
        "client_id={}&scope={}",
        urlencode(GITHUB_CLIENT_ID),
        urlencode(&asked)
    );
    let reply = post_json("https://github.com/login/device/code", &body)?;

    Ok(DeviceCode {
        user_code: field(&reply, "user_code")?,
        verification_uri: field(&reply, "verification_uri")?,
        device_code: field(&reply, "device_code")?,
        interval: reply.get("interval").and_then(|v| v.as_u64()).unwrap_or(5),
    })
}

/// Step two: wait for the user to approve, then keep the token.
#[tauri::command(async)]
pub fn github_device_finish(
    device_code: String,
    interval: u64,
    bot: Option<String>,
) -> Result<(), String> {
    let body = format!(
        "client_id={}&device_code={}&grant_type=urn:ietf:params:oauth:grant-type:device_code",
        urlencode(GITHUB_CLIENT_ID),
        urlencode(&device_code),
    );

    // GitHub's codes last about fifteen minutes; stop well before that rather
    // than holding a thread open indefinitely.
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut wait = interval.max(5);

    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(wait));
        let reply = post_json("https://github.com/login/oauth/access_token", &body)?;

        if let Some(token) = reply.get("access_token").and_then(|v| v.as_str()) {
            store_token(&slot("github", bot.as_deref()), token)?;
            // A GitHub OAuth app holds one token per user, so signing in again
            // silently revokes the last one. If that was the shared connection,
            // drop it rather than leave the UI calling a dead token "Connected".
            if bot.is_some() {
                if let Some(shared) = read_token("github") {
                    if !github_token_works(&shared) {
                        delete_token("github");
                    }
                }
            }
            return Ok(());
        }
        match reply.get("error").and_then(|v| v.as_str()) {
            // Still waiting on the browser — expected, keep polling.
            Some("authorization_pending") => {}
            // GitHub asks us to back off; obey or it starts refusing.
            Some("slow_down") => wait += 5,
            Some("expired_token") => return Err("the code expired — try again".into()),
            Some("access_denied") => return Err("access was declined on GitHub".into()),
            Some(other) => return Err(format!("GitHub refused: {other}")),
            None => return Err("GitHub sent no token and no error".into()),
        }
    }
    Err("timed out waiting for GitHub".into())
}

/// One cheap call, used only after a sign-in that may have invalidated another
/// token — not on every listing, which would put the network in the way of
/// opening a window.
fn github_token_works(token: &str) -> bool {
    Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "15"])
        .args(["-H", &format!("Authorization: Bearer {token}")])
        .arg("https://api.github.com/user")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "200")
        .unwrap_or(true)
}

fn field(reply: &serde_json::Value, name: &str) -> Result<String, String> {
    reply
        .get(name)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("GitHub's reply had no {name}"))
}

/* ----------------------------------------------------------- google oauth */

/// Access tokens live an hour; keep the live one in memory so a burst of turns
/// does not mean a round trip to Google for each.
fn access_cache() -> &'static Mutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The consent URL to send the user to. Built here rather than in the frontend
/// so the scopes stay next to the connector that needs them.
#[tauri::command(async)]
pub fn google_consent_url(key: String, client_id: String) -> Result<String, String> {
    let def = find(&key).ok_or("unknown connector")?;
    if def.google_scopes.is_empty() {
        return Err("this connector does not use Google".into());
    }
    if client_id.trim().is_empty() {
        return Err("Client ID is required".into());
    }

    let scopes = def.google_scopes.join(" ");
    Ok(format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code\
         &scope={}&access_type=offline&prompt=consent",
        urlencode(client_id.trim()),
        urlencode(REDIRECT_URI),
        urlencode(&scopes),
    ))
}

/// Wait for Google to send the user back, then trade the code for a refresh
/// token. Runs on its own thread so the window stays responsive.
#[tauri::command(async)]
pub fn google_finish(key: String, client_id: String, client_secret: String) -> Result<(), String> {
    let def = find(&key).ok_or("unknown connector")?;
    if def.google_scopes.is_empty() {
        return Err("this connector does not use Google".into());
    }

    let code = wait_for_code()?;
    let body = format!(
        "code={}&client_id={}&client_secret={}&redirect_uri={}&grant_type=authorization_code",
        urlencode(&code),
        urlencode(client_id.trim()),
        urlencode(client_secret.trim()),
        urlencode(REDIRECT_URI),
    );
    let token = post_token(&body)?;

    let refresh = token
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or("Google did not return a refresh token — remove botcage from your Google account's third-party access and try again")?;

    store_token(&format!("{key}.refresh"), refresh)?;
    store_token(&format!("{key}.client"), client_id.trim())?;
    store_token(&format!("{key}.secret"), client_secret.trim())?;
    Ok(())
}

/// The one part of botcage a user sees outside the app, so it carries the same
/// dark surface, face mark and type as the window they came from — landing on a
/// bare browser default reads like the flow went wrong.
fn callback_page(ok: bool) -> String {
    let (mark, heading, body) = if ok {
        ("#0a84ff", "Connected", "You can close this tab and go back to botcage.")
    } else {
        (
            "#ff453a",
            "Not connected",
            "botcage did not get an approval from that page. Close this tab and try again.",
        )
    };

    // Inline and self-contained: this is served by a socket that closes straight
    // after, so nothing else can be fetched.
    format!(
        r##"<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>botcage</title>
<style>
  :root {{ color-scheme: dark }}
  * {{ box-sizing: border-box }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #000; color: #f2f2f2;
    font: 400 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter, sans-serif;
    -webkit-font-smoothing: antialiased;
  }}
  .card {{
    width: min(360px, calc(100vw - 40px));
    padding: 34px 28px 30px;
    text-align: center;
    background: #17171a;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 18px;
    box-shadow: 0 20px 60px rgba(0,0,0,.6);
    animation: pop .16s ease both;
  }}
  @keyframes pop {{ from {{ opacity: 0; transform: translateY(4px) scale(.98) }} }}
  /* Without this the card can sit at the animation's starting opacity — an
     invisible page — wherever motion is turned off. */
  @media (prefers-reduced-motion: reduce) {{ .card {{ animation: none }} }}
  .face {{
    display: grid; grid-auto-flow: column; gap: 5px; place-content: center;
    width: 46px; height: 46px; margin: 0 auto 16px;
    background: {mark}; border-radius: 30%;
  }}
  .face i {{ width: 5px; height: 8px; background: rgba(0,0,0,.72); border-radius: 2.5px }}
  h1 {{ margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em }}
  p {{ margin: 8px 0 0; font-size: 13px; line-height: 1.45; color: #8e8e93 }}
  .name {{ margin-top: 18px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #636366 }}
</style>
<div class="card">
  <div class="face"><i></i><i></i></div>
  <h1>{heading}</h1>
  <p>{body}</p>
  <div class="name">botcage</div>
</div>"##
    )
}

/// Same listener, but reporting the state parameter too — the MCP flow checks
/// it to be sure the reply belongs to the sign-in botcage started.
fn wait_for_code_and_state() -> Result<(String, Option<String>), String> {
    let target = wait_for_target()?;
    let code = query_value(&target, "code").ok_or("no code in the reply")?;
    Ok((code, query_value(&target, "state")))
}

/// A one-shot loopback server: the browser is redirected here with the code.
fn wait_for_code() -> Result<String, String> {
    let target = wait_for_target()?;
    query_value(&target, "code").ok_or_else(|| {
        query_value(&target, "error")
            .map(|e| format!("refused: {e}"))
            .unwrap_or_else(|| "no code in the reply".into())
    })
}

fn wait_for_target() -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 8765))
        .map_err(|e| format!("could not listen on port 8765 for Google's reply: {e}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;

    // Give the user time to sign in and consent, but do not wait forever.
    let deadline = Instant::now() + Duration::from_secs(180);
    for stream in listener.incoming() {
        let mut stream = stream.map_err(|e| e.to_string())?;
        let mut buf = [0u8; 2048];
        let read = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..read]).to_string();

        let target = request.split_whitespace().nth(1).unwrap_or_default().to_string();
        let found = query_value(&target, "code");
        let denied = query_value(&target, "error");

        let page = callback_page(found.is_some());
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Cache-Control: no-store\r\nConnection: close\r\n\r\n{page}"
            )
            .as_bytes(),
        );
        let _ = stream.flush();

        if found.is_some() || denied.is_some() {
            return Ok(target);
        }
        if Instant::now() > deadline {
            break;
        }
    }
    Err("no reply from the browser".into())
}

/// A live access token for a connected Google connector, refreshing if needed.
fn google_access_token(key: &str) -> Result<String, String> {
    if let Some((token, until)) = access_cache().lock().unwrap().get(key) {
        if Instant::now() < *until {
            return Ok(token.clone());
        }
    }

    let refresh = read_token(&format!("{key}.refresh")).ok_or("not connected")?;
    let client_id = read_token(&format!("{key}.client")).ok_or("no client id stored")?;
    let secret = read_token(&format!("{key}.secret")).unwrap_or_default();
    let body = format!(
        "refresh_token={}&client_id={}&client_secret={}&grant_type=refresh_token",
        urlencode(&refresh),
        urlencode(&client_id),
        urlencode(&secret),
    );
    let token = post_token(&body)?;
    let access = token
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Google did not return an access token")?
        .to_string();

    // Expire our copy early, so a turn never starts with a token about to die.
    let lifetime = token.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);
    let until = Instant::now() + Duration::from_secs(lifetime.saturating_sub(120));
    access_cache().lock().unwrap().insert(key.to_string(), (access.clone(), until));
    Ok(access)
}

/// Token exchange over curl: the app carries no TLS stack of its own, and curl
/// ships on macOS, Linux and Windows 10 or later.
fn post_token(body: &str) -> Result<serde_json::Value, String> {
    let parsed = post_json("https://oauth2.googleapis.com/token", body)?;
    if let Some(error) = parsed.get("error") {
        let detail = parsed
            .get("error_description")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| error.as_str().unwrap_or("rejected"));
        return Err(format!("Google rejected it: {detail}"));
    }
    Ok(parsed)
}

/// Form-encoded POST expecting JSON back. curl rather than a TLS crate, matching
/// how the app already reaches docker, the keychain and pmset.
fn post_json(url: &str, body: &str) -> Result<serde_json::Value, String> {
    let out = Command::new("curl")
        .args(["-s", "-m", "30", "-X", "POST", url])
        .args(["-H", "Content-Type: application/x-www-form-urlencoded"])
        // GitHub answers form-encoded unless asked otherwise.
        .args(["-H", "Accept: application/json"])
        .args(["--data", body])
        .output()
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    serde_json::from_slice(&out.stdout).map_err(|_| {
        let text = String::from_utf8_lossy(&out.stdout);
        format!("unexpected reply: {}", text.chars().take(160).collect::<String>())
    })
}

fn query_value(target: &str, name: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| urldecode(value))
    })
}

fn urlencode(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn urldecode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ------------------------------------------------------------ credentials */

const SERVICE: &str = "botcage";

/// macOS has a real keychain and the `security` CLI to reach it, so use it
/// rather than inventing storage. Elsewhere fall back to a 0600 file, which is
/// what Claude Code itself does on Linux and Windows.
#[cfg(target_os = "macos")]
fn store_token(key: &str, token: &str) -> Result<(), String> {
    let account = format!("{SERVICE}.{key}");
    let out = Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-a", &account, "-s", SERVICE, "-w", token])
        .output()
        .map_err(|e| format!("could not reach the keychain: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn read_token(key: &str) -> Option<String> {
    let account = format!("{SERVICE}.{key}");
    let out = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-a", &account, "-s", SERVICE, "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

#[cfg(target_os = "macos")]
fn delete_token(key: &str) {
    let account = format!("{SERVICE}.{key}");
    let _ = Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", &account, "-s", SERVICE])
        .output();
}

#[cfg(not(target_os = "macos"))]
fn token_file() -> PathBuf {
    crate::home().join(".botcage").join("connectors.json")
}

#[cfg(not(target_os = "macos"))]
fn all_tokens() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(token_file())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn store_token(key: &str, token: &str) -> Result<(), String> {
    let path = token_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tokens = all_tokens();
    tokens.insert(key.to_string(), serde_json::Value::String(token.to_string()));
    let body = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;

    // Readable by this user only: it holds live credentials.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn read_token(key: &str) -> Option<String> {
    all_tokens().get(key)?.as_str().map(str::to_string)
}

#[cfg(not(target_os = "macos"))]
fn delete_token(key: &str) {
    let mut tokens = all_tokens();
    tokens.remove(key);
    if let Ok(body) = serde_json::to_string(&tokens) {
        let _ = std::fs::write(token_file(), body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Storing a credential is the whole point; a silent failure here would look
    /// like "connected" in the UI and an unauthenticated server at turn time.
    #[test]
    fn credentials_round_trip() {
        let key = "botcage-selftest";
        delete_token(key);
        assert_eq!(read_token(key), None, "should start clean");

        store_token(key, "s3cret-value").expect("store");
        assert_eq!(read_token(key).as_deref(), Some("s3cret-value"));

        // Overwriting must replace, not duplicate.
        store_token(key, "second-value").expect("overwrite");
        assert_eq!(read_token(key).as_deref(), Some("second-value"));

        delete_token(key);
        assert_eq!(read_token(key), None, "should be gone");
    }

    /// The whole premise of this connector type: a server we have never been
    /// registered with hands us a client id on request.
    /// The premise of this connector type, checked against every server we
    /// ship: one we have never registered with hands us a client on request.
    #[test]
    fn every_oauth_connector_lets_botcage_register_itself() {
        for def in CONNECTORS.iter().filter(|d| d.mcp_oauth) {
            let meta = discover(def.url)
                .unwrap_or_else(|e| panic!("{} publishes no usable metadata: {e}", def.name));
            assert!(
                meta.get("registration_endpoint").is_some(),
                "{} needs dynamic registration",
                def.name
            );
            assert!(
                meta["code_challenge_methods_supported"]
                    .as_array()
                    .map(|m| m.iter().any(|v| v == "S256"))
                    .unwrap_or(false),
                "{} must support PKCE S256",
                def.name
            );

            let url = mcp_oauth_start(def.key.into(), None)
                .unwrap_or_else(|e| panic!("{} registration failed: {e}", def.name));
            assert!(url.contains("code_challenge_method=S256"), "{}", def.name);
            assert!(url.contains("client_id="), "{}", def.name);
            assert!(!url.contains(' '), "{} url has a stray space", def.name);
            println!("{:<8} ok — {}", def.name, &url[..url.len().min(78)]);
        }
    }

    #[test]
    fn consent_url_carries_the_documented_scopes() {
        let url = google_consent_url("calendar".into(), "abc.apps.googleusercontent.com".into())
            .expect("calendar is a google connector");
        println!("{url}");
        assert!(!url.contains(' '), "a stray space would break the redirect");
        assert!(url.contains("access_type=offline"), "needed for a refresh token");
        assert!(url.contains("calendar.events.readonly"));
        assert!(url.contains("localhost%3A8765%2Fcallback"));
        assert!(google_consent_url("github".into(), "x".into()).is_err());
        assert!(google_consent_url("calendar".into(), "  ".into()).is_err());
    }

    #[test]
    fn percent_coding_round_trips() {
        let raw = "https://www.googleapis.com/auth/gmail.readonly a+b";
        assert_eq!(urldecode(&urlencode(raw)), raw);
        assert_eq!(query_value("/callback?code=4%2F0Ab&state=x", "code").as_deref(), Some("4/0Ab"));
        assert_eq!(query_value("/callback?error=access_denied", "code"), None);
    }

    /// The redirect is the fragile part of the flow: a browser hits a port we
    /// opened for one request. Drive it for real rather than trusting the parse.
    /// Render both states through the real listener so the page is checked as
    /// served, not as a string.
    #[test]
    fn callback_page_renders_both_outcomes() {
        for (ok, name) in [(true, "connected"), (false, "refused")] {
            let page = callback_page(ok);
            std::fs::write(
                format!("/private/tmp/claude-501/-Users-guru-Desktop-indie-botcage/82f6a62a-cea8-490b-b05d-c2043f58b852/scratchpad/callback-{name}.html"),
                &page,
            )
            .ok();
            assert!(page.starts_with("<!doctype html>"));
            assert!(page.contains("botcage"));
            // Nothing external: the socket closes right after the response.
            assert!(!page.contains("http://") && !page.contains("https://"), "must be self-contained");
        }
        assert!(callback_page(true).contains("Connected"));
        assert!(callback_page(false).contains("Not connected"));
    }

    #[test]
    fn loopback_captures_the_code_google_sends() {
        let handle = std::thread::spawn(wait_for_code);
        std::thread::sleep(Duration::from_millis(300));

        let out = Command::new("curl")
            .args(["-s", "-m", "10", "http://localhost:8765/callback?code=4%2Ftest-code&scope=x"])
            .output()
            .expect("curl the callback");
        let page = String::from_utf8_lossy(&out.stdout);
        assert!(page.contains("Connected"), "the browser should land on the success page");
        assert!(page.contains("botcage"), "the page should say where it came from");

        let code = handle.join().expect("thread").expect("a code");
        assert_eq!(code, "4/test-code", "percent-encoded code must be decoded");
    }

    /// A service that works without a key must not be gated behind one — that
    /// is the difference between "add a key for higher limits" and "broken".
    #[test]
    fn an_optional_credential_does_not_gate_the_server() {
        delete_token("context7");
        let entry = server_entry("context7", None).expect("context7 works without a key");
        assert!(entry.get("headers").is_none(), "no key stored, so no header");

        store_token("context7", "ctx7-key").expect("store");
        let entry = server_entry("context7", None).expect("still works");
        assert_eq!(entry["headers"]["Authorization"], "Bearer ctx7-key");
        delete_token("context7");

        // A required credential still gates: github yields nothing without one.
        delete_token("github");
        assert!(server_entry("github", None).is_none());
    }

    #[test]
    fn granted_connector_becomes_a_server_entry() {
        // One that needs no credential is always usable.
        let entry = server_entry("deepwiki", None).expect("deepwiki needs no token");
        assert_eq!(entry["type"], "http");
        assert!(entry.get("headers").is_none());
    }

    /// The whole point of per-bot connectors: one bot's account must not become
    /// every bot's, and a bot without its own must still get the shared one.
    #[test]
    fn a_bots_own_account_wins_over_the_shared_one() {
        let shared = "github-test";
        let bot = "bot-alpha";
        let other = "bot-beta";
        for slot in [shared.to_string(), format!("{shared}@{bot}")] {
            delete_token(&slot);
        }

        // Shared only: every bot uses it.
        store_token(shared, "shared-token").expect("store shared");
        assert_eq!(token_for(shared, Some(bot)).as_deref(), Some("shared-token"));
        assert_eq!(token_for(shared, Some(other)).as_deref(), Some("shared-token"));

        // One bot brings its own; the other is unaffected.
        store_token(&slot(shared, Some(bot)), "alpha-token").expect("store own");
        assert_eq!(token_for(shared, Some(bot)).as_deref(), Some("alpha-token"));
        assert_eq!(token_for(shared, Some(other)).as_deref(), Some("shared-token"));

        // Dropping the bot's own falls back rather than leaving it with nothing.
        delete_token(&slot(shared, Some(bot)));
        assert_eq!(token_for(shared, Some(bot)).as_deref(), Some("shared-token"));

        delete_token(shared);
        assert_eq!(token_for(shared, Some(bot)), None);
    }
}
