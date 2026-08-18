/**
 * Talking to a botcage running on a laptop.
 *
 * There is no service in the middle and no account: the phone holds an address
 * and a token, and speaks to that machine directly. Over Tailscale that keeps
 * working away from the house, because the tailnet address goes with the laptop
 * rather than with its network.
 *
 * Every call is POST /api/<kind>, answered by the desktop window itself, so this
 * file knows the transport and nothing about what botcage can do.
 */
import { getItem, removeItem, setItem } from "./storage";

/** Where a paired desktop lives.
 *
 *  Two ways of reaching the same machine. `host` is its address on a network
 *  this phone happens to share; `peer` is its public key, which works from
 *  anywhere and does not change when the laptop moves. A pairing usually has
 *  both, and the peer link is tried first. */
export interface Pairing {
  host: string;
  port: number;
  token: string;
  /** The laptop's peer-to-peer address, if it offered one. */
  peer?: string;
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

export const baseUrl = (host: string, port: number) => `http://${host}:${port}`;

/** How long to wait before deciding a laptop is asleep or off the network. */
const TIMEOUT = 12000;

async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Is a botcage answering here, and what is it? Used before pairing, when there
 *  is no token to authenticate with yet. */
export async function probe(host: string, port: number): Promise<{ app: string; version: string }> {
  const response = await withTimeout(`${baseUrl(host, port)}/api/health`, { method: "GET" });
  if (!response.ok) throw new Error(`that address answered with ${response.status}`);
  const body = await response.json();
  if (body?.app !== "botcage") throw new Error("something else is running on that address");
  return body;
}

/** Trade the code shown on the laptop for a token this phone keeps. */
export async function pair(host: string, port: number, code: string, name: string): Promise<Pairing> {
  const response = await withTimeout(`${baseUrl(host, port)}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? "pairing was refused");
  // The laptop hands over its peer address at the same time, so a phone paired
  // at home keeps working once it leaves.
  const pairing: Pairing = {
    host,
    port,
    token: body.token,
    peer: typeof body.peer === "string" ? body.peer : undefined,
    name: "botcage",
  };
  await savePairing(pairing);
  void openPeerLink(pairing);
  return pairing;
}

export class NotPaired extends Error {}

/** The native peer-to-peer link. Absent in Expo Go and on web, where the app
 *  falls back to reaching the laptop over the local network — so this is loaded
 *  defensively rather than imported, and everything below checks for it. */
type NativeLink = {
  connect(address: string): Promise<string>;
  request(
    method: string,
    path: string,
    token?: string | null,
    body?: string | null,
  ): Promise<{ status: number; body: string }>;
  listen(): void;
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
try {
  native = (require("../modules/botcage-p2p") as { default: NativeLink }).default;
} catch {
  native = null;
}

export const canReachAnywhere = () => native !== null;

/** Open the peer-to-peer link, if this build has one and the pairing names a
 *  laptop by key. Returns whether the link is up. */
export async function openPeerLink(pairing: Pairing): Promise<boolean> {
  if (!native || !pairing.peer) return false;
  try {
    await native.connect(pairing.peer);
    return true;
  } catch {
    // Falling back to the local network is better than refusing to work: at
    // home, the address in the pairing still reaches the same machine.
    return false;
  }
}

/** Ask the desktop to do something. The name is the desktop's action name, so
 *  adding a feature there needs no change here. */
export async function call<T>(
  pairing: Pairing,
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  // Peer-to-peer first when it is available: it is the path that works away
  // from home, and at home it lands on the same machine anyway.
  if (native && pairing.peer && native.isConnected()) {
    const answer = await native
      .request("POST", `/api/${kind}`, pairing.token, JSON.stringify(payload))
      .catch((err: unknown) => {
        throw new Error(err instanceof Error ? err.message : String(err));
      });
    if (answer.status === 401) throw new NotPaired("this phone is no longer paired");
    const parsed = answer.body ? JSON.parse(answer.body) : {};
    if (answer.status >= 400) throw new Error(parsed?.error ?? `the laptop answered ${answer.status}`);
    return parsed as T;
  }

  let response: Response;
  try {
    response = await withTimeout(`${baseUrl(pairing.host, pairing.port)}/api/${kind}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pairing.token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Distinguish "cannot reach the laptop" from "the laptop said no": one is a
    // network problem the person can fix, the other is not.
    throw new Error("can't reach your laptop — is it awake and on Tailscale?");
  }
  if (response.status === 401) throw new NotPaired("this phone is no longer paired");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? `the laptop answered ${response.status}`);
  return body as T;
}

