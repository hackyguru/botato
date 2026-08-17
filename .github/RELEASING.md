# Releasing botcage

Tags matching `v*` build for macOS (both architectures) and Linux, and attach the
bundles to a **draft** release. Nothing is published until you press the button.

```sh
# 1. bump the version in all three files — CI fails if they disagree
#      package.json  ·  src-tauri/tauri.conf.json  ·  src-tauri/Cargo.toml
node .github/scripts/check-version.mjs        # confirm they agree

# 2. tag and push
git tag v0.2.0 && git push origin v0.2.0

# 3. edit and publish the draft release on GitHub
```

## Signing and notarising macOS builds

Without this, macOS refuses to open the app on anyone else's machine — the build
still succeeds, it just produces something Gatekeeper blocks. Everything below is
a one-time setup; afterwards every tagged build is signed and notarised.

### 1. Create a Developer ID Application certificate

Not "Apple Development" — that one only works on machines registered to your
account, which is not what shipping means.

1. In Xcode: **Settings → Accounts → Manage Certificates → + → Developer ID Application**
   (or create a CSR and request it at developer.apple.com/account/resources/certificates)
2. Confirm it landed:
   ```sh
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (TEAMID)"
   ```

### 2. Export it for CI

```sh
# Keychain Access → your certificate → right-click → Export → .p12, set a password
base64 -i certificate.p12 | pbcopy      # this string is APPLE_CERTIFICATE
```

Delete the `.p12` afterwards. It is the private key that signs releases as you.

### 3. Create an app-specific password for notarisation

Your Apple ID password will not work; notarytool needs a dedicated one.

1. appleid.apple.com → **Sign-In and Security → App-Specific Passwords → +**
2. Keep the generated `xxxx-xxxx-xxxx-xxxx` string — that is `APPLE_PASSWORD`

### 4. Add the repository secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the base64 string from step 2 |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set on the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` — exactly as `find-identity` prints it |
| `APPLE_ID` | the Apple ID email on the developer account |
| `APPLE_PASSWORD` | the app-specific password from step 3 |
| `APPLE_TEAM_ID` | the 10-character team id, in brackets in the identity name |

The release workflow already passes all six through. They take effect on the next
tag with no further changes — and while they are absent, builds are unsigned
rather than broken, which is why the release notes explain how to open one.

### 5. Confirm it worked

Download the `.dmg` from the draft release, then:

```sh
codesign -dv --verbose=2 /Applications/botcage.app     # expect "Developer ID Application"
spctl -a -vvv /Applications/botcage.app                # expect "accepted / Notarized Developer ID"
xcrun stapler validate /Applications/botcage.app       # expect "The validate action worked"
```

If `spctl` says accepted but `stapler` fails, the app is signed but the
notarisation ticket was not stapled — usually notarisation timed out, and
re-running the release job fixes it.

## Signing locally

Useful for checking the entitlements actually attach, which cannot be verified
with an ad-hoc signature:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npx tauri build
codesign -d --entitlements - src-tauri/target/release/bundle/macos/botcage.app
```

## Linux

The `.deb` and `.AppImage` are unsigned; Linux has no equivalent gate. CI builds
a `.deb` on every push, so a broken Linux bundle shows up before a tag rather
than during one.

## What a user still needs

Worth keeping in the release notes, because the download is small and the
prerequisites are not:

- **Claude Code CLI** — required, ~220 MB, and must be signed in. botcage drives
  it rather than shipping a model.
- **A container engine** — only for bots given a computer. botcage installs one
  itself; the Linux desktop image is built on first use and takes minutes.
