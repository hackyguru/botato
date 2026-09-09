//! Claude Code plugins: the marketplace botato browses, and the MCP servers an
//! installed plugin contributes to a session.
//!
//! Services botato connects itself live in `connectors.rs`. The claude.ai
//! connectors that used to appear here are switched off for every turn, so
//! discovery runs with the same setting — a server offered here that a bot
//! could not actually reach would be worse than not listing it.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
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
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
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
    /// The owner's avatar, which is the only logo the manifests give us access
    /// to — no entry carries an icon field. Empty when the source is not GitHub.
    pub icon: String,
    /// Where the plugin's code lives, so its own repository is one click away
    /// rather than something to go and search for.
    pub source_url: String,
    pub homepage: String,
    /// Whether this machine can actually run it. None until verified.
    pub usable: Option<bool>,
    /// Why not, when it cannot.
    pub note: String,
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
    let health = load_health();
    let root = claude_dir().join("plugins").join("marketplaces");
    let entries =
        std::fs::read_dir(&root).map_err(|_| "No marketplaces configured yet.".to_string())?;

    let mut out = Vec::new();
    for market in entries.flatten() {
        let manifest = market
            .path()
            .join(".claude-plugin")
            .join("marketplace.json");
        let Ok(raw) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let market_name = doc
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| market.file_name().to_string_lossy().into_owned());

        let listed = doc
            .get("plugins")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for plugin in &listed {
            let Some(name) = plugin.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            let id = format!("{name}@{market_name}");
            let (usable, note) = match health.get(name) {
                Some(h) => {
                    let (ok, why) = h.verdict();
                    (Some(ok), why)
                }
                None => (None, String::new()),
            };
            out.push(CatalogEntry {
                icon: owner_avatar(plugin.get("source")),
                source_url: source_url(plugin.get("source"), &market_name),
                homepage: plugin
                    .get("homepage")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                usable,
                note,
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

    out.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(out)
}

/// A plugin's publisher, as an avatar URL. Every entry either points at a
/// GitHub repository or lives inside the marketplace repo itself, so the owner
/// handle is the one piece of branding available without inventing anything.
fn owner_avatar(source: Option<&serde_json::Value>) -> String {
    let owner = match source {
        // A path rather than a repo means it ships inside the official
        // marketplace, so the marketplace's own owner is the publisher.
        Some(value) if value.is_string() => "anthropics".to_string(),
        Some(value) => {
            let url = value
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            match url
                .strip_prefix("https://github.com/")
                .and_then(|rest| rest.split('/').next())
            {
                Some(owner) if !owner.is_empty() => owner.to_string(),
                _ => return String::new(),
            }
        }
        None => return String::new(),
    };
    format!("https://github.com/{owner}.png?size=80")
}

/// A browsable link to the plugin's code. Entries that live inside the
/// marketplace repository point at their directory there.
fn source_url(source: Option<&serde_json::Value>, market: &str) -> String {
    match source {
        Some(value) if value.is_string() => {
            let path = value.as_str().unwrap_or_default().trim_start_matches("./");
            if market == "claude-plugins-official" {
                format!("https://github.com/anthropics/claude-plugins-official/tree/main/{path}")
            } else {
                String::new()
            }
        }
        Some(value) => value
            .get("url")
            .and_then(|v| v.as_str())
            .map(|url| url.trim_end_matches(".git").to_string())
            .unwrap_or_default(),
        None => String::new(),
    }
}

fn installed_ids() -> Vec<String> {
    let Some(bin) = crate::locate_claude() else {
        return Vec::new();
    };
    let Ok(out) = Command::new(bin)
        .args(["plugin", "list", "--json"])
        .output()
    else {
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

/* --------------------------------------------------------------- verifying */

/// A catalogue entry says nothing about whether it works. Most of these are
/// skills, which always do; the rest need a runtime this machine may not have,
/// or a sign-in botato cannot perform. Verified once and cached, because it
/// means fetching each plugin's MCP config from its own repository.
#[derive(Serialize, Deserialize, Clone, Default)]
struct Health {
    /// Commands an stdio server would exec, e.g. npx, uvx, bun.
    runtimes: Vec<String>,
    /// Remote servers, and whether each takes a credential we can collect.
    remote: usize,
    remote_with_key: usize,
}

impl Health {
    /// What botato can make work: skills always; a key we can ask for; a
    /// runtime that is actually installed. A remote server with neither is a
    /// sign-in this app cannot complete headlessly.
    fn verdict(&self) -> (bool, String) {
        for runtime in &self.runtimes {
            if which(runtime).is_none() {
                return (false, format!("needs {runtime}, which is not installed"));
            }
        }
        if self.remote > self.remote_with_key && !self.remote_is_signin_capable() {
            return (false, "needs a sign-in botato cannot do yet".into());
        }
        (true, String::new())
    }

    /// Left as a hook: signing a plugin's own server in is the next step, and
    /// when it lands this is the one place that has to change.
    fn remote_is_signin_capable(&self) -> bool {
        false
    }
}

fn which(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(command))
        .find(|candidate| candidate.is_file())
}

fn health_path() -> PathBuf {
    claude_dir().join("plugins").join("botato-health.json")
}

fn load_health() -> HashMap<String, Health> {
    std::fs::read_to_string(health_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Where a plugin's MCP config lives, as a raw file URL or a local path.
fn config_locations(source: &serde_json::Value, market: &Path) -> Vec<String> {
    if let Some(relative) = source.as_str() {
        let base = market.join(relative.trim_start_matches("./"));
        return vec![
            base.join(".mcp.json").display().to_string(),
            base.join(".claude-plugin/plugin.json")
                .display()
                .to_string(),
        ];
    }

    let url = source
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let sha = source.get("sha").and_then(|v| v.as_str()).unwrap_or("HEAD");
    let sub = source
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim_matches(|c| c == '.' || c == '/');
    let Some(repo) = url.strip_prefix("https://github.com/") else {
        return Vec::new();
    };
    let repo = repo.trim_end_matches(".git");
    let prefix = if sub.is_empty() {
        String::new()
    } else {
        format!("{sub}/")
    };
    vec![
        format!("https://raw.githubusercontent.com/{repo}/{sha}/{prefix}.mcp.json"),
        format!(
            "https://raw.githubusercontent.com/{repo}/{sha}/{prefix}.claude-plugin/plugin.json"
        ),
    ]
}

fn read_config(location: &str) -> Option<serde_json::Value> {
    if !location.starts_with("http") {
        return serde_json::from_str(&std::fs::read_to_string(location).ok()?).ok();
    }
    let out = Command::new("curl")
        .args(["-sfL", "-m", "15", "-H", "User-Agent: botato", location])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| serde_json::from_slice(&out.stdout).ok())
        .flatten()
}

fn health_of(source: &serde_json::Value, market: &Path) -> Health {
    let mut health = Health::default();
    for location in config_locations(source, market) {
        let Some(doc) = read_config(&location) else {
            continue;
        };
        let Some(servers) = doc.get("mcpServers").and_then(|v| v.as_object()) else {
            continue;
        };
        if servers.is_empty() {
            continue;
        }
        for config in servers.values() {
            let blob = config.to_string();
            if let Some(command) = config.get("command").and_then(|v| v.as_str()) {
                let name = Path::new(command)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| command.to_string());
                if !health.runtimes.contains(&name) {
                    health.runtimes.push(name);
                }
            } else {
                health.remote += 1;
                if blob.contains("${") {
                    health.remote_with_key += 1;
                }
            }
        }
        break;
    }
    health
}

/// Check the catalogue against this machine. Fetches one small file per plugin,
/// so it runs in the background and its result is cached.
#[tauri::command(async)]
pub fn verify_catalogue() -> Result<usize, String> {
    let root = claude_dir().join("plugins").join("marketplaces");
    let mut work = Vec::new();
    for market in std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let manifest = market
            .path()
            .join(".claude-plugin")
            .join("marketplace.json");
        let Ok(raw) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        for plugin in doc
            .get("plugins")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let (Some(name), Some(source)) = (
                plugin.get("name").and_then(|v| v.as_str()),
                plugin.get("source"),
            ) else {
                continue;
            };
            work.push((name.to_string(), source.clone(), market.path()));
        }
    }

    // A dozen at a time: enough to finish in a minute, few enough to stay a
    // polite guest on someone else's file host.
    let found = Mutex::new(HashMap::new());
    let queue = Mutex::new(work.into_iter());
    std::thread::scope(|scope| {
        for _ in 0..12 {
            scope.spawn(|| loop {
                let Some((name, source, market)) = queue.lock().unwrap().next() else {
                    break;
                };
                let health = health_of(&source, &market);
                found.lock().unwrap().insert(name, health);
            });
        }
    });

    let found = found.into_inner().unwrap();
    let body = serde_json::to_string(&found).map_err(|e| e.to_string())?;
    std::fs::write(health_path(), body).map_err(|e| e.to_string())?;
    Ok(found.len())
}

/* ----------------------------------------------------------- what it holds */

/// What an installed plugin actually contributes. Without this the Plugins
/// screen can only offer a name and a description, and a skills-only plugin
/// installs to no visible effect — it brings no MCP server, so nothing appears
/// in a bot's connections and the user is left wondering what happened.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginDetail {
    pub skills: Vec<Component>,
    pub commands: Vec<Component>,
    pub agents: Vec<Component>,
    pub servers: Vec<PluginServer>,
    /// Credentials the plugin's config expects from the environment.
    pub secrets: Vec<Secret>,
    pub install_path: String,
}

