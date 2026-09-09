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
//! And when something better is installed, botato will use it: see `CUSTOM`.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// A command to speak with instead of the system's own.
///
/// Set `BOTATO_TTS` to a shell command that reads the text on stdin.
/// `{voice}` is replaced with the bot's voice, and `BOTATO_TTS_VOICES` is the
/// comma-separated list to hand out, so a bot still sounds like itself.
///
/// It may either play the audio itself or write it to stdout, and botato
/// works out which by whether anything came out. That is not cleverness for
/// its own sake: half of these tools play and half write a file, and a seam
/// that only accepted one of those shapes would exclude the tool somebody
/// actually wanted.
///
/// ```text
/// # writes a wav to stdout — botato plays it
/// BOTATO_TTS='pocket-tts generate --voice {voice} --output - --text -'
/// BOTATO_TTS_VOICES='Alba,Giovanni,Estelle,Charles'
///
/// # plays it itself
/// BOTATO_TTS='piper -m {voice}.onnx --output-raw | aplay -q -r 22050 -f S16_LE -t raw -'
/// ```
///
/// This is how Kokoro, Piper, pocket-tts or whatever comes next speaks for a
/// bot without botato shipping a model, an inference engine and a Python
/// runtime to go with them. A ten-megabyte app that speaks well by borrowing
/// beats a three-hundred megabyte one that speaks well by itself.
const CUSTOM: &str = "BOTATO_TTS";
const CUSTOM_VOICES: &str = "BOTATO_TTS_VOICES";

/// Playing a file, when the speaking command wrote one instead of playing it.
fn player(file: &std::path::Path) -> Option<Command> {
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("afplay", &[])]
    } else {
        // Whichever of these a desktop happens to have. `paplay` is on
        // anything running PulseAudio or Pipewire, `aplay` on bare ALSA, and
        // ffplay is on machines that have ffmpeg for some other reason.
        &[
            ("paplay", &[]),
            ("aplay", &["-q"]),
            ("ffplay", &["-nodisp", "-autoexit", "-loglevel", "quiet"]),
        ]
    };

    for (bin, args) in candidates {
        if Command::new(bin)
            .arg("--help")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            let mut cmd = Command::new(bin);
            cmd.args(*args).arg(file);
            return Some(cmd);
        }
    }
    None
}

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
///
/// In order of how good they sound: the model botato manages if it is
/// installed, then whatever `BOTATO_TTS` was pointed at, then the system's
/// own. Installing the model gives every bot a new voice, which is the point
/// of installing it.
#[must_use]
pub fn voices(app: &tauri::AppHandle, language: &str) -> Vec<String> {
    if crate::speech::ready(app) {
        let managed = crate::speech::voices(app);
        if !managed.is_empty() {
            return managed;
        }
    }

    system_voices(language)
}

/// What the machine itself can do, with nothing installed and nothing set.
///
/// Split out because it is the only part a test can reach: everything above it
/// needs a running app to ask where its data lives.
#[must_use]
pub fn system_voices(language: &str) -> Vec<String> {
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
    // 2005 satnav, and macOS ships the compact ones by default.
    //
    // Only when there are enough of them to go round, though. Returning *only*
    // the better ones meant that downloading a single enhanced voice left one
    // voice for every bot on the machine — every one of them suddenly the same
    // person, which is worse than all of them sounding like a satnav.
    let better: Vec<String> = found
        .iter()
        .filter(|name| name.contains("(Enhanced)") || name.contains("(Premium)"))
        .cloned()
        .collect();
    if better.len() >= 6 {
        return better;
    }
    found
}

