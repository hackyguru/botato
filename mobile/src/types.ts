/** Mirrors of the desktop's shapes — only the fields the phone is sent. */
export interface Message {
  id: string;
  from: "me" | "bot";
  text: string;
  at: number;
  /** Sent from a phone rather than the laptop. */
  fromPhone?: boolean;
  note?: string;
}

export interface Routine {
  id: string;
  name: string;
  instruction: string;
  every: "day" | "weekday" | "hour" | "minutes";
  at: string;
  minutes?: number;
  active: boolean;
  lastRunAt?: number;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  color: string;
  shape: string;
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
}
