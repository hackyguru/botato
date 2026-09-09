#!/bin/bash
# Run the dev build as a real app bundle, so macOS will grant it a microphone.
#
# `tauri dev` runs a bare executable whose embedded Info.plist has three keys:
# a name and two version strings. macOS grants the microphone and the speech
# recogniser against an app bundle's stated reason for wanting them, and a bare
# binary has nowhere to state one — so voice input fails with
# "service-not-allowed", which names the refusal and not the reason.
#
# This wraps the same binary in the smallest bundle that has somewhere to put
# that sentence. Everything else about the dev loop is unchanged: it still
# loads from the vite dev server, so edits still reload.
#
#   pnpm dev:app          # instead of `pnpm tauri dev`
#
# It starts the vite server if nothing is serving yet, so it is the whole dev
# loop rather than half of one. Use it *instead of* `pnpm tauri dev`, not
# alongside: that owns its own copy of the binary and starts it again the
# moment this one replaces it, leaving two windows, one of which cannot hear
# you — which is exactly the confusion this script exists to end.
#
# This gets its own roster. WebKit files a page's storage under the bundle
# identifier and a bare binary has none, so `tauri dev` and any bundle were
# always going to list different bots — better deliberate than surprising, and
# it means an experiment here cannot lose a bot you cared about. What it does
# share is everything Rust keeps: workspaces, sessions and the speech model all
# live under the identifier baked into the binary, so the model is downloaded
# once for both. The way to actually use voice is a normal `pnpm tauri build`,
# where the same Info.plist is merged in for real.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
binary="$here/src-tauri/target/debug/botato"
app="$here/src-tauri/target/botato-dev.app"

if pgrep -f "tauri.js dev" >/dev/null 2>&1; then
  echo "'pnpm tauri dev' is running — quit it first. This replaces it." >&2
  exit 1
fi

if ! curl -sf -o /dev/null --max-time 2 "http://localhost:1420"; then
  echo "→ starting vite"
  # Fully detached, all three streams closed: a background child that keeps
  # this script's stdout open leaves the terminal hanging after the app is
  # already on screen, which reads as the script having failed.
  (cd "$here" && nohup pnpm dev </dev/null >/dev/null 2>&1 &)
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null --max-time 1 "http://localhost:1420" && break
    sleep 0.5
  done
  curl -sf -o /dev/null --max-time 1 "http://localhost:1420" || {
    echo "vite did not come up on :1420" >&2
    exit 1
  }
fi

echo "→ building"
(cd "$here/src-tauri" && cargo build --quiet)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/botato"

# The icon, which a bundle has somewhere to put and a bare binary does not —
# the same reason this script exists for the microphone. Without it the dev app
# sits in the Dock as a blank sheet of paper, and every change to the icon looks
# like it did nothing.
cp "$here/src-tauri/icons/icon.icns" "$app/Contents/Resources/icon.icns"

# The usage descriptions come from the same file the release build uses, so
# there is one place to change what macOS shows the person being asked. The URL
# scheme comes from tauri.conf.json for the same reason: the real bundler reads
# it from there, and a dev bundle that claimed a different one would answer
# links the shipped app does not.
python3 - "$here" "$app" <<'PY'
import json, plistlib, sys
from pathlib import Path

root, app = Path(sys.argv[1]), Path(sys.argv[2])
info = plistlib.loads((root / "src-tauri" / "Info.plist").read_bytes())
conf = json.loads((root / "src-tauri" / "tauri.conf.json").read_text())
schemes = conf.get("plugins", {}).get("deep-link", {}).get("desktop", {}).get("schemes", [])
if schemes:
    info["CFBundleURLTypes"] = [{
        "CFBundleURLName": conf["identifier"],
        "CFBundleURLSchemes": schemes,
    }]
info.update({
    "CFBundleExecutable": "botato",
    # Named without the extension, which is how CFBundleIconFile has always
    # wanted it; CFBundleIconName is what newer macOS reads.
    "CFBundleIconFile": "icon",
    "CFBundleIconName": "icon",
    # Its own identifier, so this is a scratch copy rather than the real one.
    "CFBundleIdentifier": "com.hackyguru.botato.dev",
    "CFBundleName": "botato (dev)",
    "CFBundlePackageType": "APPL",
    "CFBundleShortVersionString": "0.0.0-dev",
    "CFBundleVersion": "0.0.0-dev",
    "LSMinimumSystemVersion": "11.0",
})
(app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))
PY

# Ad-hoc, but with the release entitlements: the hardened runtime refuses
# protected resources to an app that has not asked for them, and the
# microphone is one.
codesign --force --sign - --entitlements "$here/src-tauri/entitlements.plist" "$app" >/dev/null 2>&1

echo "→ $app"
# The executable directly rather than `open`: LaunchServices starts an app with
# a login environment, so anything exported here — BOTATO_TTS, a different
# CLAUDE_BIN — would be dropped on the floor, which is most of the reason to
# run a dev build at all. macOS still reads the bundle around the binary, so
# the microphone permission this whole script exists for is unaffected.
exec "$app/Contents/MacOS/botato"
