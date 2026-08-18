/** Mirrors of the desktop's shapes — only the fields the phone is sent. */
export interface Message {
  id: string;
  from: "me" | "bot";
  text: string;
  at: number;
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
  model: string;
  computer: boolean;
  network: "full" | "no-lan" | "offline";
  plugins: string[];
  routines: Routine[];
  busy: boolean;
  messages: Message[];
}

export interface Snapshot {
  activeId: string | null;
  claudeReady: boolean;
  settings: Record<string, unknown>;
  bots: Bot[];
}
