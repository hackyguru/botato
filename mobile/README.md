# botcage for phones

A client for a botcage running on your own machine. It holds no state of its
own: the laptop answers every request with the same code its own window uses, so
the phone gets whatever the desktop can do rather than a reimplementation that
drifts.

There is no server of ours in the middle and no account. The phone stores one
address and one token, and talks to that machine directly.

## Reaching a laptop that isn't next to you

On the same network, the laptop's address is enough. Away from it, install
[Tailscale](https://tailscale.com) on both — it gives every device a `100.x`
address that follows it between networks, with nothing forwarded and no ports
opened. botcage's Phone settings show that address first when it finds one.

Traffic to a `100.x` address is encrypted by Tailscale itself, which is why this
speaks plain HTTP: adding TLS on top would mean shipping a certificate for an
address that changes per machine, to protect a tunnel that is already encrypted.
On a plain home network the token still gates access, but the traffic is only as
private as the network is.

## Pairing

1. On the laptop: account menu → **Settings → Phone**, turn on phone access.
2. It shows an address and a six-character code. The code lasts five minutes and
   works once.
3. Type both into this app. The token it gets back goes to the iOS keychain or
   the Android keystore.

**Forget all** in the same settings panel revokes every paired device.

## Running it

```sh
npm install
npx expo start            # then scan the QR code with Expo Go
npx expo start --web      # or run it in a browser
```

The web target is a development convenience — `expo-secure-store` has no web
implementation, so there the token falls back to `localStorage`.

Installing on a device you own needs a build rather than Expo Go:

```sh
npx expo run:ios          # needs Xcode
npx expo run:android      # needs Android Studio, or an attached device
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

`src/api.ts` knows the transport and nothing about what botcage can do — a call
is `POST /api/<action>`, and the action names are the desktop's. Adding a feature
there usually needs no change to this file at all.
