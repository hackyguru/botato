<p align="center">
	<img width="150" height="150" src="src-tauri/icons/Square310x310Logo.png" alt="botcage logo">
</p>

<h1 align="center">botcage</h1>

<p align="center">
	Bots that live on your own machine. Each one gets a memory, a schedule and a computer of its own. Shut the lid and they carry on.
</p>

<p align="center">
	<a href="https://github.com/hackyguru/botcage/releases/latest">Download</a>
	·
	<a href="#what-a-bot-gets">What a bot gets</a>
	·
	<a href="#get-started">Get started</a>
	·
	<a href="mobile/README.md">Phone app</a>
	·
	<a href="#local-development">Develop</a>
</p>

<p align="center">
	<a href="https://github.com/hackyguru/botcage/releases"><img src="https://img.shields.io/github/v/release/hackyguru/botcage?include_prereleases&label=release" alt="Latest release"></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/hackyguru/botcage" alt="Apache 2.0"></a>
	<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-lightgrey" alt="Platforms">
	<img src="https://img.shields.io/badge/binary-~11%20MB-brightgreen" alt="About 11 MB">
</p>

> [!WARNING]
> **botcage is alpha software, provided as is and without warranty of any kind.**
> Every release is a pre-release. Bots run commands, drive a browser, use accounts
> you connect to them, spend money against your own API keys and act on a schedule
> while nobody is watching. Language models are unpredictable and can be
> manipulated by content they read. **What your bots do is your responsibility.**
> Do not give one access to anything you cannot afford to lose, break or expose,
> and keep your own backups. Sections 7 and 8 of [Apache 2.0](LICENSE) say the
> same thing in the usual words.

## Why botcage

- **It runs on your computer.** No account to make, no server of ours, no telemetry. Your bots, files, keys and conversations never leave the machine.
- **A bot is somewhere, not something.** Each one owns a session and a workspace on disk and remembers across restarts, rather than being a box you type into and close.
- **They share rooms.** A channel holds several bots and you. They read what the others said and answer each other, which is the difference between a set of assistants and colleagues.
- **They work while you are away.** Routines run on a schedule and report back. botcage holds the machine awake for them and on a Mac it can keep the lid from stopping them.
- **Your phone reaches them.** Directly, from anywhere, with nothing in between.
- **Bring your own model.** Claude Code by default, or the Gemini CLI, or any of 5,559 hosted models, or Ollama on your own machine for nothing.

## What a bot gets

| | |
| --- | --- |
| **A memory** | A session and workspace on disk that survives restarts, plus a memory file it maintains itself, seeded from its name and role |
| **A face** | Head, eyes, brows, a resting smile and a mark. 7,776 combinations before colour, derived from the bot's own id so no two look alike. It blinks, thinks with a cloud overhead, jumps when a turn lands and slumps when one fails |
| **A voice** | One of the machine's own, or Kyutai's Pocket TTS: 24 recorded people rather than a synthesiser, fetched on the first call, about a second a sentence on the processor. Nothing said leaves the machine |
| **A computer** | Optional. A Linux desktop in a container with Firefox or Chromium, a terminal and a screen you can watch or take over. Each has its own filesystem, network policy and machine fingerprint, so ten bots do not look like one machine wearing ten hats |
| **Routines** | Work it does on a schedule, reported into its own chat or into a channel |
| **Connectors** | GitHub, Gmail, Calendar, Notion, Stripe and others, connected once and scoped per bot. botcage runs its own OAuth flows and keeps the tokens in your system keychain |
| **An engine** | Which tool answers for it, chosen per bot and changeable mid-conversation |

## Rooms, not just conversations

- **Say who you mean.** Type `@` and it offers whoever is in the room. `@everyone` is yours alone: a bot cannot summon the room. A message naming nobody is addressed to the room, which works out who should take it.
- **Threads, pins and unread marks**, with a brighter mark when a bot used your name.
- **Call the room.** Faces side by side, whoever has the floor lit, one voice at a time. Every word is written into the channel as it is said, so the meeting is minuted before it ends.
- **Stand-ups.** A routine can be a meeting rather than an instruction. Every bot in the channel takes a turn and none is asked how its week went: each is handed what actually ran, what it said, what broke and what is next on its own calendar. A bot with nothing to report says so.

## What answers for a bot

