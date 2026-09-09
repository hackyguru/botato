# botato for phones

A client for a botato running on your own machine. It holds no state of its
own: the laptop answers every request with the same code its own window uses, so
the phone gets whatever the desktop can do rather than a reimplementation that
drifts.

There is no server of ours in the middle and no account. The phone stores one
address and one token, and talks to that machine directly.

## How it reaches your laptop, and why that is safe

Your laptop listens on nothing. The API is bound to its own loopback address, so
no port is open on any network it joins — a café's Wi-Fi has nothing to find.

The only way in is a QUIC connection made directly between the two devices, in
which the laptop's identity *is* its public key. That gives the same guarantees
wherever you are:

- **Encrypted end to end.** When a direct path cannot be punched through a NAT,
  packets fall back to public relays, which forward ciphertext and hold no key
  that could open it.
- **The laptop cannot be impersonated.** Reaching it means holding its private
  key, so nothing on the network can stand in for it.
- **Your phone cannot be impersonated either.** The laptop records this phone's
  key at pairing time and binds the token to it. A token copied off this device
  is refused from any other, even with the right code.
- **Same network, same rules.** At home the two connect directly over the LAN —
  faster, and encrypted exactly as it is from a train.

## Pairing

1. On the laptop: account menu → **Settings → Phone**, turn on phone access.
2. It shows an address and a six-character code. The code lasts five minutes and
   works once.
3. Paste both into this app. The token it gets back goes to the iOS keychain or
   the Android keystore.

A code lasts five minutes, works once, and is burned after five wrong guesses.

**Forget all** in the same settings panel revokes every paired device.

## Running it

Speaking QUIC needs native code, so Expo Go cannot run this app — it needs a
development build:

```sh
../mobile/rust/build.sh   # builds the link for both platforms
npx expo run:ios          # needs Xcode and CocoaPods
npx expo run:android      # needs a JDK and the Android SDK
```

## What it does

Bots, conversations with live streaming, creating and deleting bots, per-bot
model, network and computer settings, routines, and starting or stopping a bot's
desktop.

Two things it does not do. **Watching a bot's desktop** is not here yet — the
desktop app streams VNC to a canvas, and doing that on a phone needs a viewer
this doesn't have; start the desktop from the phone and watch it on the laptop.
**Connecting a plugin** signs in through a browser on the laptop, so it stays a
laptop job; the phone shows which are connected.

## Layout

| File | What it is |
| --- | --- |
| `src/api.ts` | The transport: pairing, calls, and the event stream |
| `src/storage.ts` | Where the token lives, per platform |
| `App.tsx` | Screen switching, and the local copy of the laptop's state |
| `src/screens/` | Pair, Bots, Chat, BotSettings |

`src/api.ts` knows the transport and nothing about what botato can do — a call
is `POST /api/<action>`, and the action names are the desktop's. Adding a feature
there usually needs no change to this file at all.
