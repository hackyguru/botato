//! Whether there is a newer botato than this one.
//!
//! GitHub's releases list is the whole source, rather than `releases/latest`.
//! botato is alpha and every release is published as a pre-release, which
//! `releases/latest` excludes by definition — pointed there, this would answer
//! 404 for ever and nobody would be offered an update again.
//!
//! Drafts are still excluded: unauthenticated, the API does not return them at
//! all, and the filter below drops any that appear anyway. A release being
//! built, or sitting unpublished while somebody checks its assets, is invisible
//! here, which is the right answer — an update nobody has published is not an
//! update.
//!
//! Installing is the updater plugin's job, not this module's. What lives here
//! is the question asked at launch — is there a newer one — and the question
//! asked before offering to install it, which is whether this particular copy
//! of botato is one that can replace itself at all. See `update_installable`.
//!
//! Through curl, for the same reason the rest of botato does: it is on every
//! machine, and an app bundle started by the system has a PATH of four
//! directories, all of which contain it.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Newest first, and one page is plenty: the answer is always in the first
/// few, and asking for more only makes the reply bigger.
const RELEASES: &str = "https://api.github.com/repos/hackyguru/botato/releases?per_page=20";

/// Where somebody is sent to fetch it. The list rather than `latest`, for the
/// same reason as above: with only pre-releases published, `latest` is a 404.
const RELEASES_PAGE: &str = "https://github.com/hackyguru/botato/releases";

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

/// The highest version among the published releases in a list reply.
///
/// By version rather than by position. The list arrives newest-created first,
/// which is nearly always the same order, but a patch tagged on an old branch
/// after a newer one went out is created last and is not an upgrade — and a
/// release edited later can move. Comparing the numbers cannot get that wrong.
fn best(body: &serde_json::Value) -> Option<(String, String)> {
    let list = body.as_array()?;
    list.iter()
        .filter(|r| {
            // Absent means published: the field is only ever true on a draft,
            // and unauthenticated the API does not return drafts at all.
            !r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false)
        })
        .filter_map(|r| {
            let tag = r.get("tag_name")?.as_str()?.trim_start_matches('v');
            let url = r
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or(RELEASES_PAGE);
            Some((tag.to_string(), url.to_string()))
        })
        .max_by_key(|(tag, _)| parts(tag))
}

fn ask() -> Result<(String, String), String> {
    let out = std::process::Command::new("curl")
        .args([
            "-sSL",
            "--max-time",
            "20",
            "-H",
            "Accept: application/vnd.github+json",
            RELEASES,
        ])
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let body: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("not JSON: {e}"))?;
    // A rate limit answers 200 with an object rather than a list, so "no
    // releases in the answer" covers both that and a repository with none.
    best(&body).ok_or_else(|| "no releases in the answer".to_string())
}

/// Whether this copy of botato can install an update over itself.
///
/// Not every install can, and the ones that cannot must not be offered a
/// button that fails. A .deb or a .rpm belongs to the system package manager:
/// its files are root-owned, its version is recorded in a database botato has
/// no business writing to, and replacing them behind apt's back is how a
/// machine ends up with a package it can no longer upgrade. Those are sent to
/// the release page, which is the honest answer for them.
///
/// An AppImage is a single file the person downloaded and owns, which is why
/// it is the one Linux format that can be swapped in place. The runtime sets
/// APPIMAGE to its path, and its absence is what tells us we are inside a
/// packaged install instead.
///
/// macOS is always yes: the bundle is a directory in /Applications that the
/// person installed by dragging, and the plugin replaces it wholesale.
#[tauri::command]
#[must_use]
pub fn update_installable() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// The newest published release, pre-releases included, if it is newer
/// than this build.
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

    fn release(tag: &str, draft: bool, prerelease: bool) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "html_url": format!("https://example.invalid/{tag}"),
        })
    }

    /// The whole point of the change: every botato release is marked as a
    /// pre-release, so one that is ignored is one nobody is ever offered.
    #[test]
    fn a_prerelease_is_still_an_update() {
        let body = serde_json::json!([release("v0.7.0", false, true)]);
        let (version, url) = best(&body).expect("the pre-release counts");
        assert_eq!(version, "0.7.0");
        assert_eq!(url, "https://example.invalid/v0.7.0");
    }

    /// Published only. A draft is a release nobody has pressed the button on,
    /// and its assets may not exist yet.
    #[test]
    fn a_draft_is_not_offered() {
        let body = serde_json::json!([
            release("v0.9.0", true, true),
            release("v0.7.0", false, true),
        ]);
        assert_eq!(best(&body).unwrap().0, "0.7.0");
    }

    /// The list arrives in creation order, which a patch tagged on an old
    /// branch puts out of version order.
    #[test]
    fn the_highest_version_wins_rather_than_the_first_row() {
        let body = serde_json::json!([
            release("v0.6.1", false, true),
            release("v0.10.0", false, true),
            release("v0.9.0", false, true),
        ]);
        assert_eq!(best(&body).unwrap().0, "0.10.0");
    }

    /// A rate limit answers 200 with an object, and a repository with no
    /// releases answers with an empty list. Neither is an update.
    #[test]
    fn nothing_usable_offers_nothing() {
        assert!(best(&serde_json::json!([])).is_none());
        assert!(best(&serde_json::json!({ "message": "API rate limit exceeded" })).is_none());
    }
}
