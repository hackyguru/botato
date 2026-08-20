//! Every model there is, and the key to reach it.
//!
//! [models.dev](https://models.dev) publishes one JSON file describing 192
//! providers and some six thousand models: what each one costs, how much
//! context it has, whether it can call a tool, and — the part that makes this
//! more than a table — where the provider's API lives and what it calls its
//! key. That last pair is what lets botcage offer a model it has never heard
//! of: a base URL and a credential are the whole of what talking to one takes.
//!
//! botcage keeps a copy on disk. The file is a few megabytes and changes by the
//! week, not the minute, so fetching it once and refreshing on demand beats a
//! request per search — and a laptop with no signal still gets to choose a
//! model.
//!
//! Keys live in the system keychain, one per provider, never in this file and
//! never in a bot. A bot names a provider; what it costs to talk to that
//! provider is between the user and the provider.

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const SOURCE: &str = "https://models.dev/api.json";

/// Parsed once and kept, because every search would otherwise re-read and
/// re-parse several megabytes.
static LOADED: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data directory: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("models.dev.json"))
}

/// Fetch the catalogue and keep it. Returns how many models it describes.
///
/// Through curl for the same reason the rest of botcage does: it is on every
/// machine this runs on, and an HTTP stack with TLS would be a larger
/// dependency than the app.
pub fn fetch(app: &AppHandle) -> Result<usize, String> {
    let path = cache_path(app)?;
    let temp = path.with_extension("part");

    let out = std::process::Command::new("curl")
        .args(["-sSL", "--max-time", "90", "-o"])
        .arg(&temp)
        .arg(SOURCE)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "could not reach models.dev: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // Parsed before it replaces what is already there: half a download is
    // worse than a week-old catalogue.
    let raw = std::fs::read_to_string(&temp).map_err(|e| e.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("models.dev sent something this build cannot read: {e}"))?;
    let count = count_models(&parsed);
    if count == 0 {
        return Err("models.dev returned no models".into());
    }

    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    *LOADED.lock().unwrap() = Some(parsed);
    Ok(count)
}

fn count_models(catalogue: &serde_json::Value) -> usize {
    catalogue
        .as_object()
        .map(|providers| {
            providers
                .values()
                .filter_map(|p| p["models"].as_object())
                .map(|models| models.len())
                .sum()
        })
        .unwrap_or(0)
}

/// The catalogue, from memory or disk. None until it has been fetched once.
fn catalogue(app: &AppHandle) -> Option<serde_json::Value> {
    let mut held = LOADED.lock().unwrap();
    if held.is_none() {
        let raw = std::fs::read_to_string(cache_path(app).ok()?).ok()?;
        *held = serde_json::from_str(&raw).ok();
    }
    held.clone()
}

/// Where a provider's API lives and what it calls its key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// The base URL. Without one there is nothing to talk to, and the provider
    /// is not offered.
    pub api: String,
    /// What the provider's own documentation calls its key, so the field asking
    /// for one can say it.
    pub env: Vec<String>,
    pub doc: String,
    /// Whether botcage is holding a key for it.
    pub has_key: bool,
}

