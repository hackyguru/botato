//! Claude Code plugins: the marketplace botcage browses, and the MCP servers an
//! installed plugin contributes to a session.
//!
//! Services botcage connects itself live in `connectors.rs`. The claude.ai
//! connectors that used to appear here are switched off for every turn, so
//! discovery runs with the same setting — a server offered here that a bot
//! could not actually reach would be worse than not listing it.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Plugin {
    /// How Claude Code addresses this server's tools: `mcp__<key>__<tool>`.
    pub key: String,
    /// What the CLI calls it, e.g. "plugin:context7:context7".
    pub name: String,
    /// The CLI's own word for the connection: connected, pending, failed…
    pub status: String,
    /// From a claude.ai account rather than local config. Always false while
    /// those are disabled; kept so discovery can still recognise one if the
    /// setting is ever lifted.
    pub connector: bool,
}

/// Tool names replace anything outside this set with an underscore, so
/// "claude.ai Google Calendar" addresses as `mcp__claude_ai_Google_Calendar__*`.
fn key_of(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

/// One probe is enough now. The retry loop existed because claude.ai connectors
/// arrived asynchronously and `init` reported whatever had landed by then — but
/// those are switched off, and what remains comes from local plugin config,
/// which is there on the first attempt or not at all. Retrying just spent ~6s
/// discovering nothing, every time the user opened Plugins.
#[tauri::command(async)]
pub fn list_plugins(app: AppHandle) -> Result<Vec<Plugin>, String> {
    let found = probe_with_retries(1);
    if !found.is_empty() {
        let _ = save_cache(&app, &found);
        return Ok(found);
    }
    Ok(load_cache(&app).unwrap_or_default())
}

/// Kept parameterised: if a source of servers ever arrives asynchronously again,
/// the retry is one argument away.
fn probe_with_retries(attempts: u32) -> Vec<Plugin> {
    for attempt in 0..attempts {
        if let Ok(found) = probe_once() {
            if !found.is_empty() {
                return found;
            }
        }
        if attempt + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    }
    Vec::new()
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("plugins.json"))
}