export interface BotEvent {
  botId: string;
  kind: "delta" | "thinking" | "tool" | "rate-limit" | "done" | "error" | "cancelled";
  text?: string;
}

/** Subscribe to everything the desktop is doing. Returns a function that stops
 *  listening — call it when the screen goes away, or the stream outlives it.
 *
 *  Written on XMLHttpRequest rather than an EventSource library because that is
 *  the one streaming primitive React Native and the browser both really have:
 *  the code tested on web is then the same code that runs on the phone. (A
 *  library was tried first and delivered nothing under React Native Web, which
 *  is exactly the sort of difference that would otherwise be found on a device.)
 */
export function listen(
  pairing: Pairing,
  onEvent: (event: BotEvent) => void,
  onOpen?: (connected: boolean) => void,
): () => void {
  // The native link delivers frames as events rather than as a byte stream, so
  // there is nothing to parse here — the sink already cut them apart.
  if (native && pairing.peer && native.isConnected()) {
    const frames = native.addListener("frame", (event) => {
      if (event.name !== "bot-event") return;
      try {
        onEvent(JSON.parse(event.data) as BotEvent);
      } catch {
        /* a frame we can't read is not worth crashing over */
      }
    });
    const state = native.addListener("state", (event) => onOpen?.(event.connected));
    native.listen();
    return () => {
      native?.stop();
      frames.remove();
      state.remove();
    };
  }

  let stopped = false;
  let request: XMLHttpRequest | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  /** responseText only grows, so a stream left open for hours would hold every
   *  token ever sent. Past this, reconnect and let the old buffer go. */
  const MAX_BUFFER = 512 * 1024;

  const parse = (frame: string) => {
    let name = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (name !== "bot-event" || !data) return;
    try {
      onEvent(JSON.parse(data) as BotEvent);
    } catch {
      /* a frame we can't read is not worth crashing over */
    }
  };

  const later = () => {
    if (stopped) return;
    onOpen?.(false);
    retry = setTimeout(connect, 3000);
  };

  const connect = () => {
    if (stopped) return;
    let read = 0;
    const xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open("GET", `${baseUrl(pairing.host, pairing.port)}/api/events`);
    xhr.setRequestHeader("Authorization", `Bearer ${pairing.token}`);
    xhr.setRequestHeader("Accept", "text/event-stream");

    xhr.onreadystatechange = () => {
      if (stopped || request !== xhr) return;
      if (xhr.readyState === 2) {
        onOpen?.(xhr.status === 200);
        return;
      }
      if (xhr.readyState >= 3) {
        // Also here, not only at the header stage: browsers do not reliably
        // report readyState 2 for a streamed response, and a connection
        // indicator that says "reconnecting" while tokens are arriving is
        // worse than none. React ignores a repeat of the same value.
        if (xhr.status === 200) onOpen?.(true);
        const text = xhr.responseText ?? "";
        // Only whole frames: a chunk can arrive split mid-event.
        const pending = text.slice(read);
        const end = pending.lastIndexOf("\n\n");
        if (end >= 0) {
          const whole = pending.slice(0, end);
          read += end + 2;
          for (const frame of whole.split("\n\n")) if (frame.trim()) parse(frame);
        }
        if (text.length > MAX_BUFFER) {
          xhr.abort();
          request = null;
          later();
          return;
        }
      }
      if (xhr.readyState === 4) {
        request = null;
        later();
      }
    };
    xhr.onerror = () => {
      if (request === xhr) request = null;
      later();
    };
    xhr.send();
  };

  connect();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    request?.abort();
    request = null;
  };
}
