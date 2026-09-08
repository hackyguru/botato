//! Whether there is a newer botcage than this one.
//!
//! GitHub's `releases/latest` is the whole source. It deliberately excludes
//! drafts and pre-releases, so a release being built, or sitting unpublished
//! while somebody checks its assets, is invisible here — which is the right
//! answer: an update nobody has published is not an update.
//!
//! Nothing is downloaded or installed. botcage ships no auto-updater, and
//! pretending otherwise with a progress bar that ends at "now go to the
//! website" would be worse than saying so. The menu item opens the release
//! page and the person decides.
//!
//! Through curl, for the same reason the rest of botcage does: it is on every
//! machine, and an app bundle started by the system has a PATH of four
//! directories, all of which contain it.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const LATEST: &str = "https://api.github.com/repos/hackyguru/botcage/releases/latest";

/// How long an answer stays good. The unauthenticated API allows sixty calls
/// an hour per address; this asks four times a day at most, and a release
/// nobody has noticed for six hours is not an emergency.
const FRESH_FOR: u64 = 6 * 60 * 60;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    /// Without the leading v, because that is how the app says its own.
    pub version: String,
    pub url: String,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    at: u64,
    version: String,
    url: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("update.json"))
}

/// Three numbers, and anything that is not one is a zero. A tag nobody can
/// parse compares equal to nothing and so is never newer, which is the safe
/// direction to fail in: a bad tag offers no update rather than offering one
/// for ever.
fn parts(version: &str) -> (u64, u64, u64) {
    let clean = version.trim().trim_start_matches('v');
    // Stop at the first thing that is not part of the number: 1.2.3-beta.1.
    let core: String = clean
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut bits = core.split('.').map(|n| n.parse::<u64>().unwrap_or(0));
    (
        bits.next().unwrap_or(0),
        bits.next().unwrap_or(0),
        bits.next().unwrap_or(0),
    )
}

pub fn newer(than: &str, candidate: &str) -> bool {
    parts(candidate) > parts(than)
}

fn ask() -> Result<(String, String), String> {
    let out = std::process::Command::new("curl")
        .args([
            "-sSL",
            "--max-time",
            "20",
            "-H",
            "Accept: application/vnd.github+json",
            LATEST,
        ])
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("not JSON: {e}"))?;
    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or("no tag_name in the answer")?;
    let url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/hackyguru/botcage/releases/latest");
    Ok((tag.trim_start_matches('v').to_string(), url.to_string()))
}

/// The newest published release, if it is newer than this build.
///
/// Answers from the cache when it is fresh, and from the cache again when the
/// network fails — an aeroplane should not make an offered update disappear.
#[tauri::command(async)]
pub fn update_check(app: AppHandle) -> Option<Update> {
    let here = env!("CARGO_PKG_VERSION");
    let path = cache_path(&app).ok()?;
    let held: Option<Cached> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());

    if let Some(seen) = &held {
        if now().saturating_sub(seen.at) < FRESH_FOR {
            return newer(here, &seen.version).then(|| Update {
                version: seen.version.clone(),
                url: seen.url.clone(),
            });
        }
    }

    match ask() {
        Ok((version, url)) => {
            if let Ok(body) = serde_json::to_string(&Cached {
                at: now(),
                version: version.clone(),
                url: url.clone(),
            }) {
                let _ = std::fs::write(&path, body);
            }
            newer(here, &version).then_some(Update { version, url })
        }
        // Offline, rate-limited, GitHub having a day: say what was last known
        // rather than nothing.
        Err(_) => held.and_then(|seen| {
            newer(here, &seen.version).then_some(Update {
                version: seen.version,
                url: seen.url,
            })
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_higher_version_is_newer_and_the_same_one_is_not() {
        assert!(newer("0.5.0", "0.5.1"));
        assert!(newer("0.5.0", "0.6.0"));
        assert!(newer("0.9.9", "1.0.0"));
        assert!(!newer("0.5.0", "0.5.0"));
        assert!(!newer("0.5.0", "0.4.9"));
    }

    /// Ten is not less than nine, which it is as a string.
    #[test]
    fn versions_compare_as_numbers_rather_than_text() {
        assert!(newer("0.9.0", "0.10.0"));
        assert!(!newer("0.10.0", "0.9.0"));
    }

    /// The v belongs to the tag, not to the version.
    #[test]
    fn a_leading_v_is_not_part_of_the_number() {
        assert!(newer("0.5.0", "v0.6.0"));
        assert!(!newer("v0.6.0", "0.6.0"));
    }

    /// A tag nobody can parse must not offer an update for ever.
    #[test]
    fn something_that_is_not_a_version_is_never_newer() {
        assert!(!newer("0.5.0", "nightly"));
        assert!(!newer("0.5.0", ""));
    }

    /// A pre-release of the version you already have is not an upgrade.
    #[test]
    fn a_prerelease_suffix_is_ignored_rather_than_misread() {
        assert!(!newer("0.5.0", "0.5.0-rc.1"));
        assert!(newer("0.5.0", "0.5.1-rc.1"));
    }
}
