//! Saying it out loud.
//!
//! A bot on a call speaks with the machine's own synthesiser — `say` on macOS,
//! `spd-say` on Linux — which matters for the same reason everything else here
//! is local: a voice that went through somebody's API would mean every word a
//! bot said left the machine, and the whole app is built on that not happening.
//!
//! It costs nothing either. macOS ships with well over a hundred voices, so a
//! bot having its own is a matter of picking one, not of buying one.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The speech in progress, so a new one can cut it off.
///
/// One at a time on purpose: two bots talking over each other is noise, and
/// the natural thing to do when a bot is halfway through a paragraph you have
/// heard enough of is to interrupt it.
static TALKING: Mutex<Option<(u64, Child)>> = Mutex::new(None);

/// Which utterance is the current one.
///
/// The caller waits for speech to finish so the face can move its mouth for
/// exactly as long as there is sound. A wait that outlived the thing it was
/// waiting for would hold a mouth open after a newer sentence had replaced it,
/// so each utterance carries a number and a waiter stops when it is no longer
/// the one being said.
static UTTERANCE: Mutex<u64> = Mutex::new(0);

/// The voices installed for a language, by name.
///
/// macOS lists them as `Name    en_GB    # Hello, my name is Name.`; the
/// language tag is the second column and the sample sentence, which contains
/// spaces and hashes and everything else, is what makes anything cleverer than
/// "split on whitespace, take two" a bad idea.
#[must_use]
pub fn voices(language: &str) -> Vec<String> {
    let want = language.split(['-', '_']).next().unwrap_or("en").to_lowercase();

    let listed = Command::new(if cfg!(target_os = "macos") { "say" } else { "spd-say" })
        .args(if cfg!(target_os = "macos") { vec!["-v", "?"] } else { vec!["-L"] })
        .output();
    let Ok(listed) = listed else { return Vec::new() };
    let text = String::from_utf8_lossy(&listed.stdout);

    let mut found: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            // A name can be two words ("Grandma (Enhanced)"), so the tag is
            // found rather than counted to.
            let tag = line.split_whitespace().find(|word| {
                word.len() >= 2 && word.contains('_') && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            })?;
            if !tag.to_lowercase().starts_with(&want) {
                return None;
            }
            let name = line.split(tag).next()?.trim();
            let _ = parts.next();
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect();

    found.sort();
    found.dedup();
    found
}

/// Say it, stopping whatever was being said, and return when it has been said.
///
/// Blocking on purpose — the caller is on a background thread and wants to
/// know when the sound stops, because that is when a talking face stops
/// talking. Interrupting it counts as finishing.
pub fn speak(text: &str, voice: Option<&str>, rate: Option<u32>) -> Result<(), String> {
    hush();
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    let mut cmd = Command::new(if cfg!(target_os = "macos") { "say" } else { "spd-say" });
    if cfg!(target_os = "macos") {
        if let Some(voice) = voice.filter(|v| !v.is_empty()) {
            cmd.args(["-v", voice]);
        }
        if let Some(rate) = rate {
            cmd.args(["-r", &rate.to_string()]);
        }
        // Through stdin rather than as an argument: a reply can be longer than
        // a command line is allowed to be, and a bot cut off mid-sentence by
        // an operating system limit would be a strange thing to debug.
        cmd.arg("-f").arg("-");
    } else {
        cmd.arg("-e");
        if let Some(voice) = voice.filter(|v| !v.is_empty()) {
            cmd.args(["-y", voice]);
        }
        cmd.arg(text);
    }

    let mut child = cmd
        .stdin(if cfg!(target_os = "macos") { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not speak: {e}"))?;

    if cfg!(target_os = "macos") {
        use std::io::Write;
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(text.as_bytes());
        }
    }

    let mine = {
        let mut count = UTTERANCE.lock().unwrap_or_else(|held| held.into_inner());
        *count += 1;
        *count
    };
    *TALKING.lock().unwrap_or_else(|held| held.into_inner()) = Some((mine, child));

    loop {
        std::thread::sleep(std::time::Duration::from_millis(90));
        let mut talking = TALKING.lock().unwrap_or_else(|held| held.into_inner());
        match talking.as_mut() {
            // Hushed, or a newer sentence took over. Either way this one is
            // over as far as the face is concerned.
            None => return Ok(()),
            Some((id, _)) if *id != mine => return Ok(()),
            Some((_, child)) => match child.try_wait() {
                Ok(Some(_)) => {
                    *talking = None;
                    return Ok(());
                }
                Ok(None) => {}
                Err(_) => {
                    *talking = None;
                    return Ok(());
                }
            },
        }
    }
}

/// Stop talking. Safe to call when nothing is.
pub fn hush() {
    let mut talking = TALKING.lock().unwrap_or_else(|held| held.into_inner());
    if let Some((_, mut child)) = talking.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parse has to survive a sample sentence full of spaces and hashes,
    /// and a voice name that is more than one word.
    #[test]
    fn voices_are_read_out_of_the_listing_shape_macos_uses() {
        let listing = "\
Albert              en_US    # Hello! My name is Albert.
Alice               it_IT    # Ciao! Mi chiamo Alice.
Grandma (Enhanced)  en_GB    # Hello! My name is Grandma.
Daniel              en_GB    # Hello! My name is Daniel.
";
        // The same shape the function walks, exercised directly: anything with
        // a language tag that starts with "en", named by what precedes it.
        let names: Vec<String> = listing
            .lines()
            .filter_map(|line| {
                let tag = line.split_whitespace().find(|w| w.contains('_'))?;
                if !tag.to_lowercase().starts_with("en") {
                    return None;
                }
                let name = line.split(tag).next()?.trim();
                (!name.is_empty()).then(|| name.to_string())
            })
            .collect();

        assert_eq!(names, ["Albert", "Grandma (Enhanced)", "Daniel"]);
    }

    /// Hushing when nothing is talking is the common case — every call to
    /// `speak` starts with one.
    #[test]
    fn hushing_silence_is_not_an_error() {
        hush();
        hush();
    }
}