#[derive(Serialize)]
pub struct Component {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServer {
    pub name: String,
    /// How Claude Code addresses it: `mcp__<key>__<tool>`.
    pub key: String,
}

#[derive(Serialize)]
pub struct Secret {
    /// The environment variable the plugin interpolates, e.g. CONTEXT7_API_KEY.
    pub var: String,
    pub set: bool,
}

/// The one line of a SKILL.md or command that says what it is. Frontmatter is
/// YAML-ish; only `name` and `description` matter here, so read those rather
/// than pulling in a parser.
fn front_matter(path: &Path, fallback: &str) -> Component {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let mut name = fallback.to_string();
    let mut description = String::new();

    if let Some(block) = raw
        .strip_prefix("---")
        .and_then(|rest| rest.split("---").next())
    {
        for line in block.lines() {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let value = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
            match key.trim() {
                "name" if !value.is_empty() => name = value,
                "description" if !value.is_empty() => description = value,
                _ => {}
            }
        }
    }
    Component { name, description }
}

fn components_in(dir: &Path, nested: bool) -> Vec<Component> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<Component> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let stem = path.file_stem()?.to_string_lossy().to_string();
            if nested && path.is_dir() {
                // skills/<name>/SKILL.md
                let inner = path.join("SKILL.md");
                inner.exists().then(|| front_matter(&inner, &stem))
            } else if !nested && path.extension().is_some_and(|e| e == "md") {
                Some(front_matter(&path, &stem))
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Read a plugin's servers and the environment variables they interpolate.
fn servers_of(dir: &Path, plugin_name: &str) -> (Vec<PluginServer>, Vec<String>) {
    let mut servers = Vec::new();
    let mut vars = Vec::new();

    for candidate in [
        dir.join(".mcp.json"),
        dir.join(".claude-plugin").join("plugin.json"),
    ] {
        let Ok(raw) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(map) = doc.get("mcpServers").and_then(|v| v.as_object()) else {
            continue;
        };

        for (name, config) in map {
            servers.push(PluginServer {
                key: key_of(&format!("plugin:{plugin_name}:{name}")),
                name: name.clone(),
            });
            // ${VAR} and ${VAR:-default} both name a variable the user must set.
            let blob = config.to_string();
            let mut rest = blob.as_str();
            while let Some(start) = rest.find("${") {
                rest = &rest[start + 2..];
                let end = rest.find('}').unwrap_or(rest.len());
                let var = rest[..end]
                    .split(":-")
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if !var.is_empty() && !vars.contains(&var) {
                    vars.push(var);
                }
                rest = &rest[end.min(rest.len())..];
            }
        }
        if !servers.is_empty() {
            break;
        }
    }
    (servers, vars)
}

fn installed_path(id: &str) -> Option<PathBuf> {
    let bin = crate::locate_claude()?;
    let out = Command::new(bin)
        .args(["plugin", "list", "--json"])
        .output()
        .ok()?;
    let list = serde_json::from_slice::<serde_json::Value>(&out.stdout).ok()?;
    list.as_array()?.iter().find_map(|entry| {
        if entry.get("id")?.as_str()? != id {
            return None;
        }
        Some(PathBuf::from(entry.get("installPath")?.as_str()?))
    })
}

#[tauri::command(async)]
pub fn plugin_detail(id: String) -> Result<PluginDetail, String> {
    let dir = installed_path(&id).ok_or("this plugin is not installed")?;
    let plugin_name = id.split('@').next().unwrap_or(&id).to_string();
    let (servers, vars) = servers_of(&dir, &plugin_name);

    Ok(PluginDetail {
        skills: components_in(&dir.join("skills"), true),
        commands: components_in(&dir.join("commands"), false),
        agents: components_in(&dir.join("agents"), false),
        servers,
        secrets: vars
            .into_iter()
            .map(|var| Secret {
                set: crate::connectors::plugin_secret(&plugin_name, &var).is_some(),
                var,
            })
            .collect(),
        install_path: dir.display().to_string(),
    })
}

#[tauri::command(async)]
pub fn set_plugin_secret(id: String, var: String, value: String) -> Result<(), String> {
    let plugin_name = id.split('@').next().unwrap_or(&id).to_string();
    crate::connectors::set_plugin_secret(&plugin_name, &var, value.trim())
}

/// The environment a turn needs so the granted plugins' servers can
/// authenticate. Only plugins whose server this bot was actually granted
/// contribute, so one bot's key is not handed to every session.
pub fn env_for(granted: &[String]) -> Vec<(String, String)> {
    let Some(bin) = crate::locate_claude() else {
        return Vec::new();
    };
    let Ok(out) = Command::new(bin)
        .args(["plugin", "list", "--json"])
        .output()
    else {
        return Vec::new();
    };
    let Ok(list) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return Vec::new();
    };

    let mut env = Vec::new();
    for plugin in list.as_array().unwrap_or(&Vec::new()) {
        let Some(id) = plugin.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(path) = plugin.get("installPath").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = id.split('@').next().unwrap_or(id);
        let (servers, vars) = servers_of(Path::new(path), name);
        if !servers.iter().any(|s| granted.iter().any(|g| g == &s.key)) {
            continue;
        }
        for var in vars {
            if let Some(value) = crate::connectors::plugin_secret(name, &var) {
                env.push((var, value));
            }
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_matches_how_claude_code_names_connector_tools() {
        // Observed: mcp__claude_ai_Google_Calendar__create_event
        assert_eq!(
            key_of("claude.ai Google Calendar"),
            "claude_ai_Google_Calendar"
        );
        assert_eq!(key_of("desktop"), "desktop");
        assert_eq!(key_of("my-server_2"), "my-server_2");
    }

    /// The race means a single probe legitimately returns nothing, so this
    /// asserts the call works and prints what it saw rather than demanding a
    /// non-empty answer.
    /// botato supplies its own connectors now, so a claude.ai one appearing here
    /// would be a server a bot could be granted but never actually reach.
    #[test]
    #[ignore = "needs the Claude Code CLI; run with --ignored"]
    fn discovery_excludes_claude_ai_connectors() {
        let found = probe_with_retries(3);
        for plugin in &found {
            println!(
                "{} | key={} status={}",
                plugin.name, plugin.key, plugin.status
            );
        }
        assert!(
            found.iter().all(|plugin| !plugin.connector),
            "claude.ai connectors are disabled for turns and must not be offered",
        );
    }

    /// Reads a real installed plugin rather than a fixture: the layout is the
    /// CLI's, not ours, so a fixture would only prove our own assumption.
    /// The path a user actually takes: install, browse, open. If the catalogue's
    /// id and the CLI's id ever disagree, the entry looks uninstalled and the
    /// panel offers "Add" for something already present.
    #[test]
    #[ignore = "needs the Claude Code CLI; run with --ignored"]
    fn an_installed_plugin_is_marked_installed_and_openable() {
        let catalogue = plugin_catalog().expect("catalogue");
        let installed: Vec<_> = catalogue.iter().filter(|e| e.installed).collect();
        println!(
            "catalogue says installed: {:?}",
            installed.iter().map(|e| &e.id).collect::<Vec<_>>()
        );
        println!("cli ids:                  {:?}", installed_ids());

        for entry in &installed {
            let detail = plugin_detail(entry.id.clone());
            println!(
                "  {} → detail {}",
                entry.id,
                if detail.is_ok() { "ok" } else { "FAILED" }
            );
            assert!(
                detail.is_ok(),
                "{} is installed but its detail cannot be read",
                entry.id
            );
        }
    }

    #[test]
    #[ignore = "needs the Claude Code CLI; run with --ignored"]
    fn detail_reads_what_an_installed_plugin_holds() {
        let Ok(detail) = plugin_detail("plugin-dev@claude-plugins-official".into()) else {
            println!("plugin-dev not installed; skipping");
            return;
        };
        println!(
            "skills={} commands={} agents={} servers={}",
            detail.skills.len(),
            detail.commands.len(),
            detail.agents.len(),
            detail.servers.len()
        );
        for skill in detail.skills.iter().take(3) {
            println!(
                "  skill {} — {}",
                skill.name,
                &skill.description[..skill.description.len().min(60)]
            );
        }
        assert!(!detail.skills.is_empty(), "plugin-dev ships skills");
        assert!(
            detail.skills.iter().all(|s| !s.description.is_empty()),
            "each needs a description"
        );
    }

    /// The credential case: context7's server interpolates an API key, and that
    /// is what the Plugins screen has to ask for.
    #[test]
    #[ignore = "needs the Claude Code CLI; run with --ignored"]
    fn detail_finds_the_credential_a_server_needs() {
        let Ok(detail) = plugin_detail("context7@claude-plugins-official".into()) else {
            println!("context7 not installed; skipping");
            return;
        };
        println!(
            "servers: {:?}",
            detail.servers.iter().map(|s| &s.key).collect::<Vec<_>>()
        );
        println!(
            "secrets: {:?}",
            detail.secrets.iter().map(|s| &s.var).collect::<Vec<_>>()
        );
        assert_eq!(detail.servers.len(), 1);
        assert_eq!(detail.servers[0].key, "plugin_context7_context7");
        assert!(detail.secrets.iter().any(|s| s.var == "CONTEXT7_API_KEY"));
    }

    /// The real thing, against the real catalogue: this is the check that
    /// decides what a user is allowed to see, so it is measured rather than
    /// assumed.
    #[test]
    #[ignore = "fetches one file per plugin; run explicitly"]
    fn verification_classifies_the_whole_catalogue() {
        let checked = verify_catalogue().expect("sweep");
        let health = load_health();
        let mut usable = 0;
        let mut blocked: std::collections::BTreeMap<String, usize> = Default::default();
        for h in health.values() {
            let (ok, why) = h.verdict();
            if ok {
                usable += 1
            } else {
                *blocked.entry(why).or_default() += 1
            }
        }
        println!("checked {checked}; usable {usable}");
        for (why, n) in &blocked {
            println!("  {n:>4}  {why}");
        }
        assert!(checked > 200, "expected the full catalogue");
    }

    #[test]
    #[ignore = "needs a marketplace on disk; run with --ignored"]
    fn catalogue_parses_the_marketplace_manifests() {
        let found = plugin_catalog().expect("marketplace manifests should be readable");
        let with_category = found.iter().filter(|p| p.category != "other").count();
        let with_author = found.iter().filter(|p| !p.author.is_empty()).count();
        println!(
            "catalogue: {} entries, {with_category} categorised, {with_author} with an author",
            found.len()
        );
        println!("sample: {:?}", found.first().map(|p| (&p.id, &p.category)));
        assert!(found.len() > 50, "expected a populated catalogue");
    }

    #[test]
    #[ignore = "needs the Claude Code CLI; run with --ignored"]
    fn probe_reaches_the_cli() {
        let found = probe_once().expect("discovery should reach the CLI");
        for plugin in &found {
            println!(
                "{} | key={} status={} connector={}",
                plugin.name, plugin.key, plugin.status, plugin.connector
            );
        }
        println!("servers seen: {}", found.len());
    }
}