fn save_cache(app: &AppHandle, found: &[Plugin]) -> Result<(), String> {
    let path = cache_path(app)?;
    let body = serde_json::to_string(found).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

fn load_cache(app: &AppHandle) -> Option<Vec<Plugin>> {
    let raw = std::fs::read_to_string(cache_path(app).ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// One discovery run. Claude Code announces its MCP servers in the `init`
/// message, emitted before the model is called, so reading that line and
/// killing the child costs no tokens.
fn probe_once() -> Result<Vec<Plugin>, String> {
    let bin = crate::locate_claude().ok_or("Claude Code CLI not found")?;

    // No --strict-mcp-config and no --mcp-config: this run is asking what the
    // environment offers, which is exactly what strict mode would suppress.
    let mut child = Command::new(bin)
        .arg("-p")
        .arg("ok")
        .arg("--verbose")
        .args(["--output-format", "stream-json"])
        .args(["--model", "sonnet"])
        // Match the turn: claude.ai connectors are off, so they must not show
        // up here as though a bot could be granted one.
        .args(["--settings", "{\"disableClaudeAiConnectors\":true}"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not ask Claude Code what it has: {e}"))?;

    let mut found = None;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(servers) = msg.get("mcp_servers").and_then(|v| v.as_array()) else {
                continue;
            };

            found = Some(
                servers
                    .iter()
                    .filter_map(|server| {
                        let name = server.get("name")?.as_str()?.to_string();
                        Some(Plugin {
                            key: key_of(&name),
                            connector: name.starts_with("claude.ai "),
                            name: name.trim_start_matches("claude.ai ").to_string(),
                            status: server
                                .get("status")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string(),
                        })
                    })
                    .collect::<Vec<_>>(),
            );
            break;
        }
    }

    // Stop the turn before it reaches the model. Nothing has been spent at this
    // point, and leaving it running would spend it for no reason.
    let _ = child.kill();
    let _ = child.wait();

    found.ok_or_else(|| "Claude Code did not report its servers".to_string())
}

/* ------------------------------------------------------------- marketplace */

/// One plugin offered by a marketplace. Claude Code plugins bundle MCP servers
/// (and skills and commands); installing one is what makes its servers show up
/// in discovery above, ready to be granted to a bot.
#[derive(Serialize, Clone)]
pub struct CatalogEntry {
    /// `name@marketplace`, which is what install and uninstall take.
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub author: String,
    pub marketplace: String,
    pub installed: bool,
}

fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::home().join(".claude"))
}

/// Read the marketplace manifests off disk rather than shelling out: the CLI's
/// own `--available` listing drops the category and author, and the catalogue is
/// 287 entries the user will scroll and search.
#[tauri::command(async)]
pub fn plugin_catalog() -> Result<Vec<CatalogEntry>, String> {
    let installed = installed_ids();
    let root = claude_dir().join("plugins").join("marketplaces");
    let entries = std::fs::read_dir(&root)
        .map_err(|_| "No marketplaces configured yet.".to_string())?;

    let mut out = Vec::new();
    for market in entries.flatten() {
        let manifest = market.path().join(".claude-plugin").join("marketplace.json");
        let Ok(raw) = std::fs::read_to_string(&manifest) else { continue };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        let market_name = doc
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| market.file_name().to_string_lossy().into_owned());

        let listed = doc.get("plugins").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for plugin in &listed {
            let Some(name) = plugin.get("name").and_then(|v| v.as_str()) else { continue };
            let id = format!("{name}@{market_name}");
            out.push(CatalogEntry {
                installed: installed.contains(&id),
                id,
                name: name.to_string(),
                description: plugin
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                category: plugin
                    .get("category")
                    .and_then(|v| v.as_str())
                    .unwrap_or("other")
                    .to_string(),
                // Author is sometimes an object, sometimes a bare string.
                author: plugin
                    .get("author")
                    .map(|a| {
                        a.get("name")
                            .and_then(|v| v.as_str())
                            .or_else(|| a.as_str())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
                    .to_string(),
                marketplace: market_name.clone(),
            });
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn installed_ids() -> Vec<String> {
    let Some(bin) = crate::locate_claude() else { return Vec::new() };
    let Ok(out) = Command::new(bin).args(["plugin", "list", "--json"]).output() else {
        return Vec::new();
    };
    serde_json::from_slice::<serde_json::Value>(&out.stdout)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .map(|list| {
            list.iter()
                .filter_map(|p| Some(p.get("id")?.as_str()?.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn install_plugin(id: String) -> Result<(), String> {
    run_plugin_command(&["plugin", "install", &id, "--scope", "user"])
}

#[tauri::command(async)]
pub fn uninstall_plugin(id: String) -> Result<(), String> {
    run_plugin_command(&["plugin", "uninstall", &id])
}

fn run_plugin_command(args: &[&str]) -> Result<(), String> {
    let bin = crate::locate_claude().ok_or("Claude Code CLI not found")?;
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("could not run Claude Code: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = err.trim().lines().last().unwrap_or("the command failed");
    Err(msg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_matches_how_claude_code_names_connector_tools() {
        // Observed: mcp__claude_ai_Google_Calendar__create_event
        assert_eq!(key_of("claude.ai Google Calendar"), "claude_ai_Google_Calendar");
        assert_eq!(key_of("desktop"), "desktop");
        assert_eq!(key_of("my-server_2"), "my-server_2");
    }

    /// The race means a single probe legitimately returns nothing, so this
    /// asserts the call works and prints what it saw rather than demanding a
    /// non-empty answer.
    /// botcage supplies its own connectors now, so a claude.ai one appearing here
    /// would be a server a bot could be granted but never actually reach.
    #[test]
    fn discovery_excludes_claude_ai_connectors() {
        let found = probe_with_retries(3);
        for plugin in &found {
            println!("{} | key={} status={}", plugin.name, plugin.key, plugin.status);
        }
        assert!(
            found.iter().all(|plugin| !plugin.connector),
            "claude.ai connectors are disabled for turns and must not be offered",
        );
    }

    #[test]
    fn catalogue_parses_the_marketplace_manifests() {
        let found = plugin_catalog().expect("marketplace manifests should be readable");
        let with_category = found.iter().filter(|p| p.category != "other").count();
        let with_author = found.iter().filter(|p| !p.author.is_empty()).count();
        println!("catalogue: {} entries, {with_category} categorised, {with_author} with an author", found.len());
        println!("sample: {:?}", found.first().map(|p| (&p.id, &p.category)));
        assert!(found.len() > 50, "expected a populated catalogue");
    }

    #[test]
    fn probe_reaches_the_cli() {
        let found = probe_once().expect("discovery should reach the CLI");
        for plugin in &found {
            println!("{} | key={} status={} connector={}", plugin.name, plugin.key, plugin.status, plugin.connector);
        }
        println!("servers seen: {}", found.len());
    }
}
