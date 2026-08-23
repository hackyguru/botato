//! Saying it out loud, in a voice that belongs to one bot.
//!
//! A bot's face comes from its id, and so does its voice: nobody picks either,
//! because a hundred and eighty voices is not a decision anyone wants to make
//! per bot, and two bots that sound alike are two bots you cannot tell apart
//! on a call.
//!
//! Whatever the machine already has does the speaking. macOS has `say` and two
//! dozen usable voices; Linux has espeak-ng, which is not as good but has
//! plenty of distinct ones once its variants are counted. Neither costs a
//! download, and nothing said leaves the machine — which for a voice matters
//! as much as it does for what was heard.
//!
//! And when something better is installed, botcage will use it: see `CUSTOM`.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// A command to speak with instead of the system's own.
///
/// Set `BOTCAGE_TTS` to a shell command that reads the text on stdin and plays
/// it. `{voice}` in the command is replaced with the bot's voice, and
/// `BOTCAGE_TTS_VOICES` is the comma-separated list to hand out — so a bot
/// still sounds like itself.
///
///     BOTCAGE_TTS='piper -m en_GB-alba-medium.onnx --output-raw \
///                    | aplay -q -r 22050 -f S16_LE -t raw -'
///
/// This is how Kokoro, Piper or whatever comes next gets used without botcage
/// shipping a model, a Python runtime and an inference engine to go with it.
/// A ten-megabyte app that speaks well by borrowing beats a three-hundred
/// megabyte one that speaks well by itself.
const CUSTOM: &str = "BOTCAGE_TTS";
const CUSTOM_VOICES: &str = "BOTCAGE_TTS_VOICES";

/// Voices macOS ships that do not speak.
///
/// Several of these sing — Cellos to Carmina Burana, Good News and Bad News to
/// their own little fanfares — and the rest are robots, sheep and bubbles.
/// They are wonderful and they are not a colleague telling you the build
/// broke, so a bot is never given one. Found by a bot on this machine drawing
/// Cellos and singing its answer.
const NOVELTY: &[&str] = &[
    "Albert",
    "Bad News",
    "Bahh",
    "Bells",
    "Boing",
    "Bubbles",
    "Cellos",
    "Deranged",
    "Good News",
    "Hysterical",
    "Jester",
    "Junior",
    "Kathy",
    "Organ",
    "Pipe Organ",
    "Princess",
    "Ralph",
    "Superstar",
    "Trinoids",
    "Whisper",
    "Wobble",
    "Zarvox",
];

/// espeak-ng's voice variants: the same accent through a different throat.
///
/// This is what makes distinct voices possible on Linux at all. espeak has a
/// handful of English accents and would give a roomful of bots three or four
/// voices between them; each accent crossed with these is seventy-odd, which
/// is more than macOS offers.
const VARIANTS: &[&str] = &[
    "m1", "m2", "m3", "m4", "m5", "m6", "m7", "f1", "f2", "f3", "f4", "f5",
];

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

fn espeak() -> Option<&'static str> {
    ["espeak-ng", "espeak"].into_iter().find(|bin| {
        Command::new(bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    })
}

/// The voices this machine can give bots, for a language.
#[must_use]
pub fn voices(language: &str) -> Vec<String> {
    let want = language
        .split(['-', '_'])
        .next()
        .unwrap_or("en")
        .to_lowercase();

    if let Ok(list) = std::env::var(CUSTOM_VOICES) {
        let named: Vec<String> = list
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .collect();
        if !named.is_empty() {
            return named;
        }
    }

    if cfg!(target_os = "macos") {
        mac_voices(&want)
    } else {
        espeak_voices(&want)
    }
}

/// macOS lists them as `Name    en_GB    # Hello, my name is Name.`
///
/// The language tag is the second column and the sample sentence — which
/// contains spaces and hashes and everything else — is why anything cleverer
/// than "find the tag, take what precedes it" goes wrong on the names that
/// have a bracket in them.
fn mac_voices(want: &str) -> Vec<String> {
    let Ok(listed) = Command::new("say").args(["-v", "?"]).output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&listed.stdout);

    let mut found: Vec<String> = text
        .lines()
        .filter_map(|line| {
            let tag = line.split_whitespace().find(|word| {
                word.len() >= 5
                    && word.as_bytes().get(2) == Some(&b'_')
                    && word
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })?;
            if !tag.to_lowercase().starts_with(want) {
                return None;
            }
            let name = line.split(tag).next()?.trim();
            (!name.is_empty()).then(|| name.to_string())
        })
        .collect();

    found.sort();
    found.dedup();
    found.retain(|name| {
        // "(Enhanced)" and the rest are the same voice at a better sample
        // rate, so the novelty check has to look at the name before the
        // bracket or "Bells (Enhanced)" walks straight through it.
        let plain = name.split(" (").next().unwrap_or(name).trim();
        !NOVELTY.iter().any(|bad| bad.eq_ignore_ascii_case(plain))
    });

    // A voice someone has downloaded is a voice they wanted: the enhanced and
    // premium ones sound like a person where the compact ones sound like a
    // 2005 satnav, and macOS ships the compact ones by default. If any are
    // installed, bots use those and nothing else.
    let better: Vec<String> = found
        .iter()
        .filter(|name| name.contains("(Enhanced)") || name.contains("(Premium)"))
        .cloned()
        .collect();
    if !better.is_empty() {
        return better;
    }
    found
}

