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
#    Leave "Set as a pre-release" ticked — the workflow ticks it for you.
```

## Everything is a pre-release

The workflow sets `prerelease: true` and it stays that way while botcage is
alpha. Leave the box ticked when publishing the draft; GitHub remembers the flag
from the release the workflow created, and unticking it is a one-click way to
promise a stability nothing here has.

Two things depend on that being true rather than on it looking tidy:

- **`releases/latest` does not exist** while every release is a pre-release —
  the API answers 404 and the web page redirects nowhere. Nothing should link
  there. The app, the README and the site all point at `/releases`, and
  [`update.rs`](../src-tauri/src/update.rs) reads the releases *list* and picks
  the highest version itself.
- **The release notes lead with the alpha and no-warranty disclaimer**, because
  the release page is where most people meet botcage for the first time. It is
  in `releaseBody` in [the workflow](workflows/release.yml); keep it at the top
  when the rest of the notes are edited.

Promoting a release to stable one day means: untick the flag, and put
`releases/latest` back in the four places above.

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

Delete the `.p12` once the secret is saved — it is the key that signs releases as
you. Nothing is lost by deleting it: the certificate and its key stay in the
keychain, so it can be re-exported whenever another CI needs it.

### 3. Create an app-specific password for notarisation

Your Apple ID password will not work; notarytool needs a dedicated one.

1. appleid.apple.com → **Sign-In and Security → App-Specific Passwords → +**
2. Keep the generated `xxxx-xxxx-xxxx-xxxx` string — that is `APPLE_PASSWORD`

> **Read the team id off the Developer ID certificate, not the Development one.**
> On an Apple Development certificate the name's parenthetical is the *individual*
> id and the team id hides in the OU field; on a Developer ID certificate both are
> the team id. Taking the wrong one makes notarisation fail with an error that
> does not mention the team at all:
>
> ```sh
> security find-certificate -c "Developer ID Application" -p \
>   ~/Library/Keychains/login.keychain-db | openssl x509 -noout -subject
> ```

### 4. Add the repository secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the base64 string from step 2 |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set on the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Kumaraguru Thambidurai (6DJWZ77R6C)` — exactly as `find-identity` prints it |
| `APPLE_ID` | the Apple ID email on the developer account |
| `APPLE_PASSWORD` | the app-specific password from step 3 |
| `APPLE_TEAM_ID` | `6DJWZ77R6C` |

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
export APPLE_SIGNING_IDENTITY="Developer ID Application: Kumaraguru Thambidurai (6DJWZ77R6C)"
npx tauri build --bundles app
codesign -dv --verbose=2 src-tauri/target/release/bundle/macos/botcage.app
codesign -d --entitlements - --xml src-tauri/target/release/bundle/macos/botcage.app
```

A correctly signed, not-yet-notarised build looks like this — `rejected` is the
right answer at this stage, and only notarisation changes it:

```
Authority=Developer ID Application: Kumaraguru Thambidurai (6DJWZ77R6C)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
flags=0x10000(runtime)
spctl: rejected, source=Unnotarized Developer ID
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
