/** Mirrors of the desktop's shapes — only the fields the phone is sent. */
export interface Message {
  id: string;
  from: "me" | "bot";
  text: string;
  at: number;
  /** In a channel, which bot said it. A private chat has two voices and needs
   *  no attribution; a room has as many as it has members. */
  by?: string;
  /** Kept at the top of the room. */
  pinned?: boolean;
  kind?: "teach" | "routine";
  meta?: { name?: string };
  /** Sent from a phone rather than the laptop. */
  fromPhone?: boolean;
  note?: string;
}

/** A room several bots and you share — or, with `from` set, a thread pulled
 *  out of one message in a room. The laptop treats a thread as a channel with
 *  a parent, and so does this. */
export interface Channel {
  id: string;
  name: string;
  purpose: string;
  /** Bot ids: the phone already has the bots. */
  members: string[];
  messages: Message[];
  seenAt?: number;
  from?: { channelId: string; messageId: string };
  busy: boolean;
}

export interface Routine {
  id: string;
  name: string;
  instruction: string;
  every: "once" | "week" | "day" | "weekday" | "hour" | "minutes";
  at: string;
  minutes?: number;
  /** Which day, for the weekly kind. Sunday is 0. */
  day?: number;
  /** Which date, YYYY-MM-DD, for the one-off kind. */
  date?: string;
  active: boolean;
  lastRunAt?: number;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  color: string;
  shape: string;
  /** What it looks like, when the user or the bot has chosen rather than
   *  accepting what its id implied. Absent fields fall back to that, derived
   *  from the id on this side exactly as they are on the laptop. */
  face?: {
    head?: string;
    eyes?: string;
    brow?: string;
    smile?: string;
    mark?: string;
    /** Shapes a bot drew for itself when the wardrobe had nothing that fit. */
    parts?: {
      shape: string;
      x: number;
      y: number;
      w: number;
      h: number;
      r?: number;
      rot?: number;
      fill?: string;
    }[];
  };
  /** Which of the laptop's engines answers for this bot. Absent from a laptop
   *  running a build from before there was a choice. */
  engine?: string;
  /** In that engine's own vocabulary — "opus" or "gemini-2.5-pro". */
  model: string;
  computer: boolean;
  network: "full" | "no-lan" | "offline";
  plugins: string[];
  routines: Routine[];
  busy: boolean;
  messages: Message[];
  seenAt?: number;
}

/** Something on the laptop that can answer for a bot. The phone shows the list
 *  the laptop sends rather than one of its own: a build of the app that knew
 *  about fewer engines than the desktop would quietly hide the choice. */
export interface EngineInfo {
  key: string;
  name: string;
  ready: { usable: boolean; missing: string | null };
  ownsTranscript: boolean;
  tools: string;
  models: { key: string; name: string; hint: string }[];
}

export interface Snapshot {
  activeId: string | null;
  claudeReady: boolean;
  settings: Record<string, unknown>;
  /** Absent from a laptop running a build older than engines. */
  engines?: EngineInfo[];
  bots: Bot[];
  /** Absent from a laptop running a build older than channels — which is why
   *  everything that reads it copes with there being none. */
  channels?: Channel[];
}
