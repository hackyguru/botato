//! A better voice than the machine's own, fetched and managed by botcage.
//!
//! macOS speaks well enough and Linux does not, and neither sounds like a
//! person. Kyutai's Pocket TTS does, in a hundred megabytes, on the processor,
//! and identically on both — so botcage fetches it the same way it fetches a
//! container engine: on request, into its own directory, and removable.
//!
//! There is no Python here. The model is run by sherpa-onnx, which publishes
//! it as ONNX alongside prebuilt binaries for every platform botcage ships to.
//! Measured on an M-series Mac: 0.66 s for a sentence, cold process, model
//! load included — six times faster than saying it.
//!
//! Voices are reference recordings: the model clones whoever it is given. The
//! ones fetched here are from VCTK by way of Kyutai's voice catalogue, which
//! is a hundred and six different people under a licence that permits it —
//! more distinct voices than macOS ships, and the same set on Linux.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

/// Which sherpa-onnx build this platform wants.
///
/// The `shared` bundles carry ONNX Runtime beside the binary rather than
/// expecting one on the machine, which is the difference between a download
/// that works and a support thread.
const SHERPA: &str = "v1.13.6";

fn sherpa_asset() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "sherpa-onnx-v1.13.6-onnxruntime-1.27.1-osx-arm64-shared.tar.bz2",
        ("macos", "x86_64") => "sherpa-onnx-v1.13.6-osx-x64-shared.tar.bz2",
        ("linux", "x86_64") => "sherpa-onnx-v1.13.6-linux-x64-shared.tar.bz2",
        _ => return None,
    })
}

const MODEL: &str = "sherpa-onnx-pocket-tts-int8-2026-01-26";
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2";

/// Where the voices come from, and who they are.
///
/// Twenty-four of VCTK's hundred and six speakers, spread across the corpus so
/// they are not all from one recording session. Enough that a roomful of bots
/// never repeats itself, and small enough to fetch in a moment; the rest are
/// there for the asking if twenty-four ever stops being enough.
const VOICES_URL: &str = "https://huggingface.co/kyutai/tts-voices/resolve/main/vctk";
const VOICES: &[&str] = &[
    "p225", "p228", "p231", "p234", "p237", "p240", "p243", "p246", "p249", "p252", "p255", "p258",
    "p261", "p264", "p267", "p270", "p273", "p276", "p279", "p282", "p285", "p288", "p292", "p295",
];

fn home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("speech"))
}

fn binary(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = home(app)?.join("bin");
    // The tarball unpacks into a directory named for the release, and the name
    // carries the ONNX Runtime version — so it is found rather than spelled.
    let found = std::fs::read_dir(&dir)
        .map_err(|_| "speech engine not installed".to_string())?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("bin").join("sherpa-onnx-offline-tts"))
        .find(|path| path.is_file());
    found.ok_or_else(|| "speech engine not installed".into())
}

/// Whether the engine, the model and at least one voice are all here.
///
/// All three, because any one of them missing produces a different unhelpful
/// error later, and "not installed" is the truthful answer to all of them.
#[must_use]
pub fn ready(app: &AppHandle) -> bool {
    let Ok(dir) = home(app) else { return false };
    binary(app).is_ok()
        && dir.join(MODEL).join("lm_main.int8.onnx").is_file()
        && !voices(app).is_empty()
}

/// The voices installed, by the name a bot is given.
#[must_use]
pub fn voices(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = home(app) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir.join("voices")) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "wav" {
                return None;
            }
            Some(path.file_stem()?.to_string_lossy().into_owned())
        })
        .collect();
    found.sort();
    found
}