| Engine | What it needs | Notes |
| --- | --- | --- |
| **Claude Code** (default) | The CLI, signed in | A Claude Pro or Max subscription covers it. Setup installs the CLI if it is missing |
| **Gemini CLI** | The CLI and an API key | Google has retired the free personal login for this client |
| **Any hosted model** | A base URL and a key you hold | 166 providers and 5,559 models, by way of [models.dev](https://models.dev) |
| **Ollama** | Nothing at all | On your own machine, no key and no cost |

The seam is [`inference.rs`](src-tauri/src/inference.rs): an engine says how to run a turn, how to read its output, how it takes a bot's connectors and which models it can be asked for. Everything else, from the roster to the sandbox to the phone, speaks botcage's own vocabulary and never learns which tool answered.

The difference that is not cosmetic is memory. Claude Code keeps a conversation on disk and resumes it by id. The Gemini CLI cannot, so botcage keeps a transcript of every bot itself and replays what fits. That is also why a bot can change engine mid-conversation and carry the thread across: the transcript belongs to botcage rather than to whatever last answered.

## Your data stays here

- **Nothing runs on anyone else's computer.** The API is bound to loopback, so no port is open on any network the machine joins.
- **Connectors are botcage's own.** It disables claude.ai's connectors and runs its own OAuth flows, so a flow you completed once is not repeated because you changed model.
- **Backups are one encrypted file**, written on a schedule to a folder you name. Point it at iCloud Drive, Dropbox or a disk you plug in. It carries no API keys, no OAuth tokens and no phone pairing, so it is not a credential store.
- **The format is written down.** Argon2id to XChaCha20-Poly1305, the cost parameters travelling in the header and authenticated with it. [`scripts/open-backup.py`](scripts/open-backup.py) recovers a backup with nothing but Python and `cryptography`, on a machine that has never seen botcage.

## Get started

1. **Download** the [latest release](https://github.com/hackyguru/botcage/releases/latest) for macOS or Linux. macOS builds are signed and notarised, so they open without warnings.
2. **Pick an engine.** Setup installs the Claude Code CLI for you, or point a bot at Ollama and pay nothing.
3. **Make a bot.** Give it a name and a line about what it is for. Everything after that happens on your machine.
4. **Optionally give it a computer.** botcage downloads and manages a container engine itself: lima and the docker CLI on macOS, rootless podman on Linux. Docker Desktop is not required.
5. **Optionally pair your phone.** Scan the QR code the laptop shows.

## The phone app

[`mobile/`](mobile/) is a React Native app for iOS and Android. It holds no state of its own: every request is answered by the desktop window using the same code its own UI calls, so the phone gets whatever the desktop can do rather than a second implementation that drifts. Calls are the one thing it cannot do yet.

**How it reaches your laptop.** The only way in is a QUIC connection made directly between the two devices, in which the laptop's identity *is* its public key ([iroh](https://iroh.computer)). Same guarantees at home and on mobile data:

- Encrypted end to end. When a direct path cannot be punched through a NAT, packets fall back to public relays that forward ciphertext they cannot read.
- The laptop cannot be impersonated without its private key and neither can your phone: the token it is given is bound to the phone's own key, so a copy is refused from any other device.
- No account, no tailnet, no port forwarding, nothing of ours in the middle.

**Pairing** is a QR code the laptop shows and the phone scans, carrying the laptop's address and a six-character code that lasts five minutes, works once and is burned after five wrong guesses.

Speaking QUIC needs native code, so the app needs a development build rather than Expo Go. See [mobile/README.md](mobile/README.md).

## Local development

**Requirements**

- [pnpm](https://pnpm.io) and a Rust toolchain.
- **On Linux**, `cmake`, `clang` and `libclang-dev` on top of the usual webkit development packages: whisper.cpp is compiled in and bindgen reads its headers.
- **On ARM Linux**, build with `CC=clang CXX=clang++`. gcc refuses ggml's half-precision NEON intrinsics with "target specific option mismatch" and clang does not.
- **For calls on Linux**, espeak-ng to speak with and one of paplay, aplay or ffplay to play with. GStreamer's base and good plugin sets, which a desktop will already have, are what let the webview record.

**Commands**

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `pnpm tauri dev` | Run the desktop app |
| `pnpm dev:app` | The same dev build as a bundle, with its own scratch roster |

`pnpm dev:app` exists because of one macOS rule: the microphone is granted against an app bundle's stated reason for wanting it and `tauri dev` runs a bare executable with nowhere to state one. Calls can speak but not listen under `tauri dev`.

**Custom speech.** Point `BOTCAGE_TTS` at a command to use Kokoro, Piper or whatever comes next, without botcage shipping a model:

```sh
BOTCAGE_TTS='pocket-tts generate --voice {voice} --output - --text -'
BOTCAGE_TTS_VOICES='Alba,Giovanni,Estelle,Charles'
```

The command reads the text on stdin and may either play the audio or write it to stdout. botcage works out which by whether anything came out.

Builds are produced by tagging a release. See [.github/RELEASING.md](.github/RELEASING.md).

## Repository map

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The desktop UI. Vanilla TypeScript, no framework |
| [`src-tauri/src/`](src-tauri/src/) | The Rust side: turns, sandboxes, connectors, plugins, the phone server |
| [`sandbox/`](sandbox/) | The Linux desktop image a bot's computer runs |
| [`mobile/`](mobile/) | The phone app and the Rust crate that gives it QUIC |
| [`website/`](website/) | The marketing site |

Worth knowing about the Rust: [`engine.rs`](src-tauri/src/engine.rs) is the *container* engine botcage installs and [`inference.rs`](src-tauri/src/inference.rs) is what answers for a bot. Different things, unfortunately similar words.

## Status

Version 0.6.0 and honest about what that means.

| | |
| --- | --- |
| **Desktop and sandboxes** | Used daily |
| **iOS** | Pairs, streams replies, survives restarts and has reached a laptop at home from a phone on mobile data |
| **Android** | Builds and runs, but only exercised against a stand-in desktop |
| **Hosted engines** | Answered for real through Ollama over the same API a paid provider speaks, with tools. That test is in the repository |
| **Gemini CLI** | Wired up and its flags checked against a real install. Its stream mapping is written from documentation rather than from output anyone has watched |

Small local models are the honest weak point. llama3.2:3b calls a tool correctly from a clean conversation and then, once its own history contains a tool call it wrote out as prose, will happily imitate itself instead of calling anything. Bigger models do not do this and nothing in botcage can stop a model that does. The bound on that loop is twelve rounds.

## Why it is small

The desktop binary is about 11 MB because it uses the system webview instead of bundling a browser. Most of that is QUIC and whisper.cpp. The models it speaks and listens with are fetched on first use rather than shipped, which is why adding them cost a megabyte here rather than four hundred.

## Contributing

Issues and pull requests are welcome. The codebase is small and the seams are documented at the top of each Rust module, so start there.

## Licence

[Apache-2.0](LICENSE). Use it, fork it, build on it, ship it in something you sell. The licence asks only that you keep the notice and say what you changed.

The name is not part of that grant: `LICENSE` covers the code and the Apache licence explicitly does not hand over trademarks. Fork it and call it something of your own.