/// espeak-ng's accents, each crossed with its variants.
///
/// `--voices=en` prints a table: priority, language tag, age and gender, the
/// display name, and the voice file. The **tag** is what `-v` accepts —
/// `en-gb+f3` speaks, `English_(Great_Britain)+f3` produces nothing at all,
/// silently, which is how the first version of this would have left every
/// Linux bot mute. Checked in a Debian container rather than reasoned about.
///
/// The file column says what kind of row it is. `mb/` is mbrola, which needs
/// voice packages installed separately and is silent without them; `!v/` is a
/// variant leaking into the language listing under the tag "variant", which is
/// not a language and speaks nothing. Both were found by generating every
/// voice this produces in a Debian container and listening for the silent
/// ones — twelve of a hundred and twenty were.
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
            let _priority = cols.next()?;
            let tag = cols.next()?;
            if !tag.to_lowercase().starts_with(want) {
                return None;
            }
            let _gender = cols.next()?;
            let _name = cols.next()?;
            let file = cols.next()?;
            if file.starts_with("mb/") || file.starts_with("!v/") {
                return None;
            }
            Some(tag.to_string())
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
pub fn speak(
    app: &tauri::AppHandle,
    text: &str,
    voice: Option<&str>,
    rate: Option<u32>,
) -> Result<(), String> {
    hush();
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    let voice = voice.filter(|v| !v.is_empty());

    // Something the user pointed us at beats something botato installed,
    // which beats the machine's own: a command set by hand is a preference,
    // and a preference outranks a default.
    if let Ok(template) = std::env::var(CUSTOM) {
        if !template.trim().is_empty() {
            return borrowed(
                &template.replace("{voice}", voice.unwrap_or_default()),
                text,
            );
        }
    }

    if crate::speech::ready(app) {
        let (cmd, wav) = crate::speech::command(app, voice, text)?;
        let said = rendered(cmd, &wav);
        let _ = std::fs::remove_file(&wav);
        return said;
    }

    let mut cmd = match () {
        () if cfg!(target_os = "macos") => {
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
        () => {
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

    let _ = wait_for(claim(child))?;
    Ok(())
}

/// Run a synthesiser that writes a file, then play the file.
fn rendered(mut cmd: Command, wav: &std::path::Path) -> Result<(), String> {
    let made = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not speak: {e}"))?;

    // Registered as the thing talking even while it is only rendering, so that
    // interrupting during the pause before any sound stops it, rather than
    // waiting for a sentence nobody wants to hear any more.
    if wait_for(claim(made))?.is_none() || !wav.is_file() {
        return Ok(());
    }

    let played = player(wav)
        .ok_or("nothing on this machine can play audio — install afplay, paplay or aplay")?
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not play the audio: {e}"))?;
    let _ = wait_for(claim(played));
    Ok(())
}

/// Speak with somebody else's synthesiser.
///
/// Waits for it, because that is the contract the caller relies on to know
/// when a mouth stops moving. Anything it wrote to stdout is treated as audio
/// and played; nothing on stdout means it played the audio itself.
fn borrowed(command: &str, text: &str) -> Result<(), String> {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {CUSTOM}: {e}"))?;

    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(text.as_bytes());
    }

    let mine = claim(child);
    // Waiting on the whole thing rather than streaming it: a synthesiser fast
    // enough to be worth borrowing renders a sentence in a fraction of the
    // time it takes to say one, and this keeps the seam a single command
    // rather than a protocol.
    let done = wait_for(mine)?;
    let Some(done) = done else { return Ok(()) };

    if !done.status.success() && done.stdout.is_empty() {
        let why = String::from_utf8_lossy(&done.stderr);
        return Err(format!(
            "{CUSTOM} failed: {}",
            why.lines().last().unwrap_or("no output").trim()
        ));
    }
    if done.stdout.is_empty() {
        // It played the sound itself, and has finished doing so.
        return Ok(());
    }

    let file = std::env::temp_dir().join(format!("botato-said-{mine}.wav"));
    std::fs::write(&file, &done.stdout).map_err(|e| format!("could not save the audio: {e}"))?;
    let played = player(&file)
        .ok_or("nothing on this machine can play audio — install afplay, paplay or aplay")?
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not play the audio: {e}"))?;

    let played = claim(played);
    let _ = wait_for(played);
    let _ = std::fs::remove_file(&file);
    Ok(())
}

/// Register a child as the thing currently talking, and number it.
fn claim(child: Child) -> u64 {
    let mine = {
        let mut count = UTTERANCE.lock().unwrap_or_else(|held| held.into_inner());
        *count += 1;
        *count
    };
    *TALKING.lock().unwrap_or_else(|held| held.into_inner()) = Some((mine, child));
    mine
}

/// Wait for utterance `mine` to finish, or for something to take its place.
///
/// `None` when it was hushed or superseded — which is not a failure, it is
/// somebody deciding they had heard enough.
fn wait_for(mine: u64) -> Result<Option<std::process::Output>, String> {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut talking = TALKING.lock().unwrap_or_else(|held| held.into_inner());
        match talking.as_mut() {
            None => return Ok(None),
            Some((id, _)) if *id != mine => return Ok(None),
            Some((_, child)) => match child.try_wait() {
                Ok(Some(_)) => {
                    let Some((_, child)) = talking.take() else {
                        return Ok(None);
                    };
                    drop(talking);
                    return child
                        .wait_with_output()
                        .map(Some)
                        .map_err(|e| format!("could not read the speech: {e}"));
                }
                Ok(None) => {}
                Err(e) => {
                    *talking = None;
                    return Err(format!("speech ended badly: {e}"));
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
        let voices = system_voices("en");
        if voices.is_empty() {
            return;
        }
        for singing in [
            "Cellos",
            "Good News",
            "Bad News",
            "Bells",
            "Organ",
            "Zarvox",
        ] {
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
        let voices = system_voices("en");
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

    /// The language tag, not the display name — `-v English_(Great_Britain)`
    /// is silent where `-v en-gb` speaks — and no mbrola voices, which are
    /// silent unless their packages were installed separately.
    ///
    /// The listing is real output from `espeak-ng --voices=en` on Debian.
    #[test]
    fn espeak_accents_are_read_out_of_its_table() {
        let listing = "\
Pty Language       Age/Gender VoiceName          File                 Other Languages
 2  en-gb           --/M      English_(Great_Britain) gmw/en               (en 2)
 3  en-uk           --/M      english-mb-en1     mb/mb-en1            (en-gb 3)(en 2)
 2  en-us           --/M      English_(America)  gmw/en-US            (en 3)
 5  en-gb-scotland  --/M      English_(Scotland) gmw/en-GB-scotland   (en 4)
 5  en-us           --/M      us-mbrola-2        mb/mb-us2            (en 7)
 5  variant         --/M      Storm              !v/Storm             (en-us 5)
";
        let tags: Vec<String> = listing
            .lines()
            .skip(1)
            .filter_map(|line| {
                let mut cols = line.split_whitespace();
                let _priority = cols.next()?;
                let tag = cols.next()?;
                if !tag.starts_with("en") {
                    return None;
                }
                let _gender = cols.next()?;
                let _name = cols.next()?;
                let file = cols.next()?;
                if file.starts_with("mb/") || file.starts_with("!v/") {
                    return None;
                }
                Some(tag.to_string())
            })
            .collect();
        assert_eq!(tags, ["en-gb", "en-us", "en-gb-scotland"]);
    }

    /// Hushing when nothing is talking is the common case — every call to
    /// `speak` starts with one.
    #[test]
    fn hushing_silence_is_not_an_error() {
        hush();
        hush();
    }

    /// The borrowed path, end to end, with something that writes a wav to
    /// stdout the way pocket-tts and Kokoro's CLIs do. Ignored by default
    /// because it makes a noise, which is a rude thing for a test suite to do.
    ///
    ///     cargo test --lib borrowed -- --ignored --nocapture
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn a_borrowed_synthesiser_that_writes_a_wav_is_played() {
        let wav = std::env::temp_dir().join("botato-borrow-test.wav");
        let _ = std::fs::remove_file(&wav);
        std::env::set_var(
            CUSTOM,
            format!(
                "cat > /tmp/botato-borrow-in.txt; \
                 say -v Daniel -f /tmp/botato-borrow-in.txt \
                     -o {} --data-format=LEI16@22050 && cat {}",
                wav.display(),
                wav.display()
            ),
        );

        let said = borrowed(
            &std::env::var(CUSTOM).expect("just set"),
            "Borrowed and played.",
        );
        std::env::remove_var(CUSTOM);
        assert!(said.is_ok(), "{said:?}");
    }
}
