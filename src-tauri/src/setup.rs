//! Getting a new machine ready: the Claude Code CLI, its sign-in, and the
//! container engine.
//!
//! botcage drives the CLI rather than shipping a model, so without it a bot
//! cannot answer at all. That made it the one thing a new user had to discover
//! from a toast and install by hand, which is the wrong way round: the app knows
//! whether it is there, knows how to install it, and can say what is missing.
//!
//! Two things are deliberately not automated. Signing in opens a terminal
//! instead of being driven here — the flow is Anthropic's, it wants a browser
//! and a TTY, and a half-finished attempt of our own could clear a working
//! session. And the installer is Anthropic's published script, run as the user
//! rather than with any privilege, with what it will run shown first.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

/// Anthropic's own installer. Native build, installs under $HOME, needs neither
/// node nor a package manager nor root — which is why this is what onboarding
/// runs rather than the npm line.
const INSTALLER: &str = "https://claude.ai/install.sh";

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeState {
    pub path: Option<String>,
    pub version: Option<String>,
    /// Installed *and* signed in. Bots cannot reply without both, and a signed
    /// out CLI looks exactly like a working one until the first turn fails.
    pub signed_in: bool,
    pub email: Option<String>,
    /// "max", "pro", "team" — or "API" when billing runs through a key.
    pub plan: Option<String>,
    /// Set when the CLI is there but could not be asked about its account.
    pub trouble: Option<String>,
}

/// What onboarding shows for the CLI. `claude auth status --json` is the source
/// for the account half: it costs no tokens, answers in about a sixth of a
/// second, and is the CLI's own opinion rather than a guess at where it keeps
/// credentials — which differs between macOS's keychain and a file on Linux.
#[tauri::command(async)]
pub fn claude_state() -> ClaudeState {
    let Some(bin) = crate::locate_claude() else {
        return ClaudeState::default();
    };
    let version = Command::new(&bin)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|out| out.trim().to_string());

    let mut state = ClaudeState {
        path: Some(bin.display().to_string()),
        version,
        ..Default::default()
    };

    match Command::new(&bin)
        .args(["auth", "status", "--json"])
        .output()
    {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(status) => {
                    state.signed_in = status["loggedIn"].as_bool().unwrap_or(false);
                    state.email = status["email"].as_str().map(str::to_string);
                    state.plan = status["subscriptionType"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| {
                            (status["apiProvider"].as_str()? != "firstParty").then(|| "API".into())
                        });
                }
                // An older CLI without `auth status` prints usage instead of
                // JSON. Not being able to ask is not the same as being signed
                // out, so say so rather than sending someone to sign in again.
                Err(_) => state.trouble = Some("this build cannot report its account".into()),
            }
        }
        Err(e) => state.trouble = Some(e.to_string()),
    }
    state
}

/// Run Anthropic's installer, relaying its output as it goes. Not piped from
/// curl into a shell: the script is fetched, then run from disk, so what is
/// executed is a file that exists rather than a stream nobody can inspect.
#[tauri::command(async)]
pub fn install_claude(app: AppHandle) -> Result<String, String> {
    let say = |line: &str| {
        let _ = app.emit("claude-setup", line);
    };

    let script = std::env::temp_dir().join("botcage-install-claude.sh");
    say("Fetching the installer…");
    let fetched = Command::new("curl")
        .args(["-fsSL", "-o"])
        .arg(&script)
        .arg(INSTALLER)
        .output()
        .map_err(|e| format!("could not run curl: {e}"))?;
    if !fetched.status.success() {
        return Err(format!(
            "could not download the installer: {}",
            String::from_utf8_lossy(&fetched.stderr).trim()
        ));
    }

    say("Installing Claude Code…");
    let mut child = Command::new("bash")
        .arg(&script)
        .arg("stable")
        // The installer refuses to run under sudo and installs under $HOME, so
        // it runs exactly as the person who launched botcage.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run the installer: {e}"))?;

    let mut tail = String::new();
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if !line.is_empty() {
                say(&line);
                tail = line;
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&script);

    if !status.success() {
        let mut why = String::new();
        if let Some(mut err) = child.stderr.take() {
            use std::io::Read;
            let _ = err.read_to_string(&mut why);
        }
        let last = why
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or(&tail);
        return Err(format!("the installer stopped: {}", last.trim()));
    }

    // Believe the filesystem, not the exit code: the point of the step is that
    // botcage can find the binary afterwards, and it looks in fixed places.
    crate::locate_claude()
        .map(|bin| bin.display().to_string())
        .ok_or_else(|| {
            "the installer finished but botcage cannot find claude — a restart may fix it".into()
        })
}