/// Providers reachable over an OpenAI-shaped API, plus anything local.
pub fn providers(app: &AppHandle) -> Vec<Provider> {
    let mut out: Vec<Provider> = catalogue(app)
        .and_then(|c| c.as_object().cloned())
        .map(|entries| {
            entries
                .values()
                .filter_map(|entry| {
                    let api = entry["api"].as_str()?.trim_end_matches('/').to_string();
                    let id = entry["id"].as_str()?.to_string();
                    let has_key = key_for(&id).is_some();
                    Some(Provider {
                        name: entry["name"].as_str().unwrap_or(&id).to_string(),
                        env: entry["env"]
                            .as_array()
                            .map(|names| {
                                names
                                    .iter()
                                    .filter_map(|n| n.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        doc: entry["doc"].as_str().unwrap_or_default().to_string(),
                        id,
                        api,
                        has_key,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    out.push(ollama());
    out.sort_by_key(|p| p.name.to_lowercase());
    out
}

/// The one provider botcage adds itself.
///
/// Ollama is not in the catalogue — it has no prices to publish and no key to
/// name — but it speaks the same API on this machine, for nothing, without an
/// account. For a lot of people it is the only model they can use at all.
fn ollama() -> Provider {
    Provider {
        id: "ollama".into(),
        name: "Ollama (on this machine)".into(),
        api: "http://localhost:11434/v1".into(),
        env: Vec::new(),
        doc: "https://ollama.com".into(),
        has_key: true, // Nothing to hold: it is not on anyone else's computer.
    }
}

pub fn provider(app: &AppHandle, id: &str) -> Option<Provider> {
    providers(app).into_iter().find(|p| p.id == id)
}

/// One model, as a person choosing between six thousand of them needs it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub provider: String,
    pub provider_name: String,
    pub id: String,
    pub name: String,
    /// Tokens of context, when the catalogue says.
    pub context: Option<u64>,
    /// Dollars per million tokens in and out.
    pub cost_in: Option<f64>,
    pub cost_out: Option<f64>,
    pub tools: bool,
    pub reasoning: bool,
    /// Whether a key is on file for this model's provider.
    pub ready: bool,
}

/// Models matching `query`, best first.
///
/// Substring matching over the model's id, its name and its provider — the
/// three things anyone actually types. Ranked by where the match landed, so
/// searching "sonnet" puts Sonnet above something merely made by a provider
/// with sonnet in the name.
pub fn search(app: &AppHandle, query: &str, tools_only: bool, limit: usize) -> Vec<Listing> {
    let Some(catalogue) = catalogue(app) else {
        return Vec::new();
    };
    let Some(entries) = catalogue.as_object() else {
        return Vec::new();
    };

    let needle = query.trim().to_lowercase();
    let keyed: std::collections::HashSet<String> = providers(app)
        .into_iter()
        .filter(|p| p.has_key)
        .map(|p| p.id)
        .collect();

    let mut hits: Vec<(usize, Listing)> = Vec::new();
    for entry in entries.values() {
        let Some(api) = entry["api"].as_str() else {
            // Nothing to talk to: a provider that only exists behind someone
            // else's SDK is not a model this app can offer.
            continue;
        };
        if api.is_empty() {
            continue;
        }
        let provider = entry["id"].as_str().unwrap_or_default().to_string();
        let provider_name = entry["name"].as_str().unwrap_or(&provider).to_string();
        let Some(models) = entry["models"].as_object() else {
            continue;
        };

        for model in models.values() {
            let tools = model["tool_call"].as_bool().unwrap_or(false);
            if tools_only && !tools {
                continue;
            }
            let id = model["id"].as_str().unwrap_or_default().to_string();
            let name = model["name"].as_str().unwrap_or(&id).to_string();

            let rank = if needle.is_empty() {
                2
            } else if let Some(at) = id.to_lowercase().find(&needle) {
                if at == 0 {
                    0
                } else {
                    1
                }
            } else if name.to_lowercase().contains(&needle) {
                1
            } else if provider_name.to_lowercase().contains(&needle) {
                3
            } else {
                continue;
            };

            hits.push((
                rank,
                Listing {
                    ready: keyed.contains(&provider),
                    provider: provider.clone(),
                    provider_name: provider_name.clone(),
                    context: model["limit"]["context"].as_u64(),
                    cost_in: model["cost"]["input"].as_f64(),
                    cost_out: model["cost"]["output"].as_f64(),
                    tools,
                    reasoning: model["reasoning"].as_bool().unwrap_or(false),
                    id,
                    name,
                },
            ));
        }
    }

    // A model you can already talk to beats one you cannot, then how well it
    // matched, then alphabetical so the list does not shuffle between searches.
    hits.sort_by(|a, b| {
        (
            a.0,
            !a.1.ready,
            a.1.name.to_lowercase(),
            a.1.provider.clone(),
        )
            .cmp(&(
                b.0,
                !b.1.ready,
                b.1.name.to_lowercase(),
                b.1.provider.clone(),
            ))
    });
    hits.into_iter().take(limit).map(|(_, hit)| hit).collect()
}

/* --------------------------------------------------------------- the keys */

fn key_name(provider: &str) -> String {
    format!("model-provider.{provider}")
}

pub fn key_for(provider: &str) -> Option<String> {
    if provider == "ollama" {
        return None;
    }
    crate::connectors::read_secret(&key_name(provider))
}

/* ------------------------------------------------------------- commands */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueState {
    pub models: usize,
    pub providers: usize,
    /// Unix seconds the copy on disk was written, if there is one.
    pub fetched_at: Option<u64>,
}

#[tauri::command(async)]
pub fn catalogue_state(app: AppHandle) -> CatalogueState {
    let fetched_at = cache_path(&app)
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs());

    let held = catalogue(&app);
    CatalogueState {
        models: held.as_ref().map(count_models).unwrap_or(0),
        providers: providers(&app).len(),
        fetched_at,
    }
}

#[tauri::command(async)]
pub fn catalogue_refresh(app: AppHandle) -> Result<usize, String> {
    fetch(&app)
}

#[tauri::command(async)]
pub fn catalogue_search(
    app: AppHandle,
    query: String,
    tools_only: bool,
    limit: Option<usize>,
) -> Vec<Listing> {
    search(&app, &query, tools_only, limit.unwrap_or(40))
}

#[tauri::command(async)]
pub fn catalogue_providers(app: AppHandle) -> Vec<Provider> {
    providers(&app)
}

#[tauri::command(async)]
pub fn provider_key_set(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("that key is empty".into());
    }
    crate::connectors::write_secret(&key_name(&provider), key)
}

#[tauri::command(async)]
pub fn provider_key_clear(provider: String) {
    crate::connectors::forget_secret(&key_name(&provider));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape botcage reads, against the shape models.dev publishes. Written
    /// from the real file — 192 providers, 6,841 models — rather than from its
    /// documentation.
    fn sample() -> serde_json::Value {
        serde_json::json!({
            "openrouter": {
                "id": "openrouter",
                "name": "OpenRouter",
                "api": "https://openrouter.ai/api/v1",
                "env": ["OPENROUTER_API_KEY"],
                "doc": "https://openrouter.ai/models",
                "models": {
                    "anthropic/claude-sonnet-4": {
                        "id": "anthropic/claude-sonnet-4",
                        "name": "Claude Sonnet 4",
                        "tool_call": true,
                        "reasoning": true,
                        "limit": { "context": 200000, "output": 64000 },
                        "cost": { "input": 3.0, "output": 15.0 }
                    },
                    "meta/llama-3-8b": {
                        "id": "meta/llama-3-8b",
                        "name": "Llama 3 8B",
                        "tool_call": false,
                        "limit": { "context": 8192 },
                        "cost": { "input": 0.05, "output": 0.05 }
                    }
                }
            },
            "vercel": {
                "id": "vercel",
                "name": "Vercel",
                "env": ["VERCEL_API_KEY"],
                "models": {
                    "sonnet-via-vercel": { "id": "sonnet-via-vercel", "name": "Sonnet via Vercel", "tool_call": true }
                }
            }
        })
    }

    #[test]
    fn counting_walks_every_provider() {
        assert_eq!(count_models(&sample()), 3);
        assert_eq!(count_models(&serde_json::json!({})), 0);
        assert_eq!(count_models(&serde_json::json!("not a catalogue")), 0);
    }

    /// A provider with no API base is a provider botcage cannot reach, whatever
    /// its models are called. Twenty-six of the real ones are like this.
    #[test]
    fn a_provider_with_nowhere_to_send_a_request_is_not_offered() {
        let catalogue = sample();
        let reachable: Vec<&str> = catalogue
            .as_object()
            .unwrap()
            .values()
            .filter(|p| p["api"].as_str().is_some_and(|api| !api.is_empty()))
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert_eq!(reachable, vec!["openrouter"]);
        assert!(
            !reachable.contains(&"vercel"),
            "a provider reachable only through someone else's SDK is not a model this app can offer"
        );
    }

    #[test]
    fn ollama_is_offered_without_a_key() {
        let local = ollama();
        assert!(local.has_key, "nothing to hold, so nothing to ask for");
        assert!(local.env.is_empty());
        assert!(key_for("ollama").is_none(), "and nothing to read back");
    }

    #[test]
    fn a_key_is_named_per_provider() {
        assert_eq!(key_name("openrouter"), "model-provider.openrouter");
        assert_ne!(key_name("openrouter"), key_name("groq"));
    }
}
