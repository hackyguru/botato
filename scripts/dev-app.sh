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
#   pnpm dev              # in one terminal — the vite server, nothing else
#   pnpm dev:app          # in another — builds, wraps, and runs it
#
# Not `pnpm tauri dev`: that owns its own copy of the binary and starts it
# again the moment this one replaces it.
#
# This keeps its own bots. WebKit files a page's storage under the bundle
# identifier, and a bare binary has none — so `tauri dev` and any bundle were
# always going to be two different rosters, and the honest thing is to make
# that deliberate rather than surprising. It means an experiment here cannot
# lose a bot you cared about. The way to actually use voice is a normal
# `pnpm tauri build`, where the same Info.plist is merged in for real.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
binary="$here/src-tauri/target/debug/botcage"
app="$here/src-tauri/target/botcage-dev.app"

if ! curl -sf -o /dev/null --max-time 2 http://localhost:1420; then
  echo "Nothing serving on :1420 — run 'pnpm dev' in another terminal first." >&2
  exit 1
fi

echo "→ building"
(cd "$here/src-tauri" && cargo build --quiet)

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/botcage"

# The usage descriptions come from the same file the release build uses, so
# there is one place to change what macOS shows the person being asked.
python3 - "$here" "$app" <<'PY'
import plistlib, sys
from pathlib import Path

root, app = Path(sys.argv[1]), Path(sys.argv[2])
info = plistlib.loads((root / "src-tauri" / "Info.plist").read_bytes())
info.update({
    "CFBundleExecutable": "botcage",
    # Its own identifier, so this is a scratch copy rather than the real one.
    "CFBundleIdentifier": "com.hackyguru.botcage.dev",
    "CFBundleName": "botcage (dev)",
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
open "$app"