/// Open a terminal running the sign-in. It needs a browser and a real terminal,
/// so this hands over rather than pretending to own the flow; onboarding then
/// watches `claude auth status` and moves on by itself once it succeeds.
#[tauri::command(async)]
pub fn claude_sign_in() -> Result<(), String> {
    let bin = crate::locate_claude().ok_or("Claude Code is not installed yet")?;
    let command = format!("{} auth login", shell_quote(&bin));

    if cfg!(target_os = "macos") {
        let out = Command::new("osascript")
            .args(["-e", &terminal_script(&command)])
            .output()
            .map_err(|e| format!("could not open Terminal: {e}"))?;
        return if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        };
    }

    // Linux has no such guarantee, so try what is usually installed. The
    // Debian alternative comes first because it points at whatever the user
    // actually chose.
    let terminals = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "alacritty",
        "kitty",
        "xterm",
    ];
    for terminal in terminals {
        let spawned = Command::new(terminal)
            .arg("-e")
            .args(["sh", "-c"])
            .arg(format!("{command}; echo; read -p 'Press enter to close '"))
            .spawn();
        if spawned.is_ok() {
            return Ok(());
        }
    }
    Err(format!(
        "botcage could not find a terminal to open. Run this yourself:  {command}"
    ))
}

/// The AppleScript that opens Terminal on a command. Two levels of quoting are
/// in play — AppleScript's, then the shell's — and a Mac home directory with a
/// space in it is ordinary, so this is built in one place and tested.
fn terminal_script(command: &str) -> String {
    let quoted = command.replace('\\', r"\\").replace('"', r#"\""#);
    format!(
        "tell application \"Terminal\" to do script \"{quoted}\"\n\
         tell application \"Terminal\" to activate"
    )
}

/// Quote a path for a shell. Paths with spaces are ordinary on macOS, and the
/// sign-in command is assembled into a shell line.
fn shell_quote(path: &std::path::Path) -> String {
    let text = path.display().to_string();
    if text
        .chars()
        .all(|c| c.is_alphanumeric() || "._-/".contains(c))
    {
        return text;
    }
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn paths_with_spaces_survive_the_shell() {
        assert_eq!(
            shell_quote(Path::new("/Users/guru/.local/bin/claude")),
            "/Users/guru/.local/bin/claude"
        );
        assert_eq!(
            shell_quote(Path::new("/Users/a b/.local/bin/claude")),
            "'/Users/a b/.local/bin/claude'"
        );
        // A quote in a path would otherwise end the argument early.
        assert_eq!(
            shell_quote(Path::new("/tmp/it's/claude")),
            r"'/tmp/it'\''s/claude'"
        );
    }

    #[test]
    fn the_terminal_script_survives_two_levels_of_quoting() {
        let command = format!(
            "{} auth login",
            shell_quote(Path::new("/Users/a b/.local/bin/claude"))
        );
        let script = terminal_script(&command);
        // The shell needs the single quotes; AppleScript passes them through.
        assert!(
            script.contains(r#"do script "'/Users/a b/.local/bin/claude' auth login""#),
            "{script}"
        );
        assert!(script.ends_with(r#"tell application "Terminal" to activate"#));

        // A double quote in the path is what would end AppleScript's string
        // early, so it has to arrive escaped.
        let odd = terminal_script(&shell_quote(Path::new(r#"/tmp/a"b/claude"#)));
        assert!(odd.contains(r#"do script "'/tmp/a\"b/claude'""#), "{odd}");
    }

    /// Proves the shape onboarding depends on, against the real CLI: the fields
    /// it reads and the fact that asking costs nothing.
    #[test]
    #[ignore = "needs the Claude Code CLI installed and signed in"]
    fn the_cli_reports_its_account() {
        let state = claude_state();
        assert!(state.path.is_some(), "no CLI found");
        assert!(state.version.is_some(), "no version");
        assert!(state.signed_in, "not signed in: {:?}", state.trouble);
        assert!(state.email.is_some(), "no account email");
        println!(
            "  {} · {} · {}",
            state.version.unwrap_or_default(),
            state.email.unwrap_or_default(),
            state.plan.unwrap_or_default()
        );
    }
}
