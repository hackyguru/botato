# botcage

Bots that live on your own machine.

Each bot is a persistent Claude Code session with its own memory and workspace,
and — if you give it one — its own sandboxed Linux desktop with a browser and a
terminal, which you can watch it use. There is a desktop app and a phone app;
the phone reaches the laptop directly, from anywhere, with nothing in between.

Nothing runs on anyone else's computer. There is no account to make, no server
of ours, and no telemetry.

## What you need

- **The Claude Code CLI**, installed and signed in. botcage drives it rather
  than shipping a model, and a Claude Pro or Max subscription covers it. The
  app's setup screen installs it for you if it is missing.
- **Nothing else** for chat, memory, routines, connectors and plugins.
- **A container engine** only if you want bots to have their own computer.
  botcage downloads and manages one itself — lima and the docker CLI on macOS,
  rootless podman on Linux — so Docker Desktop is not required.

## Running it

```sh
pnpm install
pnpm tauri dev
```

Builds are produced by tagging a release; see [.github/RELEASING.md](.github/RELEASING.md).
macOS builds are signed and notarised, so they open without warnings.

## What a bot is

- **A conversation that persists.** Each bot owns a Claude Code session and a
  workspace on disk, and remembers across restarts.
- **A memory file** it maintains itself, seeded from its name and role.
- **Optionally, a computer**: a Linux desktop in a container with Firefox or
  Chromium, a terminal, and a screen you can watch and take over. Each one has
  its own filesystem, network policy, and a machine fingerprint of its own —
  cores, screen size, fonts, locale, rendering — so ten bots do not look like
  one machine wearing ten hats.
- **Routines**: things it does on a schedule.
- **Connectors and plugins**: GitHub, Gmail, Calendar, Notion, Stripe, Vercel
  and others, connected once and scoped per bot.

## Connectors are botcage's own

botcage disables claude.ai's connectors and runs its own OAuth flows, storing
tokens in your system keychain. That is not only about privacy: a connector that
lives in botcage can be handed to whatever answers for a bot, so an OAuth flow
you completed once does not have to be repeated because you changed model.

MCP is how a connector is implemented, not something an engine has to
understand — see [`inference.rs`](src-tauri/src/inference.rs).

## The phone app

[`mobile/`](mobile/) is a React Native app for iOS and Android. It holds no state
of its own: every request is answered by the desktop window using the same code
its own UI calls, so the phone gets whatever the desktop can do rather than a
second implementation that drifts.

**How it reaches your laptop.** The laptop listens on nothing — the API is bound
to loopback, so no port is open on any network it joins. The only way in is a
QUIC connection made directly between the two devices, in which the laptop's
identity *is* its public key ([iroh](https://iroh.computer)). Same guarantees at
home and on mobile data:

- Encrypted end to end; when a direct path cannot be punched through a NAT,
  packets fall back to public relays that forward ciphertext they cannot read.
- The laptop cannot be impersonated without its private key, and your phone
  cannot either: the token it is given is bound to the phone's own key, so a
  copy is refused from any other device.
- No account, no tailnet, no port forwarding, nothing of ours in the middle.

**Pairing** is a QR code the laptop shows and the phone scans, carrying the
laptop's address and a six-character code that lasts five minutes, works once,
and is burned after five wrong guesses. Typing it by hand is kept for when a
camera is not an option.

Speaking QUIC needs native code, so the app needs a development build rather
than Expo Go — see [mobile/README.md](mobile/README.md).

## Layout

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The desktop UI — vanilla TypeScript, no framework |
| [`src-tauri/src/`](src-tauri/src/) | The Rust side: turns, sandboxes, connectors, plugins, the phone server |
| [`sandbox/`](sandbox/) | The Linux desktop image a bot's computer runs |
| [`mobile/`](mobile/) | The phone app, and the Rust crate that gives it QUIC |

Worth knowing about the Rust: [`engine.rs`](src-tauri/src/engine.rs) is the
*container* engine botcage installs, and [`inference.rs`](src-tauri/src/inference.rs)
is what answers for a bot. Different things, unfortunately similar words.

## Why it is small

The desktop binary is about 10 MB because it uses the system webview instead of
bundling a browser. Most of that is now QUIC and its dependencies; the app
itself is a fraction of it.

## Status

Version 0.1.0, and honest about what that means. The desktop app and its
sandboxes have been used daily. The phone client runs on iOS and Android, pairs
by scanning the square on the laptop, streams replies, survives restarts, and
has reached a laptop at home from a phone on mobile data — which is the claim
the whole transport rests on, so it is worth saying that it has actually been
done rather than merely designed for.

Android is built and runs, but has only been exercised against a stand-in
desktop, never a real one.

Support for engines other than Claude Code is a seam, not a feature: the shape
is defined and every turn goes through it, but only one engine exists so far.
