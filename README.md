# botcage

Bots that live on your own machine.

Each bot is a persistent session with its own memory and workspace,
and — if you give it one — its own sandboxed Linux desktop with a browser and a
terminal, which you can watch it use. There is a desktop app and a phone app;
the phone reaches the laptop directly, from anywhere, with nothing in between.

Nothing runs on anyone else's computer. There is no account to make, no server
of ours, and no telemetry.

## What you need

- **The Claude Code CLI**, installed and signed in. botcage drives it rather
  than shipping a model, and a Claude Pro or Max subscription covers it. The
  app's setup screen installs it for you if it is missing.
- **Or not**: a bot can instead be pointed at the Gemini CLI, at any model on
  models.dev with an API key you hold, or at Ollama on your own machine, which
  needs nothing.
- **Nothing else** for chat, memory, routines, connectors and plugins.
- **For calls on Linux**, espeak-ng to speak with and one of paplay, aplay or
  ffplay to play with. GStreamer's base and good plugin sets, which a desktop
  will already have, are what let the webview record.
- **A container engine** only if you want bots to have their own computer.
  botcage downloads and manages one itself — lima and the docker CLI on macOS,
  rootless podman on Linux — so Docker Desktop is not required.

## Running it

```sh
pnpm install
pnpm tauri dev
```

Building on Linux needs `cmake`, `clang` and `libclang-dev` on top of the usual
webkit development packages: whisper.cpp is compiled in, and bindgen reads its
headers. On **ARM** Linux, build with `CC=clang CXX=clang++` — gcc refuses
ggml's half-precision NEON intrinsics with "target specific option mismatch",
and clang does not.

Voice is the exception, on macOS. It grants the microphone against an app
bundle's stated reason for wanting it, and `tauri dev` runs a bare executable
with nowhere to state one — so calls can speak but not listen there. `pnpm dev:app`, used instead of `pnpm tauri dev`, runs the same dev build as a
bundle that can — it starts vite itself, and keeps its own scratch roster.

Builds are produced by tagging a release; see [.github/RELEASING.md](.github/RELEASING.md).
macOS builds are signed and notarised, so they open without warnings.

## What a bot is

- **A conversation that persists.** Each bot owns a session and a workspace on
  disk, and remembers across restarts.
- **An engine**: which tool answers for it, chosen per bot.
- **A face.** Head, eyes, brows, a resting smile and a mark — 7,776 combinations
  before colour, derived from the bot's own id so no two look alike. It blinks,
  thinks with a cloud over its head, jumps when a turn lands and slumps when one
  fails. A bot can change its own face when you ask it to, and draw things the
  wardrobe has not got out of a handful of shapes.
- **A voice**, on a call: one of the machine's own, chosen from the bot's id
  the way its face is, and changeable in its settings. macOS has two dozen
  usable ones; Linux has espeak-ng's accents crossed with its variants, which
  is seventy-odd — but neither sounds like a person, so your first call fetches
  one that does. Kyutai's Pocket TTS is 24 recorded people rather than a
  synthesiser, sounds the same on both platforms, and runs on the processor in
  about a second a sentence. It arrives with the speech recogniser on the first
  call anyone makes, and Settings takes it away again. A 130 MB download,
  340 MB on disk, and nothing said leaves the machine.

  Point `BOTCAGE_TTS` at a command to use something else again — Kokoro, Piper,
  whatever comes next — without botcage shipping a model:

  ```sh
  BOTCAGE_TTS='pocket-tts generate --voice {voice} --output - --text -'
  BOTCAGE_TTS_VOICES='Alba,Giovanni,Estelle,Charles'
  ```

  The command reads the text on stdin and may either play the audio or write
  it to stdout; botcage works out which by whether anything came out.
- **A memory file** it maintains itself, seeded from its name and role.
- **Optionally, a computer**: a Linux desktop in a container with Firefox or
  Chromium, a terminal, and a screen you can watch and take over. Each one has
  its own filesystem, network policy, and a machine fingerprint of its own —
  cores, screen size, fonts, locale, rendering — so ten bots do not look like
  one machine wearing ten hats.
- **Routines**: things it does on a schedule, reported into its own chat or
  into a channel.
- **Connectors and plugins**: GitHub, Gmail, Calendar, Notion, Stripe, Vercel
  and others, connected once and scoped per bot.

## What answers for a bot

Claude Code is the default and the one that has been used in anger, but a bot
names its own engine and can be pointed at another in its settings. There are
three:

- **Claude Code** and the **Gemini CLI** — programs botcage runs, each bringing
  its own tool loop and MCP client, so a bot keeps its connectors.
- **Any hosted model**, by way of [models.dev](https://models.dev): one file
  describing 192 providers and 6,841 models, of which 166 providers publish an
  API base and 5,559 models sit behind one. A base URL and a key are the whole
  of what talking to a model takes, so botcage searches that catalogue, keeps
  one key per provider in the keychain, and speaks the chat completions shape
  everyone has settled on. Ollama on your own machine is offered too, and needs
  no key at all.

The seam is [`inference.rs`](src-tauri/src/inference.rs): an engine says how to
run a turn, how to read its output, how it takes a bot's connectors, and which
models it can be asked for. Everything else — the roster, the threads, the
sandbox, the routines, the phone — speaks botcage's vocabulary and never learns
which tool answered.

The difference that is not cosmetic is memory. Claude Code keeps a conversation
on disk and resumes it by id; the Gemini CLI cannot, so botcage keeps a
transcript of every bot itself and replays what fits. That is also why a bot can
change engine mid-conversation and carry the thread across: the transcript
belongs to botcage, not to whatever last answered.

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
camera is not an option, and a `botcage://pair` link does the same for the
phones that have no camera to point — a simulator, mostly.

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

The hosted engine has answered for real — through Ollama on this machine, over
the same API a paid provider speaks — and that test is in the repository. It
carries no tools yet: a bot on it is told so in its prompt rather than being
handed one describing a computer it cannot reach. Running botcage's connectors
for an engine that has no MCP client of its own is the next piece of work, and
the point of the whole seam.

The Gemini CLI is wired up and its flags have been checked against a real
install, but Google has since retired the free personal login for that client,
so it now needs an API key like any other provider. Its stream mapping is
written from documentation rather than from output anyone has watched.
