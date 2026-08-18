/**
 * The phone's peer-to-peer link to a botcage.
 *
 * Deliberately shaped like the HTTP client it stands in for: a request in, a
 * status and a body out, and a stream of frames. The app then has one idea of
 * what botcage is and two ways of reaching it — over the local network, or
 * from anywhere at all.
 */
import { NativeModule, requireNativeModule } from "expo";

export interface Response {
  status: number;
  body: string;
}

export interface P2pEvents {
  // Expo's event map wants an index signature; the two named events below are
  // the ones this module actually sends.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: (...args: any[]) => void;
  /** One server-sent event frame from the desktop. */
  frame: (event: { name: string; data: string }) => void;
  /** Whether the event stream is up. */
  state: (event: { connected: boolean }) => void;
}

declare class BotcageP2pModule extends NativeModule<P2pEvents> {
  /** Open this phone's endpoint and note which laptop to talk to. Returns this
   *  phone's own identity. The address is a full one at pairing time, or the
   *  laptop's public key afterwards. */
  connect(address: string): Promise<string>;
  request(method: string, path: string, token?: string | null, body?: string | null): Promise<Response>;
  /** Start the event stream. Returns at once; frames arrive as events. The
   *  token is required — the laptop refuses an unauthenticated stream. */
  listen(token?: string | null): void;
  stop(): void;
  isConnected(): boolean;
}

export default requireNativeModule<BotcageP2pModule>("BotcageP2p");