/// espeak-ng's accents, each crossed with its variants.
///
/// `--voices=en` prints a table whose second column is the language tag and
/// whose fourth is the name espeak answers to. The name is what goes before
/// the `+variant`.
fn espeak_voices(want: &str) -> Vec<String> {
    let Some(bin) = espeak() else {
        return Vec::new();
    };
    let Ok(listed) = Command::new(bin).arg(format!("--voices={want}")).output() else {
        return Vec::new();
    };

    let mut bases: Vec<String> = String::from_utf8_lossy(&listed.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let _pty = cols.next()?;
            let tag = cols.next()?;
            if !tag.to_lowercase().starts_with(want) {
                return None;
            }
            let _gender = cols.next()?;
            Some(cols.next()?.to_string())
        })
        .collect();
    bases.sort();
    bases.dedup();
    if bases.is_empty() {
        return Vec::new();
    }

    // Accent first, then throat: a roomful of bots should differ by accent
    // before it starts differing by pitch, because an accent is the thing you
    // notice.
    let mut out = Vec::with_capacity(bases.len() * VARIANTS.len());
    for variant in VARIANTS {
        for base in &bases {
            out.push(format!("{base}+{variant}"));
        }
    }
    out
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

    let voice = voice.filter(|v| !v.is_empty());
    let mut cmd = match std::env::var(CUSTOM) {
        Ok(template) if !template.trim().is_empty() => {
            let mut sh = Command::new("sh");
            sh.arg("-c")
                .arg(template.replace("{voice}", voice.unwrap_or_default()));
            sh
        }
        _ if cfg!(target_os = "macos") => {
            let mut say = Command::new("say");
            if let Some(voice) = voice {
                say.args(["-v", voice]);
            }
            if let Some(rate) = rate {
                say.args(["-r", &rate.to_string()]);
            }
            // Through stdin rather than as an argument: a reply can be longer
            // than a command line is allowed to be, and a bot cut off
            // mid-sentence by an operating system limit would be a strange
            // thing to debug.
            say.arg("-f").arg("-");
            say
        }
        _ => {
            let mut speak = Command::new(espeak().unwrap_or("espeak-ng"));
            if let Some(voice) = voice {
                speak.args(["-v", voice]);
            }
            if let Some(rate) = rate {
                // espeak counts words a minute like `say` does, but starts
                // slower; its own default is 175.
                speak.args(["-s", &rate.to_string()]);
            }
            // No argument at all: espeak reads stdin when given none.
            speak
        }
    };

    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not speak: {e}"))?;

    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(text.as_bytes());
        // Dropped here, closing the pipe: every one of these reads until end
        // of input, and a pipe left open is a voice that never starts.
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

    /// The bug this list exists for: a bot drew Cellos and sang its answer to
    /// Carmina Burana. Funny once.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_bot_is_never_given_a_voice_that_sings() {
        let voices = voices("en");
        if voices.is_empty() {
            return;
        }
        for singing in ["Cellos", "Good News", "Bad News", "Bells", "Organ", "Zarvox"] {
            assert!(
                !voices.iter().any(|v| v.split(" (").next() == Some(singing)),
                "{singing} is still on offer"
            );
        }
    }

    /// Enough of them that a roomful of bots does not repeat itself. Ten is
    /// the number at which a person stops noticing two the same.
    #[test]
    fn a_machine_that_can_speak_at_all_offers_plenty_to_choose_from() {
        let voices = voices("en");
        if voices.is_empty() {
            // No synthesiser installed: bots fall back to the system default
            // and this has nothing to say.
            return;
        }
        assert!(
            voices.len() >= 10,
            "only {} voices — bots will sound alike",
            voices.len()
        );
        let mut sorted = voices.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), voices.len(), "the same voice offered twice");
    }

    /// espeak lists accents; crossing them with variants is what turns four
    /// voices into seventy. The parse is on the shape espeak prints, since
    /// this test has to pass on a Mac too.
    #[test]
    fn espeak_accents_are_read_out_of_its_table() {
        let listing = "\
Pty Language Age/Gender VoiceName          File                 Other Languages
 5  en-029       --/M      English_(Caribbean) gmw/en-029
 2  en-gb        --/M      English_(Great_Britain) gmw/en
 5  en-gb-scotland --/M    English_(Scotland)  gmw/en-GB-scotland
 2  en-us        --/M      English_(America)   gmw/en-US
";
        let names: Vec<String> = listing
            .lines()
            .skip(1)
            .filter_map(|line| {
                let mut cols = line.split_whitespace();
                let _pty = cols.next()?;
                let tag = cols.next()?;
                if !tag.starts_with("en") {
                    return None;
                }
                let _gender = cols.next()?;
                Some(cols.next()?.to_string())
            })
            .collect();
        assert_eq!(
            names,
            [
                "English_(Caribbean)",
                "English_(Great_Britain)",
                "English_(Scotland)",
                "English_(America)"
            ]
        );
    }

    /// Hushing when nothing is talking is the common case — every call to
    /// `speak` starts with one.
    #[test]
    fn hushing_silence_is_not_an_error() {
        hush();
        hush();
    }
}

