/**
 * Talking to a botcage running on your own machine.
 *
 * One connection, one set of rules, wherever the two devices happen to be. The
 * laptop listens on nothing but its own loopback, so there is no port open on
 * any network it joins; the only way in is a QUIC connection whose encryption
 * and identity come from the laptop's key. Same room or different continent,
 * the guarantees are identical — and a café's Wi-Fi learns nothing beyond the
 * fact that some encrypted traffic went past.
 *
 * Two things must hold for a request to be answered: it came from this phone's
 * key, and it carried this phone's token. A token copied off this device is
 * refused from any other.
 *
 * This file knows the transport and nothing about what botcage can do — a call
 * is POST /api/<action>, and the action names belong to the desktop.
 */
import { getItem, removeItem, setItem } from "./storage";

/** A paired laptop.
 *
 *  There is no address here because there is none worth keeping: the laptop is
 *  named by its public key, which is the same at home, on a train, and behind
 *  someone else's router. */
export interface Pairing {
  /** The laptop's peer-to-peer address: its key, and where it was last seen. */
  peer: string;
  token: string;
  /** What the desktop calls itself, for the screen that lists connections. */
  name: string;
}

const STORE_KEY = "botcage.pairing";

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    return null;
  }
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await setItem(STORE_KEY, JSON.stringify(pairing));
}

export async function clearPairing(): Promise<void> {
  await removeItem(STORE_KEY);
}

export class NotPaired extends Error {}

/** The native peer-to-peer link. Absent in Expo Go and on the web target, where
 *  there is no way to speak QUIC — so it is loaded defensively, and every path
 *  below says plainly when it is missing rather than failing obscurely. */
type NativeLink = {
  connect(address: string): Promise<string>;
  request(
    method: string,
    path: string,
    token?: string | null,
    body?: string | null,
  ): Promise<{ status: number; body: string }>;
  listen(token?: string | null): void;
  stop(): void;
  isConnected(): boolean;
  addListener(
    name: "frame",
    handler: (event: { name: string; data: string }) => void,
  ): { remove(): void };
  addListener(
    name: "state",
    handler: (event: { connected: boolean }) => void,
  ): { remove(): void };
};

let native: NativeLink | null = null;
/** Why the link is missing, if it is. Reported rather than swallowed: the first
 *  version of this hid a wrong import path behind the same message a build
 *  without native code would show, which is a bad way to lose an afternoon. */
let linkProblem = "";
try {
  // The local module's entry point is the file, not the directory — there is no
  // package.json here to resolve an index for us.
  native = (require("../modules/botcage-p2p/src/index") as { default: NativeLink }).default;
} catch (err) {
  native = null;
  linkProblem = err instanceof Error ? err.message : String(err);
}

export const hasLink = () => native !== null;

const NO_LINK = `botcage can't open a connection — it needs a development build${
  linkProblem ? ` (${linkProblem})` : ""
}`;

function link(): NativeLink {
  if (!native) throw new Error(NO_LINK);
  return native;
}

/** Is a botcage answering at this address, and what is it?
 *
 *  Used before pairing, when there is no token yet. The connection is already
 *  encrypted and the laptop's key already proven by then — this only asks what
 *  is on the other end. */
export async function probe(address: string): Promise<{ app: string; version: string }> {
  const peer = link();
  await peer.connect(address);
  const answer = await peer.request("GET", "/api/health", null, null);
  const body = answer.body ? JSON.parse(answer.body) : {};
  if (body?.app !== "botcage") throw new Error("something else answered at that address");
  return body;
}

/** Trade the code shown on the laptop for a token this phone keeps.
 *
 *  The laptop refuses to pair with anything whose key it has not established,
 *  and binds the token it hands back to this phone's key. */
export async function pair(address: string, code: string, name: string): Promise<Pairing> {
  const peer = link();
  await peer.connect(address);
  const answer = await peer.request(
    "POST",
    "/api/pair",
    null,
    JSON.stringify({ code: code.trim().toUpperCase(), name }),
  );
  const body = answer.body ? JSON.parse(answer.body) : {};
  if (answer.status >= 400) throw new Error(body?.error ?? "pairing was refused");

  const pairing: Pairing = {
    // Prefer the address the laptop gives for itself; fall back to the one that
    // just worked. Either way the key inside it survives the laptop moving.
    peer: typeof body.peer === "string" && body.peer ? body.peer : address,
    token: body.token,
    name: "botcage",
  };
  await savePairing(pairing);
  return pairing;
}

/** Make sure the link is open, reconnecting if a sleeping phone dropped it. */
async function connected(pairing: Pairing): Promise<NativeLink> {
  const peer = link();
  if (!peer.isConnected()) await peer.connect(pairing.peer);
  return peer;
}

/** Ask the laptop to do something. The name is the desktop's action name, so
 *  adding a feature there needs no change here. */
export async function call<T>(
  pairing: Pairing,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  let answer: { status: number; body: string };
  try {
    const peer = await connected(pairing);
    answer = await peer.request("POST", `/api/${kind}`, pairing.token, JSON.stringify(payload));
  } catch (err) {
    // Tell "cannot reach the laptop" apart from "the laptop said no": one is
    // something the person can fix, the other is not.
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(why === NO_LINK ? why : `can't reach your laptop — ${why}`);
  }
  if (answer.status === 401) throw new NotPaired("this phone is no longer paired");
  const body = answer.body ? JSON.parse(answer.body) : {};
  if (answer.status >= 400) throw new Error(body?.error ?? `the laptop answered ${answer.status}`);
  return body as T;
}

export interface BotEvent {
  botId: string;
  kind: "delta" | "thinking" | "tool" | "rate-limit" | "done" | "error" | "cancelled";
  text?: string;
}

/** Subscribe to everything the laptop is doing. Returns a function that stops
 *  listening — call it when the screen goes away, or the stream outlives it.
 *
 *  Frames arrive already cut apart by the native side, so there is no parsing
 *  here and no buffer that could grow without bound. */
export function listen(
  pairing: Pairing,
  onEvent: (event: BotEvent) => void,
  onOpen?: (connected: boolean) => void,
): () => void {
  if (!native) {
    onOpen?.(false);
    return () => {};
  }
  const peer = native;

  const frames = peer.addListener("frame", (event) => {
    if (event.name !== "bot-event") return;
    try {
      onEvent(JSON.parse(event.data) as BotEvent);
    } catch {
      /* a frame we can't read is not worth crashing over */
    }
  });
  const state = peer.addListener("state", (event) => onOpen?.(event.connected));

  void connected(pairing)
    .then(() => peer.listen(pairing.token))
    .catch(() => onOpen?.(false));

  return () => {
    peer.stop();
    frames.remove();
    state.remove();
  };
}