/// Fetch the engine, the model and the voices. Reports progress as it goes.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let asset = sherpa_asset().ok_or(
        "no prebuilt speech engine for this platform — botcage will keep using the system voice",
    )?;
    let dir = home(app)?;
    std::fs::create_dir_all(dir.join("bin")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir.join("voices")).map_err(|e| e.to_string())?;

    let say = {
        let handle = app.clone();
        move |note: &str| {
            let _ = handle.emit("speech", note);
        }
    };

    if binary(app).is_err() {
        let tar = dir.join("engine.tar.bz2");
        crate::engine::download(
            &format!("https://github.com/k2-fsa/sherpa-onnx/releases/download/{SHERPA}/{asset}"),
            &tar,
            &say,
            "Downloading the speech engine",
        )?;
        unpack(&tar, &dir.join("bin"))?;
        let _ = std::fs::remove_file(&tar);
    }

    if !dir.join(MODEL).join("lm_main.int8.onnx").is_file() {
        let tar = dir.join("model.tar.bz2");
        crate::engine::download(MODEL_URL, &tar, &say, "Downloading the voice model")?;
        unpack(&tar, &dir)?;
        let _ = std::fs::remove_file(&tar);
    }

    // Small enough to fetch one at a time, and one that fails is one voice
    // fewer rather than a failed install.
    for (at, speaker) in VOICES.iter().enumerate() {
        let to = dir.join("voices").join(format!("{speaker}.wav"));
        if to.is_file() {
            continue;
        }
        say(&format!("Fetching voices — {} of {}", at + 1, VOICES.len()));
        let _ = crate::engine::download(
            &format!("{VOICES_URL}/{speaker}_023_enhanced.wav"),
            &to,
            &|_| {},
            "voice",
        );
    }

    if !ready(app) {
        return Err("the speech engine did not install completely".into());
    }
    Ok(())
}

/// Remove it, and go back to the machine's own voice.
pub fn forget(app: &AppHandle) -> Result<(), String> {
    let dir = home(app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove it: {e}"))?;
    }
    Ok(())
}

fn unpack(tar: &Path, into: &Path) -> Result<(), String> {
    let out = Command::new("tar")
        .arg("xf")
        .arg(tar)
        .arg("-C")
        .arg(into)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("could not unpack: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!(
        "could not unpack: {}",
        String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
    ))
}

/// The command that turns text into a wav file, and where it will land.
///
/// sherpa writes a file rather than a stream, so the caller plays it and
/// removes it. At two thirds of a second for a sentence that is a round trip
/// nobody hears, and it keeps this a command rather than a protocol.
pub fn command(app: &AppHandle, voice: Option<&str>, text: &str) -> Result<(Command, PathBuf), String> {
    let dir = home(app)?;
    let model = dir.join(MODEL);
    let chosen = voice
        .filter(|v| !v.is_empty())
        .map(|v| dir.join("voices").join(format!("{v}.wav")))
        .filter(|p| p.is_file())
        .or_else(|| voices(app).first().map(|v| dir.join("voices").join(format!("{v}.wav"))))
        .ok_or("no voices installed")?;

    let out = std::env::temp_dir().join(format!(
        "botcage-speech-{}.wav",
        std::process::id() as u64 + text.len() as u64
    ));

    let mut cmd = Command::new(binary(app)?);
    cmd.arg(format!("--pocket-lm-flow={}", model.join("lm_flow.int8.onnx").display()))
        .arg(format!("--pocket-lm-main={}", model.join("lm_main.int8.onnx").display()))
        .arg(format!("--pocket-encoder={}", model.join("encoder.onnx").display()))
        .arg(format!("--pocket-decoder={}", model.join("decoder.int8.onnx").display()))
        .arg(format!(
            "--pocket-text-conditioner={}",
            model.join("text_conditioner.onnx").display()
        ))
        .arg(format!("--pocket-vocab-json={}", model.join("vocab.json").display()))
        .arg(format!(
            "--pocket-token-scores-json={}",
            model.join("token_scores.json").display()
        ))
        .arg(format!("--reference-audio={}", chosen.display()))
        .arg(format!("--output-filename={}", out.display()))
        .arg("--num-threads=4")
        .arg(text);
    Ok((cmd, out))
}
