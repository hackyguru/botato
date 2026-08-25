//! Turning what you said into words, on this machine.
//!
//! The webview has a speech recogniser, and botcage does not use it: on macOS
//! it needs a packaged build to exist at all, WebKitGTK has no implementation
//! of it, and nobody outside Apple can say whether the audio stays on the
//! machine. All three are answered by doing it here — whisper.cpp compiled in,
//! a model on disk, and no network involved once it is there.
//!
//! The model is downloaded on first use rather than shipped, which is the same
//! bargain botcage already makes for a container engine. Fifty-odd megabytes
//! is a lot to put in a ten-megabyte app and nothing at all to fetch once.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// Small, English, and quantised.
///
/// The choice is about what a call is for. Utterances are a sentence or two of
/// ordinary speech — "put the build check on Ops for Tuesday" — not dictation
/// of prose, so the accuracy above this size buys little and costs hundreds of
/// megabytes. `base.en` in five-bit quantisation is 57 MB and transcribes a
/// few seconds of speech in a fraction of the time it took to say it.
const MODEL: &str = "ggml-base.en-q5_1.bin";
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin";

/// What whisper wants: sixteen thousand samples a second, one channel.
pub const RATE: u32 = 16_000;

/// The loaded model, kept between utterances.
///
/// Loading it takes long enough to be noticeable and it does not change, so
/// the first press of the talk button pays for it and the rest do not.
static LOADED: Mutex<Option<WhisperContext>> = Mutex::new(None);

fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(MODEL))
}

/// Whether the model is on disk, and how big it is meant to be.
#[must_use]
pub fn ready(app: &AppHandle) -> bool {
    model_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Fetch the model, reporting progress on the way.
///
/// Downloaded beside itself and renamed at the end: a half-written model that
/// merely exists is worse than one that does not, because everything after it
/// would fail with a parse error rather than "not downloaded yet".
pub fn install(app: &AppHandle) -> Result<(), String> {
    let path = model_path(app)?;
    if path.exists() {
        return Ok(());
    }
    let partial = path.with_extension("part");
    let _ = std::fs::remove_file(&partial);

    let handle = app.clone();
    crate::engine::download(
        MODEL_URL,
        &partial,
        &move |note: &str| {
            let _ = handle.emit("hearing", note);
        },
        "Downloading speech model",
    )?;

    std::fs::rename(&partial, &path).map_err(|e| format!("could not save the model: {e}"))?;
    Ok(())
}

/// What was said, from mono 16 kHz samples.
pub fn listen(app: &AppHandle, samples: &[f32]) -> Result<String, String> {
    // Under a fifth of a second is a slipped finger on the talk button, not
    // speech, and whisper will confidently transcribe silence as "thank you".
    if samples.len() < (RATE as usize) / 5 {
        return Ok(String::new());
    }

    let path = model_path(app)?;
    if !path.exists() {
        return Err("the speech model is not downloaded yet".into());
    }

    let mut loaded = LOADED.lock().unwrap_or_else(|held| held.into_inner());
    if loaded.is_none() {
        *loaded = Some(
            WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|e| format!("could not load the speech model: {e}"))?,
        );
    }
    let context = loaded.as_ref().expect("just loaded");

    let mut state = context
        .create_state()
        .map_err(|e| format!("could not start transcribing: {e}"))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    // Nothing of whisper's own goes to stdout: this is a desktop app and its
    // stdout is the log the user reads when something has gone wrong.
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // One utterance, one thought. Whisper will otherwise happily invent a
    // continuation for a sentence that simply stopped.
    params.set_single_segment(true);
    params.set_suppress_blank(true);

    state
        .full(params, samples)
        .map_err(|e| format!("could not transcribe: {e}"))?;

    let mut said = String::new();
    let segments = state.full_n_segments();
    for i in 0..segments {
        if let Some(segment) = state.get_segment(i) {
            if let Ok(text) = segment.to_str() {
                said.push_str(text);
            }
        }
    }
    Ok(tidy(&said))
}

/// Whisper's habitual noises, and the ones it makes when it hears nothing.
///
/// It annotates non-speech in brackets — "(wind blowing)", "[BLANK_AUDIO]" —
/// and given a second of room tone it will produce "Thank you." or "you" with
/// complete confidence. None of that is something a person said, and passing
/// it on as a message to a bot is worse than passing on nothing.
fn tidy(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for c in raw.chars() {
        match c {
            '(' | '[' | '*' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }

    let said = out.trim();
    let bare = said
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase();
    if matches!(
        bare.as_str(),
        "" | "you" | "thank you" | "thanks" | "bye" | "um" | "uh"
    ) {
        return String::new();
    }
    said.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_whisper_hears_in_silence_is_thrown_away() {
        assert_eq!(tidy("[BLANK_AUDIO]"), "");
        assert_eq!(tidy(" Thank you."), "");
        assert_eq!(tidy("(wind blowing)"), "");
        assert_eq!(tidy(" you"), "");
    }

    #[test]
    fn what_a_person_said_survives_intact() {
        assert_eq!(
            tidy(" Put the build check on Ops for Tuesday."),
            "Put the build check on Ops for Tuesday."
        );
        // An annotation in the middle should not take the sentence with it.
        assert_eq!(
            tidy("Schedule it (cough) for nine."),
            "Schedule it  for nine."
        );
    }

    /// "Thanks" is a real thing to say to a bot; the check is on the whole
    /// utterance being nothing but that, not on the word appearing.
    #[test]
    fn a_sentence_containing_thanks_is_not_silence() {
        assert_eq!(
            tidy("Thanks, put it on Tuesday."),
            "Thanks, put it on Tuesday."
        );
    }
}
