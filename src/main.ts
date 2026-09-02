/**
 * botcage — desktop bot roster + threads, modelled on the Grok bot app UI.
 *
 * Each bot is a Claude Code session: turns run through the local `claude` CLI
 * (see src-tauri/src/lib.rs), authenticated by the user's own login.
 */

import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { Music } from "./music";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import RFB from "@novnc/novnc";

type Shape = "circle" | "squircle" | "drop";

interface Message {
  id: string;
  from: "me" | "bot";
  /** What the model receives. For a teach turn this is the instructions, which
      the thread renders as a badge rather than showing verbatim. */
  text: string;
  at: number;
  /** Sent from a paired phone rather than this window. Shown on the bubble,
   *  because a thread read the next morning gives no other clue that you wrote
   *  it from a train. */
  fromPhone?: boolean;
  reaction?: string;
  /** Kept at the top of the room, because a channel of bots working scrolls
   *  and the decision you want tomorrow is somewhere in the middle of it. */
  pinned?: boolean;
  error?: string;
  kind?: "teach" | "routine";
  /** A question the bot left with its answers ready to press.
   *
   *  `answered` is which one was pressed, kept so the row can show what you
   *  chose rather than vanishing — a thread read the next morning should still
   *  say what the question was and what you said to it. */
  ask?: { question?: string; options: string[]; answered?: string };
  meta?: { steps: number; frames: number; slug: string; name?: string };
  /** In a channel, which bot said it. A private chat has two voices and needs
   *  no attribution; a room has as many as it has members. */
  by?: string;
}

/** A room, rather than a chat.
 *
 *  A bot's own thread is between the two of you. A channel is shared: several
 *  bots and you, everyone reading everything, and a bot able to bring another
 *  in by name. It is the difference between asking two people separately and
 *  putting them in a room, and it is worth the machinery because the second
 *  thing is what people actually do at work. */
interface Channel {
  id: string;
  /** Without the "#", which is decoration the app adds. */
  name: string;
  /** What the room is for, in the user's words. Every member is told, because
   *  a channel with no stated purpose gets answered as though it were a chat. */
  purpose: string;
  /** Bot ids. Order is the order they were added, which is the order their
   *  faces appear in the header. */
  members: string[];
  messages: Message[];
  /** When you last had this room open. Anything said after it is unread, which
   *  is the only way a room full of bots talking to each other is bearable —
   *  otherwise you have to remember where you got to. */
  seenAt?: number;
  /** A thread: the room it hangs off and the message it started from.
   *
   *  A thread is a channel with a parent and nothing else different, which is
   *  why it gets members, per-bot sessions, its own transcript, mentions, hop
   *  budgets, unread marks and calls without any of that being written twice.
   *  The only reason to have a separate kind of thing would be to reimplement
   *  all of it. */
  from?: { channelId: string; messageId: string };
  /** Silenced: no unread mark, no badge, no notification.
   *
   *  Bots talk to each other, so a room of them is the one place in botcage
   *  that can be genuinely noisy — and a room you cannot quieten is a room you
   *  end up leaving. Muting is not leaving: everything still happens in there
   *  and is still read when you open it.
   *
   *  It does not touch the desk. A mark says something was said; the desk says
   *  something will not move until you answer — and muting a room is saying
   *  you do not want to be told about it, not that you have stopped owing it
   *  an answer. */
  muted?: boolean;
  /** Which category it sits under in the sidebar, if any. Absent means the
   *  ungrouped ones at the top, which is where Discord puts them and where a
   *  channel that has never been filed belongs. */
  category?: string;
  /** Each member's own conversation in this room, kept apart from its chat:
   *  a bot in #finance should not have last night's private thread replayed at
   *  it, and what it says here should not turn up there. */
  seats: Record<string, { sessionId: string; started: boolean }>;
}

/** A heading in the sidebar with channels under it.
 *
 *  Nothing hangs off a category but the ordering: a channel in one is the same
 *  channel, and deleting one leaves its channels where every unfiled channel
 *  is. That is the whole of what makes it safe to let someone make these
 *  freely — the worst case is a heading you stop using. */
interface Category {
  id: string;
  name: string;
  /** Collapsed. Its channels are hidden, except any with something unread —
   *  a category cannot be a way to miss things. */
  shut?: boolean;
}

/** A standing instruction a bot runs on a schedule. */
interface Routine {
  id: string;
  name: string;
  instruction: string;
  /** How often. "once" is a task rather than a routine, and switches itself
   *  off after it has run; the rest recur until they are turned off. */
  every: "once" | "week" | "day" | "weekday" | "hour" | "minutes";
  /** Time of day, HH:MM. Ignored by the "every few minutes" kind. */
  at: string;
  /** Gap in minutes, for the "every few minutes" kind. */
  minutes?: number;
  /** Which day, for the weekly kind. Sunday is 0, as in Date#getDay. */
  day?: number;
  /** Which date, YYYY-MM-DD, for the one-off kind. */
  date?: string;
  /** The bot that scheduled this, when it was not the user. Shown wherever the
   *  routine is, because work on your calendar that you did not put there
   *  needs to say where it came from. */
  by?: string;
  /** A meeting rather than an instruction.
   *
   *  A standup is a routine that, instead of asking one bot to do something,
   *  gives everyone in the room a turn — each handed its own week rather than
   *  an open question. Only means anything when it reports into a channel:
   *  a meeting of one is a note to self. */
  format?: "standup" | "review";
  /** Which channel it reports into. Absent means the bot's own chat, which is
   *  where every routine used to go — and the reason a watchdog that checks
   *  the build every half hour was shouting into a room nobody visits. */
  channel?: string;
  active: boolean;
  lastRunAt?: number;
}

interface Bot {
  id: string;
  /** The one bot botcage makes for you, which teaches the app. It blinks, and
   *  its thread carries lessons rather than a blank page. Delete it whenever it
   *  has served its purpose — nothing else depends on it existing. */
  guide?: boolean;
  name: string;
  role: string;
  color: string;
  shape: Shape;
  messages: Message[];
  /** Claude Code session UUID — stable for the bot's whole lifetime. */
  sessionId: string;
  /** True once a session exists on disk, so later turns can `--resume`. */
  started: boolean;
  /** May this bot have a desktop at all? Off means it is never told it has one. */
  computer: boolean;
  /** What that desktop may reach. */
  network: "full" | "no-lan" | "offline";
  /** Which tool answers for this bot: a key from `engines`. Absent on every
   *  bot made before there was a choice, which is why everything that reads it
   *  falls back rather than failing. */
  engine?: string;
  /** Which provider answers, for an engine that is an API rather than a
   *  program: a models.dev id, or "ollama" for the one on this machine. */
  provider?: string;
  /** When you last had this bot's chat open. See `Channel.seenAt`. */
  seenAt?: number;
  /** When it works, if it does not work all the time.
   *
   *  Routines only. A message you send at midnight is you talking to it and it
   *  answers — hours are about the work it does on its own, which is the work
   *  that spends money while nobody is watching. */
  hours?: { from: string; to: string; days: number[] };
  /** What it has cost, and what it has cost this week.
   *
   *  Kept per bot and saved, because the interesting question is not what this
   *  window has spent since it opened — it is which of them is expensive. The
   *  week resets itself by holding the Monday it belongs to. */
  spend?: { turns: number; usd: number; week: string; weekTurns: number; weekUsd: number };
  /** How it sounds on a call. Absent means the one its id chose for it, which
   *  is what almost every bot will have — the picker exists for the one you
   *  want to sound different, not because anybody wants to choose fifty
   *  times. */
  voice?: string;
  /** How it writes, as distinct from what it says. Absent means the one its id
   *  chose, the same way its face and its voice are chosen; "plain" is the way
   *  to say no. */
  manner?: string;
  /** Which of that engine's models. Named in the engine's own vocabulary, so
   *  "opus", "gemini-2.5-pro" and "anthropic/claude-sonnet-4" all live here. */
  model: string;
  routines?: Routine[];
  /** Named jobs this bot answers to, which typing "/" offers.
   *
   *  Declared by the bot rather than configured here: it knows what it is
   *  asked for, and a list somebody has to maintain by hand is a list that
   *  goes stale the week after it is written. */
  commands?: { name: string; what: string }[];
  /** MCP server keys this bot may use. Absent means none. */
  plugins?: string[];
  /** What it looks like, when the user has chosen rather than accepted what
   *  its id implied. Absent fields fall back to that. */
  face?: {
    head?: string;
    eyes?: string;
    brow?: string;
    smile?: string;
    mark?: string;
    /** What it drew for itself, when the wardrobe had nothing that fit. */
    parts?: Part[];
  };
  /** How this bot's computer presents itself. Absent fields follow the app
   *  defaults; set ones make it a different machine from its siblings. */
  machine?: {
    browser?: string;
    rendering?: string;
    screen?: string;
    cores?: number;
    window?: string;
    fonts?: string;
    language?: string;
  };
}

/** One plugin offered by a Claude Code marketplace. */
interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  marketplace: string;
  installed: boolean;
  /** Publisher avatar; empty when the source gives us nothing. */
  icon: string;
  sourceUrl: string;
  homepage: string;
  /** Whether this machine can run it. null until verified. */
  usable: boolean | null;
  /** Why not, when it cannot. */
  note: string;
}

/** A service botcage connects to itself, holding the credential for it. */
interface Connector {
  key: string;
  name: string;
  description: string;
  tokenLabel: string;
  helpUrl: string;
  needsToken: boolean;
  /** Connects by showing a code the user approves in their browser. */
  needsDevice: boolean;
  /** This bot holds its own credential rather than using the shared one. */
  ownAccount: boolean;
  /** Connects by opening a browser and coming back — no setup, no keys. */
  needsOauth: boolean;
  /** A credential is accepted but not required. */
  tokenOptional: boolean;
  /** Needs a consent round trip and the user's own Google OAuth client. */
  needsGoogle: boolean;
  redirectUri: string;
  icon: string;
  scopes: string[];
  connected: boolean;
}

/** An MCP server this machine can reach — now only ones plugins brought. */
interface Plugin {
  key: string;
  name: string;
  status: string;
  connector: boolean;
}

type SandboxState =
  | "stopped"
  | "building"
  | "starting"
  | "running"
  | "error"
  | "no-docker"
  | "no-computer";

interface SandboxEvent {
  botId: string;
  kind: "log" | "state";
  text?: string;
  state?: SandboxState;
  vncPort?: number | null;
  controlPort?: number | null;
}

interface BotEvent {
  botId: string;
  kind: "delta" | "thinking" | "tool" | "rate-limit" | "done" | "error" | "cancelled";
  text?: string;
  detail?: { status?: string; rateLimitType?: string; resetsAt?: number } | null;
}

const COLORS = ["#0a84ff", "#8e8e93", "#e0393e", "#ff5a00", "#ffb020", "#30d158", "#bf5af2"];
const SHAPES: Shape[] = ["circle", "squircle", "drop"];
const STORE = "botcage.state.v3";
/** Earlier builds persisted canned demo threads — don't carry them forward. */
const STALE_STORES = ["botcage.state.v1", "botcage.state.v2"];

/** Fallback model for bots created before the per-bot setting existed. */
const MODEL = "opus";

interface Persisted {
  bots: Bot[];
  /** Phones that have said where Apple should deliver to them. Kept per token
   *  rather than per device: a reinstall issues a new one, and the old one is
   *  a phone that no longer exists. */
  phones?: { token: string; sandbox: boolean; name: string; at: number }[];
  /** Absent on every state saved before rooms existed. */
  channels?: Channel[];
  /** Absent on every state saved before categories existed. */
  categories?: Category[];
  activeId: string | null;
  /** The room on screen, if it is a room rather than a bot. */
  activeChannel?: string | null;
  /** Whether the desktop pane is docked open, and how big. */
  screenOpen?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  /** Sidebar collapsed to a rail by choice (it also collapses when cramped). */
  railed?: boolean;
  app?: AppSettings;
}

/** Settings that belong to botcage rather than to one bot. */
interface AppSettings {
  /** How a new bot is answered by default — the choice made in setup. Absent on
   *  a settings file written before there was one, which means Claude Code. */
  engine?: string;
  /** With which provider, for the hosted engine. */
  provider?: string;
  model: string;
  screen: string;
  idleMinutes: number;
  routinesOn: boolean;
  /** Hold a power assertion so the machine doesn't idle-sleep. */
  awake: boolean;
  /** What the user asked to be called. Absent until setup asks, and absent
   *  again if they clear it — at which point the login name stands in. */
  name?: string;
  /** Setup has been walked through once. Reopenable from the account menu. */
  onboarded: boolean;
  /** The tour has been given once. Also reopenable from the account menu. */
  toured?: boolean;
  /** Phone access was switched on. Restored at launch: a paired phone away from
   *  the house cannot ask anyone to flip a switch on the laptop. */
  remoteOn: boolean;
  /** Where encrypted backups are written. Absent until someone picks one. */
  backupFolder?: string;
  /** How often, while botcage is open. */
  backupEvery?: "off" | "day" | "week";
  /** How many to keep in that folder before the oldest is deleted. */
  backupKeep?: number;
  /** When the last good one was written. */
  backupAt?: number;
  /** How much of the calendar was last on screen: a day, a week, or a month. */
  calSpan?: CalSpan;
  /** Tell me when I am needed, while I am looking at something else. Off
   *  until switched on, because switching it on is when macOS asks — and a
   *  permission prompt nobody went looking for is a bad first minute. */
  notify?: boolean;
  /** Music under the setup carousel. Absent means it has not been turned off,
   *  which is not the same as having been turned on: it plays the first time
   *  and then only if it was left alone. */
  hush?: boolean;
}

const DEFAULT_APP: AppSettings = {
  model: MODEL,
  screen: "1440x900",
  idleMinutes: 20,
  routinesOn: true,
  awake: false,
  onboarded: false,
  remoteOn: false,
};

const state: Persisted = {
  bots: [],
  channels: [],
  activeId: null,
  activeChannel: null,
  app: { ...DEFAULT_APP },
};

const appSettings = () => state.app ?? DEFAULT_APP;

const SCREEN_PANE = { min: 300, max: 900, initial: 460 };
const SCREEN_ROW = { min: 200, max: 700, initial: 320 };

/** The chat needs at least this much width; below it, the desktop stacks under. */
const MIN_CHAT_WIDTH = 480;
/** Below this, the sidebar collapses to a rail whether you asked for it or not. */
const RAIL_AT = 720;

/* ----------------------------------------------------------------- elements */

/** Throws loudly and by name: a missing element used to take the whole module
    down at import time, leaving an app with no bots and no clue why. */
const $ = <T extends Element>(sel: string): T => {
  const found = document.querySelector(sel);
  if (!found) throw new Error(`botcage: no element matches ${sel}`);
  return found as T;
};

const botsEl = $<HTMLDivElement>("#bots");
const searchEl = $<HTMLInputElement>("#search");
const topbarId = $<HTMLDivElement>("#topbar-id");
const thread = $<HTMLElement>("#thread");
const scroller = $<HTMLDivElement>("#scroll");
const findBox = $<HTMLInputElement>("#find-input");
const findClear = $<HTMLButtonElement>("#find-clear");
const found = $<HTMLDivElement>("#found");
const foundHead = $<HTMLParagraphElement>("#found-head");
const foundList = $<HTMLDivElement>("#found-list");
const jump = $<HTMLButtonElement>("#jump");
const jumpWhat = $<HTMLSpanElement>("#jump-what");
/** How many messages arrived while you were reading something further up.
 *  Declared here rather than beside the code that uses it, because
 *  scrollToEnd() clears it and is defined above that — and a `let` read before
 *  its declaration has run is a blank window, not a warning. */
let missed = 0;
const composer = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendBtn = $<HTMLButtonElement>("#btn-send");
const sendIcon = $<SVGUseElement>("#send-icon");
const menu = $<HTMLDivElement>("#menu");
const sheetWrap = $<HTMLElement>("#sheet-wrap");

/** Show or hide the settings pane.
 *
 *  One function because two things have to agree: the pane's own visibility and
 *  the column the grid reserves for it. Fifteen places used to set `hidden`
 *  directly, which was fine while this was a dialog floating over everything
 *  and would now leave a column of empty panel down the right of the window.
 *
 *  It shares the slot with a bot's computer, and only one of them fits: three
 *  columns is what this window has room for, and a fourth leaves the
 *  conversation too narrow to read. Opening settings puts the computer away. */
function showSheet(open: boolean): void {
  if (open && appEl.classList.contains("has-screen")) closeScreen();
  sheetWrap.hidden = !open;
  appEl.classList.toggle("has-sheet", open);
  relayout();
}
const sheet = $<HTMLFormElement>("#sheet");
const sheetName = $<HTMLInputElement>("#sheet-name");
const sheetRole = $<HTMLTextAreaElement>("#sheet-role");
const sheetMemory = $<HTMLTextAreaElement>("#sheet-memory");
const sheetCommands = $<HTMLElement>("#sheet-commands");
const sheetCommandsRow = $<HTMLElement>("#sheet-commands-row");
const sheetMemoryRow = $<HTMLElement>("#sheet-memory-row");
/** What the memory said when the sheet opened, so saving can tell an edit from
 *  a bot that wrote to the file while the sheet was open. Writing back
 *  unchanged text would clobber whatever it had just learned. */
let memoryWas = "";
const sheetPreview = $<HTMLDivElement>("#sheet-preview");
const swatches = $<HTMLDivElement>("#swatches");
const sheetTitle = $<HTMLHeadingElement>("#sheet-title");
const sheetSubmit = $<HTMLButtonElement>("#sheet-submit");
const sheetDelete = $<HTMLButtonElement>("#sheet-delete");

const sheetComputer = $<HTMLInputElement>("#sheet-computer");
const sheetNetwork = $<HTMLSelectElement>("#sheet-network");
const sheetEngine = $<HTMLSelectElement>("#sheet-engine");
const sheetModel = $<HTMLSelectElement>("#sheet-model");
const sheetBrowser = $<HTMLSelectElement>("#sheet-browser");
const sheetRendering = $<HTMLSelectElement>("#sheet-rendering");
const sheetScreen = $<HTMLSelectElement>("#sheet-screen");
const sheetCores = $<HTMLSelectElement>("#sheet-cores");
const sheetWindow = $<HTMLSelectElement>("#sheet-window");
const sheetFonts = $<HTMLSelectElement>("#sheet-fonts");
const sheetLanguage = $<HTMLSelectElement>("#sheet-language");

/** Only what the user actually chose, so "Default" stays a default rather than
 *  being frozen into the bot the first time its settings are saved. */
function machineFromSheet(): Bot["machine"] {
  const chosen = {
    browser: sheetBrowser.value || undefined,
    rendering: sheetRendering.value || undefined,
    screen: sheetScreen.value || undefined,
    cores: sheetCores.value ? Number(sheetCores.value) : undefined,
    window: sheetWindow.value || undefined,
    fonts: sheetFonts.value || undefined,
    language: sheetLanguage.value || undefined,
  };
  return Object.values(chosen).some((value) => value !== undefined) ? chosen : undefined;
}
const routineWrap = $<HTMLDivElement>("#routine-wrap");
const routineForm = $<HTMLFormElement>("#routine-form");
const routineName = $<HTMLInputElement>("#routine-name");
const routineInstruction = $<HTMLTextAreaElement>("#routine-instruction");
const routineEvery = $<HTMLSelectElement>("#routine-every");
const routineAt = $<HTMLInputElement>("#routine-at");
const routineInterval = $<HTMLInputElement>("#routine-interval");
const routineDay = $<HTMLSelectElement>("#routine-day");
const routineDate = $<HTMLInputElement>("#routine-date");
const routineActive = $<HTMLInputElement>("#routine-active");

/** Bot being edited in the sheet; null means the sheet is creating a new one. */
let editing: Bot | null = null;
const toastEl = $<HTMLDivElement>("#toast");
const appEl = $<HTMLDivElement>(".app");
const screenPane = $<HTMLElement>("#screen-pane");
const screenGrip = $<HTMLDivElement>("#screen-grip");
const screenId = $<HTMLDivElement>("#screen-id");
const screenStateEl = $<HTMLSpanElement>("#screen-state");
const screenCanvas = $<HTMLDivElement>("#screen-canvas");
const screenIdle = $<HTMLDivElement>("#screen-idle");
const screenMessage = $<HTMLParagraphElement>("#screen-message");
const screenLog = $<HTMLPreElement>("#screen-log");
const startBtn = $<HTMLButtonElement>("#btn-screen-start");

/** The engine botcage can install for itself, and how far along that is. */
interface EngineStatus {
  installed: boolean;
  path: string | null;
  needsVm: boolean;
  vmRunning: boolean;
  downloadMb: number;
  supported: boolean;
}
let engine: EngineStatus | null = null;
let engineStep = "";

/** One thing that can answer for a bot — a CLI, and one day an API or a model
 *  on this machine. Not to be confused with the container engine above; the
 *  Rust side keeps them in separate files for the same reason. */
interface EngineInfo {
  key: string;
  name: string;
  ready: { usable: boolean; missing: string | null };
  /** False when botcage has to hold this bot's conversation itself. */
  ownsTranscript: boolean;
  tools: string;
  models: { key: string; name: string; hint: string }[];
  /** True when its models are a catalogue to search, not a list to pick. */
  searchable: boolean;
}

/** One model from models.dev, as the chooser shows it. */
interface Listing {
  provider: string;
  providerName: string;
  id: string;
  name: string;
  context: number | null;
  costIn: number | null;
  costOut: number | null;
  tools: boolean;
  reasoning: boolean;
  /** Whether botcage holds a key for this model's provider. */
  ready: boolean;
}

interface ProviderInfo {
  id: string;
  name: string;
  api: string;
  env: string[];
  doc: string;
  hasKey: boolean;
  models: number;
  /** Runs on this machine: no key, no account, no cost. */
  local: boolean;
}

/** What botcage found, fetched at launch so a bot's settings can offer the
 *  choice without waiting on a round trip. */
let engineChoices: EngineInfo[] = [];

/** Used when the list cannot be fetched, and by every bot made before engines
 *  existed. */
const DEFAULT_ENGINE = "claude-code";

async function loadEngineChoices(): Promise<EngineInfo[]> {
  engineChoices = await invoke<EngineInfo[]>("engines").catch(() => []);
  return engineChoices;
}
let installing = false;

// The install is minutes of downloading, so its progress replaces the pane's
// message rather than being invisible until it finishes.
void listen<string>("engine", (event) => {
  engineStep = event.payload;
  paintEngineProgress();
});

/** Both places that can install an engine — the desktop pane and onboarding —
 *  show the same running commentary. */
function paintEngineProgress(): void {
  paintScreen();
  if (!setupWrap.hidden) paintSetup();
}

/** Fetch, verify, unpack and start an engine. Throws on failure so each caller
 *  can report it where the user is looking. */
async function installEngine(): Promise<void> {
  installing = true;
  engineStep = "Starting…";
  paintEngineProgress();
  try {
    await invoke("install_engine");
    await invoke("start_engine");
    engine = await invoke<EngineStatus>("engine_status");
  } finally {
    installing = false;
    engineStep = "";
  }
}

/** Fetch, verify and unpack an engine, then bring it up and carry on to the
 *  desktop the user actually asked for. */
async function setUpEngine(): Promise<void> {
  try {
    await installEngine();
    await openScreen();
  } catch (err) {
    screen.log = [String(err)];
    paintScreen();
    toast(String(err));
  }
}
const controlBtn = $<HTMLButtonElement>("#btn-control");
const controlLabel = $<HTMLSpanElement>("#btn-control-label");

/** Bots with a turn in flight, keyed by bot id.
 *
 *  A bot takes one turn at a time wherever it is speaking, so the key stays the
 *  bot: two turns at once would interleave into the same face and the same
 *  stop button. `channelId` says which room this one is in — absent for its own
 *  chat — and `settle` lets a caller wait for it, which is how a channel takes
 *  one voice at a time instead of everybody talking over each other. */
const inflight = new Map<
  string,
  { message: Message; sawText: boolean; note: string; channelId?: string; settle?: () => void }
>();

/** What this session has spent, and where the usage window stands. */
const session = {
  turns: 0,
  costUsd: 0,
  limit: null as { status?: string; rateLimitType?: string; resetsAt?: number } | null,
};

let draftColor = COLORS[0];
let toastTimer = 0;
let claudeReady = false;

/* -------------------------------------------------------------------- utils */

const uid = () => Math.random().toString(36).slice(2, 10);

const newSessionId = () =>
  crypto.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );

const icon = (name: string) => `<svg><use href="#i-${name}" /></svg>`;

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

/** Paths that mean something in a bot's world, rendered as badges instead of
    raw strings. Input is already HTML-escaped, so it is safe in both text and
    attribute position. */
function refBadge(path: string): string | null {
  const badge = (kind: string, symbol: string, label: string) =>
    `<span class="ref ref--${kind}" title="${path}">${icon(symbol)}${label}</span>`;

  const tidy = (slug: string) => slug.replace(/[-_]+/g, " ").trim();
  const bare = path.replace(/^\.\//, "");

  if (/^CLAUDE\.md$/i.test(bare)) return badge("memory", "note", "memory");

  const task = bare.match(/^tasks\/([\w.-]+)\.md$/);
  if (task) return badge("task", "cube", tidy(task[1]));

  const demo = bare.match(/^teach\/([\w.-]+)(?:\/[\w.-]+)?$/);
  if (demo) return badge("demo", "record", `${tidy(demo[1])} demo`);

  if (/^(~|\/home\/bot)\/work(\/.*)?$/.test(bare)) return badge("folder", "folder", "shared folder");
  if (/^(~|\/home\/bot)\/Desktop(\/.*)?$/.test(bare)) return badge("folder", "folder", "its desktop");

  return null;
}

/** Inline markdown: links, `code`, **bold**, *italic*. */
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, (_m, code: string) => refBadge(code) ?? `<code class="inline">${code}</code>`)
    .replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/** Markdown subset — lists, headings, fenced code, paragraphs. */
function renderMd(src: string): string {
  const fences: string[] = [];
  const text = src.replace(/```([\w-]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang: string, body: string) => {
    fences.push(
      `<pre class="code"><div class="code__bar"><span>${escapeHtml(lang || "text")}</span>` +
        `<button type="button" class="code__copy">Copy</button></div>` +
        `<code>${escapeHtml(body.replace(/\n+$/, ""))}</code></pre>`,
    );
    return `\n\n@@fence${fences.length - 1}@@\n\n`;
  });

  return text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";

      const fence = trimmed.match(/^@@fence(\d+)@@$/);
      if (fence) return fences[Number(fence[1])];

      const heading = trimmed.match(/^(#{2,3})\s+(.*)$/);
      if (heading) {
        const tag = heading[1].length === 2 ? "h2" : "h3";
        return `<${tag}>${inlineMd(heading[2])}</${tag}>`;
      }

      const lines = trimmed.split("\n");
      if (lines.every((l) => /^\s*[-*·]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*[-*·]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return `<ol>${lines.map((l) => `<li>${inlineMd(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      }

      return `<p>${lines.map(inlineMd).join("<br />")}</p>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ mentions */

/** Someone an "@" can reach from here. */
type Mentionable = {
  name: string;
  kind: "bot" | "room" | "you";
  /** A bot's own colour. The name lights up in it, so "@Engineer" in a room of
   *  five is the orange one at a glance rather than a word you have to read.
   *  Not a second setting: it is the colour already chosen for the bot, which
   *  is what its face and its blocks on the calendar are drawn in. */
  tint?: string;
};

/** Who is reachable in this conversation.
 *
 *  Deliberately the same set `addressees` reads. What lights up is exactly
 *  what summons somebody: an "@" in front of a word that reaches nobody stays
 *  plain text, because a highlight is a promise that a turn is about to be
 *  spent, and lighting up "@lunch" would be a lie about what the app just did.
 *
 *  Longest name first, so "@Research and Writing" is one person rather than
 *  "@Research" followed by a conjunction — the rule `addressees` follows when
 *  it decides who actually gets the message. */
function mentionable(ch?: Channel): Mentionable[] {
  const here = ch ? membersOf(ch) : [activeBot()].filter((b): b is Bot => Boolean(b));
  const people: Mentionable[] = here.map((bot) => ({
    name: bot.name,
    kind: "bot",
    tint: bot.color,
  }));

  // The three spellings `callsTheRoom` accepts, and only in a room: there is
  // no "everyone" in a chat with one bot.
  const room: Mentionable[] = ch && here.length
    ? ["everyone", "channel", "here"].map((name) => ({ name, kind: "room" as const }))
    : [];

  const you = userName().trim();
  const mine: Mentionable[] = you ? [{ name: you, kind: "you" }] : [];

  return [...people, ...room, ...mine]
    .filter((m) => m.name)
    .sort((a, b) => b.name.length - a.name.length);
}

/** Light up the mentions in a run of already-escaped text. */
function lightUp(text: string, wanted: (Mentionable & { look: string })[]): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = text.indexOf("@", from);
    if (at === -1) return out + text.slice(from);
    out += text.slice(from, at);

    const rest = text.slice(at + 1).toLowerCase();
    const hit = wanted.find(
      // Followed by a word character it is a longer name that happens to start
      // with this one, and belongs to somebody else.
      (w) => rest.startsWith(w.look) && !/[a-z0-9]/.test(rest[w.look.length] ?? " "),
    );
    if (!hit) {
      out += "@";
      from = at + 1;
      continue;
    }
    out += `<span class="men men--${hit.kind}"${hit.tint ? ` style="--tint:${hit.tint}"` : ""}>` +
      `${text.slice(at, at + 1 + hit.look.length)}</span>`;
    from = at + 1 + hit.look.length;
  }
}

/** Light up the mentions in rendered markup.
 *
 *  Run over the finished HTML rather than the source, because the source has
 *  to survive escaping, link-making and code spans first — and only over the
 *  parts of it that are text. An "@" turns up inside an href often enough
 *  (`x.com/@someone`), and a span opened in the middle of an attribute is not
 *  a highlight, it is broken markup. Tags are stepped over, and anything
 *  inside a link, a code span or a fenced block is left alone: the "@" in an
 *  email address in a code block summons nobody. */
function markMentions(html: string, targets: Mentionable[]): string {
  if (!targets.length || !html.includes("@")) return html;
  const wanted = targets.map((t) => ({ ...t, look: escapeHtml(t.name).toLowerCase() }));

  let out = "";
  let quiet = 0;
  for (const part of html.split(/(<[^>]*>)/)) {
    if (!part.startsWith("<")) {
      out += quiet > 0 ? part : lightUp(part, wanted);
      continue;
    }
    const tag = /^<(\/?)([a-z]+)/i.exec(part);
    if (tag && ["a", "code", "pre"].includes(tag[2].toLowerCase()) && !part.endsWith("/>")) {
      quiet = Math.max(0, quiet + (tag[1] ? -1 : 1));
    }
    out += part;
  }
  return out;
}

/** A notification, when botcage is not the window you are looking at.
 *
 *  The rule is the desk's rule: this is for things that are blocked on you, not
 *  for things that happened. Every turn a bot takes is something that happened;
 *  a bot saying your name and a turn that failed are the two that wait. Notify
 *  on the rest and the notifications become a thing to switch off, which is the
 *  same as not having them.
 *
 *  And never while you are looking at the app. A notification for the message
 *  arriving on the screen in front of you is a notification about your own eyes.
 */
async function nudge(title: string, body: string): Promise<void> {
  if (!canNotify || !appSettings().notify || document.hasFocus()) return;
  if (!(await isPermissionGranted().catch(() => false))) return;
  sendNotification({
    title,
    // One line's worth. The rest is in the app, which is where the button
    // takes you anyway.
    body: body.replace(/\s+/g, " ").trim().slice(0, 160),
  });
}

/** Which routine started the turn a bot is taking, so a notification can say
 *  what it was. Cleared when the turn ends: a bot's next turn is yours unless
 *  something says otherwise. */
const fromRoutine = new Map<string, string>();

/** Tell the phones, if any have said where they are.
 *
 *  Same rule as the notification on this machine: only what is blocked on you,
 *  and only while you are looking at something else. A phone that buzzes for a
 *  message you are watching arrive is a phone you leave face down.
 *
 *  One at a time and quietly. A phone that has been reinstalled leaves a token
 *  Apple will refuse, and a refusal is not worth a message in front of
 *  somebody who is not even at this machine — it drops out of the list instead.
 */
async function nudgePhones(title: string, body: string): Promise<void> {
  const phones = state.phones ?? [];
  if (!phones.length || !appSettings().notify || document.hasFocus()) return;

  const line = body.replace(/\s+/g, " ").trim().slice(0, 160);
  const gone: string[] = [];
  for (const phone of phones) {
    await invoke("push_send", {
      tokenHex: phone.token,
      sandbox: phone.sandbox,
      title,
      body: line,
    }).catch((err) => {
      // Apple's own words. A token it will never accept again is dropped; a
      // network that was down for a second is not.
      if (/BadDeviceToken|Unregistered|ExpiredToken/i.test(String(err))) gone.push(phone.token);
    });
  }
  if (gone.length) {
    state.phones = phones.filter((one) => !gone.includes(one.token));
    save();
  }
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed");
  }
}

/* ------------------------------------------------------------------ faces */

/** What a bot looks like.
 *
 *  Four traits that vary independently. Four heads, four eyes, four brows and
 *  four mouths is 256 faces before colour, which is enough that someone can say
 *  "the one with the heavy brows" rather than "the orange one" — and that is
 *  the whole point of a character over a swatch.
 *
 *  Every trait is a name, never a drawing: the drawing lives in CSS, keyed off
 *  a data attribute, so a new eye shape is a rule rather than a change here. */
/** One shape of a bot's own drawing. Percentages of the face box, with x and y
 *  the centre — so the same numbers work at 22, 34 and 54 pixels. */
interface Part {
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  rot?: number;
  fill?: string;
}

interface Face {
  head: string;
  eyes: string;
  brow: string;
  /** How this bot smiles when nothing is happening — never *whether* it does.
   *  The mouth is an expression, not a feature: a bot born with a frown is a
   *  bot that looks unhappy about everything forever. */
  smile: string;
  mark: string;
}

/* Six of everything, and a fifth trait for things that are not part of a face
   at all — an antenna, a tuft, a pair of cheeks. Six to the fifth is 7,776
   before colour, and the mark is what makes a bot describable in three words:
   "the green one with the antenna". */
const HEADS = ["circle", "squircle", "drop", "bean", "egg", "shield"];
const EYES = ["dot", "wide", "sleepy", "ring", "tall", "wink"];
const BROWS = ["none", "flat", "angled", "raised", "thick", "quirk"];
const SMILES = ["soft", "wide", "curl", "flat", "open", "tiny"];
const MARKS = [
  "none",
  "antenna",
  "tuft",
  "cheeks",
  "band",
  "bolt",
  // Things worn rather than grown. Asked for a cowboy hat, a bot could only
  // say the menu had none — which was honest and useless.
  "cowboy",
  "cap",
  "bow",
  "halo",
];

/** A number from a string, stable across restarts and machines.
 *
 *  Faces are derived rather than stored so every bot that already exists gets
 *  one without anybody choosing it, and so two bots made a second apart do not
 *  look like twins. */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** This bot's face: what it chose, or what its id implies. */
/** Write down the face a bot was born with, so it keeps it.
 *
 *  Same reason as the voice: the traits are picked by indexing the bot's id
 *  into lists of heads, eyes, brows, smiles and marks. Those lists are
 *  constants today, and the day one of them gains an entry every bot in every
 *  install changes face — which is a strange thing for an update to do to
 *  something you have been talking to for a month. Recorded once and derived
 *  never again.
 *
 *  Idempotent: a bot that already has one keeps it, including one it drew for
 *  itself. */
function pinFace(bot: Bot): void {
  bot.face = { ...faceOf(bot), ...bot.face };
}

function faceOf(bot: Bot): Face {
  const seed = seedOf(bot.id);
  return {
    head: bot.face?.head ?? bot.shape ?? HEADS[seed % HEADS.length],
    eyes: bot.face?.eyes ?? EYES[(seed >> 3) % EYES.length],
    brow: bot.face?.brow ?? BROWS[(seed >> 6) % BROWS.length],
    smile: bot.face?.smile ?? SMILES[(seed >> 9) % SMILES.length],
    mark: bot.face?.mark ?? MARKS[(seed >> 12) % MARKS.length],
  };
}

const SHAPES_ALLOWED = ["ellipse", "rect", "ring", "triangle", "line"];
const FILLS: Record<string, string> = {
  skin: "var(--skin)",
  ink: "var(--ink)",
  light: "#f4f4f6",
  dark: "#2b2b2f",
};

/** A bot's own drawing, as boxes.
 *
 *  Checked again here even though the tool checked it: this is the step that
 *  puts values into a style attribute, and the rule is that whatever is about
 *  to be written is what gets validated — not whatever validated something
 *  earlier, elsewhere, in another process. Anything unrecognised is dropped
 *  rather than passed through. */
function partsHtml(parts: Part[] | undefined): string {
  if (!parts?.length) return "";
  const num = (value: unknown, low: number, high: number, fallback: number) => {
    const found = Number(value);
    return Number.isFinite(found) ? Math.min(high, Math.max(low, found)) : fallback;
  };

  return parts
    .slice(0, 6)
    .filter((part) => SHAPES_ALLOWED.includes(part?.shape))
    .map((part) => {
      const fill = String(part.fill ?? "skin").toLowerCase();
      const paint = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(fill) ? fill : (FILLS[fill] ?? "var(--skin)");
      const style =
        `left:${num(part.x, -60, 160, 50)}%;top:${num(part.y, -80, 160, 50)}%;` +
        `width:${num(part.w, 1, 200, 20)}%;height:${num(part.h, 1, 200, 20)}%;` +
        // Both, because a ring turns its fill into its edge through
        // currentColor and has no background at all.
        `background:${paint};color:${paint};` +
        `--r:${num(part.r, 0, 50, 0)}%;--rot:${num(part.rot, -180, 180, 0)}deg`;
      return `<span class="face__part" data-shape="${part.shape}" style="${style}"></span>`;
    })
    .join("");
}

/** What a bot is doing, as its face shows it.
 *
 *  Adding one is an entry here and a block of CSS keyed on
 *  `.face[data-mood="..."]`. Nothing in this file needs to know what the new
 *  mood looks like, which is the point: the vocabulary grows without the
 *  renderer changing.
 *
 *  `hold` marks a mood as an event rather than a state — a wave or a cheer
 *  plays and hands the face back to whatever it was doing. A mood without one
 *  stays until something else replaces it. */
const MOODS: Record<string, { hold?: number }> = {
  // States: they last until something else replaces them.
  idle: {},
  think: {},
  work: {},
  /** Answering: the words are arriving. Held like the other states, because it
   *  lasts exactly as long as the writing does — `done` replaces it. */
  write: {},
  sleep: {},
  // Events: they play and hand the face back to whatever the bot is doing.
  wave: { hold: 1300 },
  /** Reading what it has just been handed. */
  read: { hold: 1200 },
  /** Waking up, for one that had gone to sleep. */
  wake: { hold: 1500 },
  /** Naming somebody else in a room — the other end of `alert`. */
  point: { hold: 1300 },
  /** You put a reaction on something it said. */
  nod: { hold: 900 },
  happy: { hold: 1800 },
  sad: { hold: 1800 },
  shrug: { hold: 1700 },
  alert: { hold: 1500 },
  dizzy: { hold: 1600 },
  peek: { hold: 900 },
  listen: { hold: 1400 },
  stretch: { hold: 1500 },
  // A state, not an event: it lasts exactly as long as there is sound, which
  // the speaking command reports when it stops.
  talk: {},
};

/** How long a bot has to go unspoken to before it dozes off. Long enough that
 *  it means neglect rather than a lunch break. */
const SLEEP_AFTER = 3 * 24 * 60 * 60 * 1000;

/** Which mood each bot is in. Kept apart from the bot itself: it is a fact
 *  about this minute, not about the bot, and it should not be saved. */
const moods = new Map<string, string>();
const moodTimers = new Map<string, number>();

function setMood(botId: string, mood: string): void {
  if (!MOODS[mood]) return;
  moods.set(botId, mood);

  const held = moodTimers.get(botId);
  if (held) window.clearTimeout(held);
  moodTimers.delete(botId);

  // An event-shaped mood hands the face back afterwards — to whatever the bot
  // is doing now rather than to idle, so a cheer during a long turn returns to
  // thinking rather than to standing still.
  const hold = MOODS[mood].hold;
  if (hold) {
    moodTimers.set(
      botId,
      window.setTimeout(() => {
        moods.delete(botId);
        moodTimers.delete(botId);
        paintMoods();
      }, hold),
    );
  }
  paintMoods();
}

/** What a bot's face should be showing when nothing has been announced. */
function restingMood(botId: string): string {
  const pending = inflight.get(botId);
  if (pending) return pending.note.toLowerCase().includes("using") ? "work" : "think";

  // A bot nobody has spoken to in days is asleep rather than merely idle.
  // Judged on the conversation rather than on a timestamp of its own, because
  // that is the thing that actually stopped.
  const bot = state.bots.find((b) => b.id === botId);
  const last = bot?.messages[bot.messages.length - 1]?.at ?? 0;
  if (last && Date.now() - last > SLEEP_AFTER) return "sleep";
  return "idle";
}

/** Push moods onto the faces already on screen, rather than re-rendering them.
 *  A face is in the roster, the header, the thread and a sheet at once, and a
 *  mood change should not cost a repaint of any of them.
 *
 *  Only the living ones. A still face is rendered without a mood so that every
 *  mood rule misses it, and this is the one place that would put one back —
 *  which is the whole reason the two kinds are told apart by a class and not
 *  only by what they were born with. */
function paintMoods(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".face[data-bot]:not(.face--still)")) {
    const botId = el.dataset.bot!;
    el.dataset.mood = moods.get(botId) ?? restingMood(botId);
  }
}

/** A bot's face.
 *
 *  Still unless it is asked to be alive. A face blinks, thinks, jumps when a
 *  turn lands and slumps when one fails — which is worth watching in the list
 *  the bots live in, and is something twitching beside the words you are
 *  trying to read anywhere else. So the roster asks for a living one, a call
 *  asks for a living one because the mouth moving is the point, and everything
 *  else gets a portrait.
 *
 *  A still face carries no mood at all rather than a frozen one: every mood
 *  rule is keyed on the attribute, so leaving it off is what makes them all
 *  miss, and only the blink needs turning off by hand. */
function faceHtml(
  bot: Bot,
  size: "xs" | "sm" | "md" | "lg" = "md",
  alive = false,
): string {
  const cls = `${size === "md" ? "" : ` face--${size}`}${alive ? "" : " face--still"}`;
  const face = faceOf(bot);
  const mood = moods.get(bot.id) ?? restingMood(bot.id);
  // Every face carries every part, whatever its traits say — a mouth a bot does
  // not normally show is hidden rather than absent, so a mood can still open
  // one in surprise without the renderer knowing that mood exists.
  return (
    `<span class="face${cls}" data-bot="${bot.id}"${alive ? ` data-mood="${mood}"` : ""}` +
    ` data-head="${face.head}" data-eyes="${face.eyes}"` +
    ` data-brow="${face.brow}" data-smile="${face.smile}" data-mark="${face.mark}"` +
    // Its own blink rhythm, so a roster does not blink in unison.
    ` style="--skin:${bot.color};--beat:${(seedOf(bot.id) % 1700) / 1000 + 2.2}s">` +
    `<span class="face__brows"><i></i><i></i></span>` +
    `<span class="face__eyes"><i></i><i></i></span>` +
    `<span class="face__mouth"></span>` +
    `<span class="face__mark">${face.mark === "custom" ? partsHtml(bot.face?.parts) : ""}</span>` +
    // Empty at rest, and owned by no trait: whatever a mood wants to put above
    // a bot's head lives here — a thought cloud today, a spark or a "zzz"
    // later, without another element being added for each.
    `<span class="face__aura"></span>` +
    `</span>`
  );
}

/* -------------------------------------------------------------- persistence */

/** What a phone would draw a sidebar from: which bots and rooms exist, and
 *  what they are called. Not what was said in them — that arrives on the event
 *  stream already. */
function shape(): string {
  return [
    state.bots.map((b) => `${b.id}:${b.name}`).join(),
    channels().map((c) => `${c.id}:${c.name}`).join(),
  ].join("|");
}

/** The shape as of the last save, so a change can be noticed rather than
 *  remembered at each of the dozen places that could cause one. */
let lastShape = "";

/** Tell any listening phone to read the snapshot again.
 *
 *  `save` does this by itself when the shape of things changes — a bot hired,
 *  a room opened. This is for the changes that leave the shape alone and still
 *  matter: something arriving on a message *after* the turn that carried it
 *  has already been announced, which a phone has no other way to learn about. */
function tellPhones(): void {
  void invoke("remote_stale").catch(() => {});
}

function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* storage unavailable — run in-memory */
  }

  // A phone hears about a turn as it happens and about nothing else, so
  // hiring, firing, renaming and opening a room all used to reach it only when
  // it next came out of a pocket. Compared rather than announced by each
  // caller: the one place that knows something was saved is the only place
  // that cannot forget to say so.
  const now = shape();
  if (now !== lastShape) {
    lastShape = now;
    void invoke("remote_stale").catch(() => {});
  }
}

function seed(): void {
  const make = (name: string, role: string, color: string, shape: Shape): Bot => ({
    id: uid(),
    name,
    role,
    color,
    shape,
    sessionId: newSessionId(),
    started: false,
    // A desktop is opt-in: it costs a download and most bots never need one.
    computer: false,
    network: "full",
    model: MODEL,
    messages: [],
  });

  // One bot, not a roster. Five strangers with jobs nobody asked for is a
  // worse first screen than a single one that can explain the place — and
  // whichever of the five you were never going to use is clutter you have to
  // delete before the app is yours.
  state.bots = [
    {
      ...make(
      "Guide",
      "Shows you around botcage. Ask it what a bot is, what routines and " +
        "connectors do, how to give a bot its own computer, or what to make next — " +
        "and when you know, make that bot and leave this one behind.",
      "#0a84ff",
      "circle",
      ),
      guide: true,
    },
  ];
  for (const bot of state.bots) pinFace(bot);
  state.activeId = state.bots[0].id;
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) {
      for (const stale of STALE_STORES) localStorage.removeItem(stale);
      return seed();
    }
    const data = JSON.parse(raw) as Partial<Persisted>;
    if (!Array.isArray(data.bots) || !data.bots.length) return seed();
    state.bots = data.bots.map((bot) => ({
      ...bot,
      // A Guide made before the flag existed is still the guide: one bot, that
      // name, nothing said to it yet. Anything else was made by a person and is
      // left exactly as they made it.
      guide:
        bot.guide ??
        (data.bots?.length === 1 && bot.name === "Guide" && !bot.messages?.length),
      sessionId: bot.sessionId || newSessionId(),
      started: Boolean(bot.started),
      computer: Boolean(bot.computer),
      network: bot.network ?? "full",
      model: bot.model || MODEL,
      routines: bot.routines ?? [],
    }));
    // Everything derived from an id gets written down the first time it is
    // seen, so nothing about a bot moves underneath it later.
    for (const bot of state.bots) pinFace(bot);

    state.channels = (data.channels ?? []).map((ch) => ({
      ...ch,
      members: (ch.members ?? []).filter((id) => state.bots.some((b) => b.id === id)),
      messages: ch.messages ?? [],
      seats: ch.seats ?? {},
    }));
    // Named here or it is not loaded at all. save() writes the whole of state,
    // so a category persisted perfectly and came back never: it survived until
    // the window reloaded and then quietly was not there. Anything added to
    // Persisted has to be added here too, which is the cost of loading field by
    // field rather than trusting whatever was on disk.
    state.categories = data.categories ?? [];
    state.activeId = data.activeId ?? state.bots[0].id;
    state.activeChannel = data.activeChannel ?? null;
    for (const bot of state.bots) freshenGuide(bot);
    state.screenOpen = Boolean(data.screenOpen);
    state.screenWidth = data.screenWidth;
    state.screenHeight = data.screenHeight;
    state.railed = Boolean(data.railed);
    state.app = { ...DEFAULT_APP, ...(data.app ?? {}) };
  } catch {
    seed();
  }
}

/* ----------------------------------------------------------------- your desk */

/** Something that is waiting on you rather than on a bot. */
interface Waiting {
  kind: "named" | "asked" | "failed" | "engine";
  /** Who or what it is about. */
  who: string;
  /** What happened, in one line. */
  what: string;
  when: number;
  /** Where it is, as a place rather than as a click.
   *
   *  It used to be a closure, which was tidy on the laptop and useless the
   *  moment the phone wanted the same list: a function does not go over a
   *  wire. Naming the destination instead lets both screens work out what
   *  going there means for them. */
  at: { botId?: string; channelId?: string; messageId?: string };
  /** Whose face belongs on the row. Usually the same bot the item is about —
   *  but in a room the conversation is the channel and the speaker is the bot
   *  that said it, so the two are not the same thing and this is the one that
   *  answers "who is waiting on me". Absent for an engine, which is nobody. */
  face?: string;
  /** The answers this one can be cleared with, if it is a question a bot
   *  handed buttons for. The whole point of the desk is that it is the list of
   *  what will not move until you do something; the ones that can be finished
   *  from the list itself should be. */
  ask?: { options: string[] };
}

/** The question out of a turn that is mostly other things.
 *
 *  A desk row is one line and a notification is one line, and the line worth
 *  having is the one that asks — not whatever the bot opened with. A turn that
 *  spends three paragraphs explaining itself and ends "want me to log it?" is
 *  waiting on that last sentence, so that is the sentence shown.
 *
 *  The last question rather than the first: a bot that asks something and then
 *  narrows it is waiting on the narrower one. */
function theAsk(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+/g);
  const asks = sentences?.filter((one) => one.includes("?")) ?? [];
  return (asks[asks.length - 1] ?? flat).trim();
}

/* ------------------------------------------------------------ templates */

/** A bot, packed so somebody else can have one like it.
 *
 *  What travels is the bot: its name, its job, its face, how it talks, when it
 *  works and what it answers to. What does not travel is everything the bot
 *  learned while doing that job for *you* — its conversation, the notes it
 *  keeps, what it has cost, which of your connectors it was allowed to use.
 *
 *  That line is the whole of the feature's safety. A memory file that reads
 *  "85kg, BMI 26.2, wants abs by March" is exactly the sort of thing a person
 *  would hand out by accident if the app packed everything and called it a
 *  template, so the packing lists what it takes rather than what it drops:
 *  a field added to a bot next year is left out until somebody decides it
 *  should travel.
 */
interface Template {
  /** What shape this file is, so a later botcage can read an earlier one and
   *  say so plainly when it cannot. */
  v: 1;
  name: string;
  role: string;
  color: string;
  shape: Shape;
  face?: Bot["face"];
  manner?: string;
  voice?: string;
  hours?: Bot["hours"];
  /** A preference rather than a requirement: the machine importing this may
   *  not have that engine, and a template that refuses to load because of it
   *  would be a template nobody could share. */
  engine?: string;
  provider?: string;
  model?: string;
  /** Whether this bot is meant to have a computer. Not a grant — the importer
   *  still has to set up a machine for it and still has to say yes. */
  computer?: boolean;
  network?: Bot["network"];
  commands?: Bot["commands"];
  /** What it does on a schedule, without the times it last ran. */
  routines?: { name: string; instruction: string; every: string; at?: string; day?: number; date?: string; minutes?: number }[];
}

/** Pack one. */
function templateOf(bot: Bot): Template {
  const packed: Template = {
    v: 1,
    name: bot.name,
    role: bot.role,
    color: bot.color,
    shape: bot.shape,
  };
  if (bot.face) packed.face = bot.face;
  if (bot.manner) packed.manner = bot.manner;
  if (bot.voice) packed.voice = bot.voice;
  if (bot.hours) packed.hours = bot.hours;
  if (bot.engine) packed.engine = bot.engine;
  if (bot.provider) packed.provider = bot.provider;
  if (bot.model) packed.model = bot.model;
  if (bot.computer) packed.computer = true;
  if (bot.network) packed.network = bot.network;
  if (bot.commands?.length) packed.commands = bot.commands;

  // Schedules, not history: `lastRunAt` says when it ran on this machine and
  // means nothing on anybody else's.
  const live = (bot.routines ?? []).filter((r) => r.active);
  if (live.length) {
    packed.routines = live.map((r) => ({
      name: r.name,
      instruction: r.instruction,
      every: r.every,
      ...(r.at ? { at: r.at } : {}),
      ...(r.day !== undefined ? { day: r.day } : {}),
      ...(r.date ? { date: r.date } : {}),
      ...(r.minutes !== undefined ? { minutes: r.minutes } : {}),
    }));
  }
  return packed;
}

/** Unpack one into a bot of your own.
 *
 *  Everything here is checked rather than trusted. A template is a file that
 *  arrived from somebody else — by definition the one input to this app that
 *  did not come from the person using it — so every field is either a shape
 *  botcage already understands or it is dropped. A colour becomes a colour or
 *  the next one in the palette; a manner becomes one of the manners or none;
 *  an engine that is not installed here becomes this machine's default rather
 *  than a bot that cannot answer.
 *
 *  It throws only on the two things it cannot work around: a file that is not
 *  a template at all, and a version this build does not know.
 */
function botFromTemplate(raw: unknown): Bot {
  const t = raw as Partial<Template> | null;
  if (!t || typeof t !== "object" || typeof t.name !== "string") {
    throw new Error("that file is not a botcage template");
  }
  if (t.v !== 1) {
    throw new Error(
      `that template was made by a newer botcage (version ${String(t.v)}) — update this one to open it`,
    );
  }

  const name = t.name.trim().slice(0, 40) || "Imported bot";
  const colour =
    typeof t.color === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t.color)
      ? t.color
      : COLORS[state.bots.length % COLORS.length];
  const engine = engineChoices.find((info) => info.key === t.engine)?.key;

  return {
    id: uid(),
    name,
    role: typeof t.role === "string" ? t.role.slice(0, 4000) : "",
    color: colour,
    shape: SHAPES.includes(t.shape as Shape) ? (t.shape as Shape) : SHAPES[state.bots.length % SHAPES.length],
    face: t.face && typeof t.face === "object" ? t.face : undefined,
    manner: MANNERS.some((m) => m.key === t.manner) ? t.manner : undefined,
    voice: typeof t.voice === "string" ? t.voice : undefined,
    hours: t.hours && typeof t.hours === "object" ? t.hours : undefined,
    // Not the sender's engine unless this machine has it. A template that
    // arrives asking for Gemini on a laptop with only Claude Code should make
    // a working bot, not a broken one.
    engine: engine ?? appSettings().engine ?? DEFAULT_ENGINE,
    provider: engine ? t.provider : appSettings().provider,
    model: engine && typeof t.model === "string" ? t.model : (appSettings().model ?? MODEL),
    // Asked for, not granted: the switch is off and the person importing turns
    // it on, having read what the bot is for.
    computer: false,
    network: (["full", "no-lan", "offline"] as const).includes(t.network as Bot["network"])
      ? (t.network as Bot["network"])
      : "full",
    commands: Array.isArray(t.commands)
      ? t.commands
          .filter((c) => c && typeof c.name === "string" && typeof c.what === "string")
          .slice(0, 8)
      : undefined,
    routines: Array.isArray(t.routines)
      ? t.routines
          .filter((r) => r && typeof r.name === "string" && typeof r.instruction === "string")
          .slice(0, 20)
          .map((r) => ({
            id: uid(),
            name: String(r.name).slice(0, 60),
            instruction: String(r.instruction).slice(0, 4000),
            every: (["once", "week", "day", "weekday", "hour", "minutes"] as const).includes(
              r.every as Routine["every"],
            )
              ? (r.every as Routine["every"])
              : "day",
            at: typeof r.at === "string" && /^\d{2}:\d{2}$/.test(r.at) ? r.at : "09:00",
            ...(typeof r.day === "number" ? { day: r.day } : {}),
            ...(typeof r.date === "string" ? { date: r.date } : {}),
            ...(typeof r.minutes === "number" ? { minutes: r.minutes } : {}),
            // Off, so nothing an imported bot brought with it runs before the
            // person importing has read it and said so.
            active: false,
          }))
      : undefined,
    messages: [],
    sessionId: newSessionId(),
    started: false,
    plugins: [],
  };
}

/** Everything blocked on you, in one list.
 *
 *  A company of agents makes the person the bottleneck: five bots working is
 *  five things that can stop and wait, and the app's answer until now was that
 *  you would notice the dot on a row. This is the other half of that — not
 *  what is new, which the unread marks already say, but what will not move
 *  until you do something.
 *
 *  Three things qualify, and they are three because those are the three the
 *  app can actually tell. A bot said your name and you have not answered. A
 *  turn failed. An engine a bot is set to use is not there, which is a bot
 *  that cannot work at all. Anything else would be a guess dressed as a task.
 */
function onYourDesk(): Waiting[] {
  const out: Waiting[] = [];

  const lastFromYou = (messages: Message[]) =>
    messages.reduce((at, m) => (m.from === "me" ? m.at : at), 0);

  /** The bot's question left hanging at the end of a conversation, if there
   *  is one.
   *
   *  A bot that finishes its turn by asking something is waiting on you, and
   *  until now the desk only knew that if it happened to say your name. It
   *  usually does not: a routine that fires at eight in the evening and asks
   *  what you had for dinner is talking to whoever is there, and nobody is —
   *  which is the exact case a page called "your desk" exists for.
   *
   *  Only the last thing said counts. A question three answers ago was
   *  answered, and a list that keeps bringing it back is a list you learn to
   *  scroll past.
   *
   *  A question mark, rather than a guess at what a question looks like.
   *  Something that ends a turn and has one in it is asking; the alternative
   *  is a rule about wording that would be wrong in both directions. */
  const leftAsking = (messages: Message[]): Message | undefined => {
    const since = lastFromYou(messages);
    // Everything the bot has said since you last said anything. The routine
    // markers are notes that a routine ran rather than something somebody
    // said, and an empty turn is a turn still arriving.
    const said = messages.filter(
      (m) => m.at > since && m.from === "bot" && m.kind !== "routine" && m.text.trim(),
    );
    if (!said.length) return undefined;
    // A failure is already on the list as a failure.
    if (said.some((m) => m.error)) return undefined;
    // Already on the list under its own name — a question that says your name
    // is one thing waiting on you, not two.
    if (said.some((m) => mentionsYou(m.text))) return undefined;
    // Buttons left unpressed first, and regardless of punctuation: a bot that
    // handed over answers is waiting on one of them being chosen, which is a
    // surer thing than any reading of the words. It is also the item worth
    // having at the top, because it is the one that can be cleared without
    // going anywhere.
    const offered = said.find((m) => m.ask && !m.ask.answered);
    if (offered) return offered;
    // Otherwise the question itself, not whatever the bot said after it. A
    // turn ends "…and I'll log it" as often as it ends with the question mark,
    // and the line worth showing is the one that asked.
    //
    // Never one whose buttons have been pressed. Answering also puts your own
    // message in the conversation, which normally settles this by itself — but
    // a question is finished when it has been answered, and that should not
    // depend on something else happening to be true.
    return said.find((m) => m.text.includes("?") && !m.ask?.answered);
  };

  for (const bot of state.bots) {
    const since = lastFromYou(bot.messages);
    for (const m of bot.messages) {
      if (m.from !== "bot" || m.at <= since) continue;
      if (m.error) {
        out.push({
          kind: "failed",
          face: bot.id,
          who: bot.name,
          what: m.error,
          when: m.at,
          at: { botId: bot.id, messageId: m.id },
        });
      } else if (mentionsYou(m.text)) {
        out.push({
          kind: "named",
          face: bot.id,
          who: bot.name,
          what: m.text.replace(/\s+/g, " ").trim(),
          when: m.at,
          at: { botId: bot.id, messageId: m.id },
        });
      }
    }

    const asking = leftAsking(bot.messages);
    if (asking) {
      out.push({
        kind: "asked",
        face: bot.id,
        who: bot.name,
        // The question it wrote for the buttons, when there is one: it was
        // written to sit above them and says the choice more plainly than the
        // sentence in the reply.
        what: asking.ask?.question || theAsk(asking.text),
        when: asking.at,
        at: { botId: bot.id, messageId: asking.id },
        ...(asking.ask && !asking.ask.answered ? { ask: { options: asking.ask.options } } : {}),
      });
    }
  }

  for (const ch of channels()) {
    const since = lastFromYou(ch.messages);
    for (const m of ch.messages) {
      if (m.from !== "bot" || m.at <= since || !mentionsYou(m.text)) continue;
      out.push({
        kind: "named",
        face: m.by,
        who: `${nameOf(m.by) || "A bot"} in ${ch.from ? "↳ " : "#"}${ch.name}`,
        what: m.text.replace(/\s+/g, " ").trim(),
        when: m.at,
        at: { channelId: ch.id, messageId: m.id },
      });
    }

    const asking = leftAsking(ch.messages);
    if (asking) {
      out.push({
        kind: "asked",
        face: asking.by,
        who: `${nameOf(asking.by) || "A bot"} in ${ch.from ? "↳ " : "#"}${ch.name}`,
        what: asking.ask?.question || theAsk(asking.text),
        when: asking.at,
        at: { channelId: ch.id, messageId: asking.id },
        ...(asking.ask && !asking.ask.answered ? { ask: { options: asking.ask.options } } : {}),
      });
    }
  }

  // An engine that cannot run is not a message anybody sent, so it has no time
  // of its own — it sorts to the top, because a bot that cannot work at all
  // outranks a bot waiting for an answer.
  for (const engine of engineChoices) {
    if (engine.ready.usable) continue;
    const mine = state.bots.filter((b) => (b.engine ?? DEFAULT_ENGINE) === engine.key);
    if (!mine.length) continue;
    out.push({
      kind: "engine",
      who: engine.name,
      what: `${engine.ready.missing ?? "Not ready"} — ${mine.length} bot${mine.length === 1 ? "" : "s"} set to use it`,
      when: Date.now(),
      at: {},
    });
  }

  return out.sort((a, b) => {
    const rank = { engine: 0, failed: 1, asked: 2, named: 3 } as const;
    return rank[a.kind] - rank[b.kind] || b.when - a.when;
  });
}

/** Is the desk what the main pane is showing? */
let deskOpen = false;

const AGO = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

/** The face of whoever is waiting, if it is anybody. */
function deskFace(item: Waiting): string | null {
  const bot = state.bots.find((b) => b.id === item.face);
  return bot ? `<span class="desk-item__face">${faceHtml(bot, "sm")}</span>` : null;
}

/** What is drawn when there is no face to draw, which in practice is only ever
 *  an engine: something that cannot run is a fact about this machine rather
 *  than about anybody, so it gets a mark instead of a colleague. The others
 *  are kept because a bot can be deleted while its question is still on the
 *  desk, and a row with nobody behind it should still say what it is. */
const DESK_MARK: Record<Waiting["kind"], string> = {
  asked: "?",
  named: "@",
  failed: "\u00d7",
  engine: "!",
};

/** And what it is called, for anyone who cannot see the mark. */
const DESK_SAYS: Record<Waiting["kind"], string> = {
  asked: "Asked you",
  named: "Named you",
  failed: "Failed",
  engine: "Cannot run",
};

/** The desk itself. Kept between renders so a click can find the item it was
 *  drawn from without the list being rebuilt underneath it. */
let desk: Waiting[] = [];

function renderDesk(): void {
  desk = onYourDesk();

  $<HTMLParagraphElement>("#desk-note").textContent = desk.length
    ? `${desk.length} thing${desk.length === 1 ? "" : "s"} waiting on you`
    : "";

  $<HTMLDivElement>("#desk-list").innerHTML = desk.length
    ? desk
        .map(
          (item, at) =>
            `<div class="desk-row${item.ask ? " has-ask" : ""}">` +
            `<button type="button" class="desk-item desk-item--${item.kind}" data-desk-at="${at}">` +
            // Whose it is, as a face. It was a word, then an abstract mark, and
            // both were answering the wrong question: the thing you sort a desk
            // by is who is waiting on you, and this app already draws that
            // better than any glyph. It is also the one mark that needs no
            // learning — you know these faces from the roster.
            //
            // An engine has no face because it is not anybody; it keeps a mark.
            // The kind is still said to a screen reader, which sees neither.
            (deskFace(item) ??
              `<span class="desk-item__mark" aria-hidden="true">${DESK_MARK[item.kind]}</span>`) +
            `<span class="sr-only">${DESK_SAYS[item.kind]}</span>` +
            `<span class="desk-item__body">` +
            `<span class="desk-item__who">${escapeHtml(item.who)}</span>` +
            `<span class="desk-item__what">${escapeHtml(item.what.slice(0, 240))}</span>` +
            `</span>` +
            `<span class="desk-item__when">${item.kind === "engine" ? "" : AGO(item.when)}</span>` +
            `</button>` +
            // Outside the row's own button, because a button inside a button
            // is not a thing, and because pressing an answer is not the same
            // gesture as going to the conversation.
            (item.ask
              ? `<div class="desk-item__ask">` +
                item.ask.options
                  .map(
                    (one) =>
                      `<button type="button" class="ask__opt" data-desk-answer="${at}" ` +
                      `data-answer="${escapeHtml(one)}">${escapeHtml(one)}</button>`,
                  )
                  .join("") +
                `</div>`
              : "") +
            `</div>`,
        )
        .join("")
    : `<div class="desk__clear">` +
      `<p class="desk__clear-head">Nothing is waiting on you.</p>` +
      `<p class="desk__clear-note">Bots that asked you something or said your name, turns that ` +
      `failed, and engines that cannot run turn up here. Everything else they can get on with ` +
      `themselves.</p>` +
      `</div>`;
}

/** The main pane shows either the conversation, the calendar, or this. */
function showDesk(open: boolean): void {
  deskOpen = open;
  $<HTMLElement>(".main").classList.toggle("is-desk", open);
  $<HTMLElement>("#desk").hidden = !open;
  if (!open) {
    paintTopbarFor(activeBot());
    renderThread();
    renderRoster();
    return;
  }

  // The calendar and the desk are both the whole pane; opening one closes the
  // other rather than stacking them.
  if (routinesOpen) showRoutines(false);
  state.activeChannel = null;
  paintTopbarFor(null);
  $<HTMLButtonElement>("#btn-settings").hidden = true;
  topbarId.innerHTML =
    `<span class="chan__hash">${icon("note")}</span><span>Your desk</span>`;
  renderDesk();
  renderRoster();
}

/* --------------------------------------------------------------- bot roster */

const activeBot = () => state.bots.find((b) => b.id === state.activeId) ?? null;


function renderRoster(): void {
  const q = searchEl.value.trim().toLowerCase();
  const hits = state.bots.filter(
    (b) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      b.role.toLowerCase().includes(q) ||
      b.messages.some((m) => m.text.toLowerCase().includes(q)),
  );

  if (!hits.length) {
    botsEl.innerHTML = `<p class="bot-row__last" style="padding:8px 10px">No bots match</p>`;
    return;
  }

  // Rooms first, then bots. A channel is where several of them are, so it sits
  // above the list of individuals — the same order every app with both has
  // settled on, for the same reason.
  const matches = (ch: Channel) =>
    !q || ch.name.toLowerCase().includes(q) || ch.messages.some((m) => m.text.toLowerCase().includes(q));

  // A room, then its threads under it. A thread whose room does not match is
  // still worth showing when the thread itself does, so the room comes along
  // to say where it belongs.
  const shown = rooms().filter((ch) => matches(ch) || threadsOf(ch).some(matches));

  // Ungrouped rooms first and then each category, which is the order Discord
  // uses and the one that keeps a channel you never filed from disappearing
  // under a heading you made for something else.
  const groups: { cat: Category | null; rooms: Channel[] }[] = [
    { cat: null, rooms: shown.filter((ch) => !catOf(ch)) },
    ...categories().map((cat) => ({
      cat,
      rooms: shown.filter((ch) => catOf(ch)?.id === cat.id),
    })),
  ];

  const roomsHtml = shown.length
    ? `<p class="rail-group" data-drop="">Channels</p>` +
      groups
        .map(({ cat, rooms: mine }) => {
          // An empty category still shows its heading: it is the thing you drop
          // channels into, and one that vanishes when empty cannot be aimed at.
          if (!mine.length && !cat) return "";

          const head = cat
            ? `<button type="button" class="cat${cat.shut ? " is-shut" : ""}" data-cat="${cat.id}" data-drop="${cat.id}">` +
              `<svg class="cat__chev"><use href="#i-chev" /></svg>` +
              `<span class="cat__name">${escapeHtml(cat.name || "Untitled")}</span>` +
              `</button>`
            : "";

          // Shut hides what is under it, but never something unread: a heading
          // you closed must not be a way to miss a bot asking you something.
          const open = mine.filter(
            (ch) =>
              !cat?.shut ||
              !!q ||
              ch.id === state.activeChannel ||
              (!ch.muted && unreadIn(ch.messages, ch.seenAt).unread > 0) ||
              threadsOf(ch).some((t) => t.id === state.activeChannel),
          );

          return head + roomRows(open, matches, q);
        })
        .join("")
    : "";

  const botsHtml = "";
  void botsHtml;

  const waiting = onYourDesk().length;
  // Above everything, and only ever one line: it is not a channel and not a
  // bot, it is the pile on your side of the table.
  const deskHtml =
    `<button type="button" class="desk-row${deskOpen ? " is-active" : ""}" data-desk-open>` +
    `<span class="desk-row__icon">${icon("note")}</span>` +
    `<span class="desk-row__name">Your desk</span>` +
    (waiting ? `<span class="desk-row__count">${waiting > 99 ? "99+" : waiting}</span>` : "") +
    `</button>`;

  botsEl.innerHTML =
    deskHtml +
    roomsHtml +
    (roomsHtml ? `<p class="rail-group">Bots</p>` : "") +
    botRows(hits);
}

/** Make one, and ask for its name where it will live.
 *
 *  A category is a word. Asking for it in a dialog of its own would be a window
 *  that exists to type one word into, so the heading appears immediately and
 *  you name it in place. */
function newCategory(): void {
  const cat: Category = { id: uid(), name: "" };
  categories().push(cat);
  save();
  renderRoster();
  nameCategory(cat.id);
}

/** Turn a heading into a field, and put back whatever comes of it.
 *
 *  A name that is left empty removes the category, which is also how you get
 *  rid of one: there is nothing else it could mean, and it saves a delete
 *  button on every heading. Its channels are not touched — they go back to
 *  being unfiled, which is where a channel with no category belongs. */
function nameCategory(id: string): void {
  const head = botsEl.querySelector<HTMLElement>(`[data-cat="${CSS.escape(id)}"]`);
  const cat = categories().find((c) => c.id === id);
  if (!head || !cat) return;

  const field = document.createElement("input");
  field.className = "cat__edit";
  field.value = cat.name;
  field.placeholder = "Category name";
  field.spellcheck = false;
  head.replaceWith(field);
  field.focus();
  field.select();

  let done = false;
  const finish = (keep: boolean): void => {
    if (done) return;
    done = true;
    const name = keep ? field.value.trim() : cat.name.trim();
    if (name) {
      cat.name = name;
    } else {
      state.categories = categories().filter((c) => c.id !== id);
      for (const ch of channels()) if (ch.category === id) delete ch.category;
    }
    save();
    renderRoster();
  };

  field.addEventListener("blur", () => finish(true));
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") finish(false);
  });
}

/* ----------------------------------------------------- moving a room about */

/** Dragging a room to reorder it, or into a category.
 *
 *  Pointer events rather than HTML5 drag-and-drop. That API needs the
 *  platform's own drag session, which means it cannot be driven or tested from
 *  outside the app — and it brings a drag image, a drop-effect cursor and a set
 *  of quirks that differ between the webviews botcage runs in. This is a
 *  mousedown, some movement and a mouseup, which behaves the same everywhere
 *  and which I can watch actually work.
 *
 *  The order in the sidebar is the order of state.channels, so moving a room is
 *  moving it in that array. There is no separate ordering to keep in step,
 *  which is why a room can be dropped anywhere without a rank being invented
 *  for it. */
let carrying: { id: string; from: number; moved: boolean } | null = null;

function unmark(): void {
  for (const el of botsEl.querySelectorAll(".is-over, .is-over-below, .is-target")) {
    el.classList.remove("is-over", "is-over-below", "is-target");
  }
}

/** What is under the pointer, and where against it. */
function landing(y: number, x: number): { on: HTMLElement; above: boolean } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const on = el?.closest<HTMLElement>("[data-channel], [data-drop]") ?? null;
  if (!on || !botsEl.contains(on)) return null;
  const box = on.getBoundingClientRect();
  return { on, above: y < box.top + box.height / 2 };
}

botsEl.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-channel]");
  // A thread is not picked up: it follows the room it hangs off, and there is
  // nowhere else for it to be.
  if (!row?.dataset.channel || row.classList.contains("chan-row--thread")) return;
  carrying = { id: row.dataset.channel, from: event.clientY, moved: false };
});

window.addEventListener("pointermove", (event) => {
  if (!carrying) return;
  // Not a drag until it plainly is one, or every click on a room would be a
  // tiny one and the room would never open.
  if (!carrying.moved && Math.abs(event.clientY - carrying.from) < 5) return;
  if (!carrying.moved) {
    carrying.moved = true;
    botsEl
      .querySelector(`[data-channel="${CSS.escape(carrying.id)}"]`)
      ?.classList.add("is-carried");
    // Otherwise the sidebar's text highlights blue as the pointer sweeps it.
    document.body.classList.add("is-dragging");
  }

  unmark();
  const at = landing(event.clientY, event.clientX);
  if (!at) return;
  if (at.on.dataset.drop !== undefined) at.on.classList.add("is-target");
  else at.on.classList.add(at.above ? "is-over" : "is-over-below");
});

window.addEventListener("pointerup", (event) => {
  const held = carrying;
  carrying = null;
  document.body.classList.remove("is-dragging");
  for (const el of botsEl.querySelectorAll(".is-carried")) el.classList.remove("is-carried");
  if (!held?.moved) {
    unmark();
    return;
  }

  const at = landing(event.clientY, event.clientX);
  unmark();
  if (!at) return;

  const ch = channels().find((c) => c.id === held.id);
  if (!ch) return;

  // Dropped on a heading: into that category, at the end of it. "Channels" is a
  // heading too, with no id of its own, which is how a room comes back out.
  if (at.on.dataset.drop !== undefined) {
    if (at.on.dataset.drop) ch.category = at.on.dataset.drop;
    else delete ch.category;
    put(ch, null);
    return;
  }

  const onto = channels().find((c) => c.id === at.on.dataset.channel);
  if (!onto || onto.id === ch.id) return;
  // Landing on a thread means landing on the room it belongs to.
  const target = onto.from ? channels().find((c) => c.id === onto.from?.channelId) : onto;
  if (!target || target.id === ch.id) return;

  // It joins whatever the room it landed on belongs to, so dragging across a
  // heading does the filing as well as the ordering.
  if (target.category) ch.category = target.category;
  else delete ch.category;
  put(ch, target, at.above);
});

/** Put a room where it was dropped, and redraw.
 *
 *  `before` null means the end. A room's threads are not moved: they are drawn
 *  under it wherever it goes, so they were never anywhere of their own. */
function put(ch: Channel, target: Channel | null, above = false): void {
  const all = channels();
  all.splice(all.indexOf(ch), 1);
  if (!target) {
    all.push(ch);
  } else {
    const at = all.indexOf(target);
    all.splice(above ? at : at + 1, 0, ch);
  }
  save();
  renderRoster();
}

botsEl.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("[data-desk-open]")) {
    showDesk(!deskOpen);
    return;
  }

  const head = (event.target as HTMLElement).closest<HTMLElement>("[data-cat]");
  if (!head?.dataset.cat) return;
  const cat = categories().find((c) => c.id === head.dataset.cat);
  if (!cat) return;
  cat.shut = !cat.shut;
  save();
  renderRoster();
});

botsEl.addEventListener("dblclick", (event) => {
  const head = (event.target as HTMLElement).closest<HTMLElement>("[data-cat]");
  if (head?.dataset.cat) nameCategory(head.dataset.cat);
});

/** Which category a channel is filed under, if the category still exists. */
function catOf(ch: Channel): Category | undefined {
  return ch.category ? categories().find((c) => c.id === ch.category) : undefined;
}

const categories = (): Category[] => (state.categories ??= []);

/** The rows for a run of rooms, each with its threads under it. */
function roomRows(shown: Channel[], matches: (ch: Channel) => boolean, q: string): string {
  const rows = shown.flatMap((ch) => [
    ch,
    ...threadsOf(ch).filter((t) => matches(t) || matches(ch)),
  ]);
  void q;
  return rows
          .map((ch, n) => {
            const room = membersOf(ch);
            const busy = room.some((b) => inflight.get(b.id)?.channelId === ch.id);
            // A thread hanging off a muted room is muted with it. Silencing a
            // room and then being told about the side conversations coming out
            // of it is not silence.
            const quiet =
              ch.muted ||
              (!!ch.from && !!channels().find((c) => c.id === ch.from?.channelId)?.muted);
            const news = ch.id === state.activeChannel || quiet
              ? { unread: 0, mentions: 0 }
              : unreadIn(ch.messages, ch.seenAt);
            // The last thread under a room turns the branch into an elbow, so
            // the line stops at the thing it is pointing to rather than running
            // on past it. CSS cannot see a following sibling, so it is said
            // here, where the order is known.
            const last = !!ch.from && !rows[n + 1]?.from;
            // With the sidebar collapsed a thread is not drawn at all, so the
            // room it belongs to stands in for it — otherwise opening a thread
            // leaves nothing lit anywhere.
            const hosting =
              !ch.from && threadsOf(ch).some((t) => t.id === state.activeChannel);
            return (
              `<button class="bot-row chan-row${quiet ? " is-muted" : ""}` +
              `${ch.id === state.activeChannel ? " is-active" : ""}` +
              `${hosting ? " is-hosting" : ""}` +
              `${news.unread ? " is-unread" : ""}` +
              `${ch.from ? ` chan-row--thread${last ? " is-last" : ""}` : ""}" ` +
              `data-channel="${ch.id}">` +
              // A thread carries no icon of its own: the branch it hangs from
              // says what it is, and a glyph on every line only competes with
              // the room's own hash above it.
              (ch.from ? "" : `<span class="chan-row__hash">${icon("hash")}</span>`) +
              `<span class="bot-row__body"><span class="bot-row__top">` +
              `<span class="bot-row__name">${escapeHtml(ch.name)}</span>` +
              // When it last had anything said in it, which is what this
              // column means on every other row in the sidebar. It used to be
              // the number of bots in the room — a bare number at the right
              // end of a channel name, which is exactly where Discord and
              // Slack put an unread count, so it read as "2 unread" and was
              // not. Who is in a room is answered by the faces in its header.
              `<span class="bot-row__time">${
                busy || news.unread ? "" : lastSaid(ch.messages)
              }</span>` +
              `</span></span>` +
              badgeHtml(news) +
              (busy ? `<span class="chan-row__live"></span>` : "") +
              `</button>`
            );
          })
          .join("");
}

/** The rows for the bots themselves. */
function botRows(hits: Bot[]): string {
  return hits
    .map((bot) => {
      const news =
        bot.id === state.activeId && !state.activeChannel
          ? { unread: 0, mentions: 0 }
          : unreadIn(bot.messages, bot.seenAt);
      return (
        `<button class="bot-row${bot.id === state.activeId && !state.activeChannel ? " is-active" : ""}` +
        `${news.unread ? " is-unread" : ""}" data-bot="${bot.id}">` +
        faceHtml(bot, "md", true) +
        `<span class="bot-row__body">` +
        // Name and time, and nothing else. The second line used to carry the
        // last thing said, which is a chat app's habit rather than this app's
        // need: the bots are down the side, the conversation is in front of
        // you, and what a bot is doing this second is on its face — a thought
        // cloud says "typing" better than the word does.
        `<span class="bot-row__top"><span class="bot-row__name">${escapeHtml(bot.name)}</span>` +
        `<span class="bot-row__time">${news.unread ? "" : lastSaid(bot.messages)}</span></span>` +
        `</span>` +
        badgeHtml(news) +
        `</button>`
      );
    })
      .join("");
}

/** The mark on a row for something you have not seen.
 *
 *  A count only when somebody actually addressed you; otherwise a dot. A
 *  number for every message would make a channel where two bots are working
 *  look like an emergency, and a room that chatters is not a room that asked
 *  you a question. */
/** When this conversation last had anything said in it.
 *
 *  Empty rather than a fallback for one that has never been used: a row of
 *  "--" down the sidebar says nothing anyone wanted to know. */
function lastSaid(messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.text.trim());
  return last ? clock(last.at) : "";
}

function badgeHtml(news: { unread: number; mentions: number }): string {
  if (news.mentions) {
    return `<span class="row-badge">${news.mentions > 9 ? "9+" : news.mentions}</span>`;
  }
  return news.unread ? `<span class="row-dot"></span>` : "";
}

/** A small drawing per lesson, which moves when the card is hovered or
 *  focused. Made of two or three elements and some CSS rather than an icon
 *  font or an SVG each: what is being animated is the idea — a face appearing,
 *  a block landing on a calendar, a screen coming on, a signal leaving a
 *  phone, a plug going in — and none of those needs more than a few boxes. */
const ART: Record<string, string> = {
  "new-bot": `<span class="art art--bot"><i></i><i></i></span>`,
  engine: `<span class="art art--engine"><i></i><i></i><i></i></span>`,
  teach: `<span class="art art--teach"><i></i><i></i></span>`,
  routines: `<span class="art art--cal"><i></i><i></i><i></i><i></i></span>`,
  computer: `<span class="art art--screen"><i></i></span>`,
  phone: `<span class="art art--phone"><i></i><i></i></span>`,
  plugins: `<span class="art art--plug"><i></i><i></i></span>`,
};

/** The lessons, as something to press.
 *
 *  Two shapes, because they have two jobs. On an empty thread they are the
 *  content — a bento, given room. Once there is a conversation they become a
 *  strip pinned to the top of it: the same five, still one press away, but not
 *  competing with the thing you came to read. Before this they scrolled off
 *  the top, which left the guide's whole purpose reachable for about one
 *  message. */
function lessonsHtml(pinned = false): string {
  return (
    `<div class="lessons${pinned ? " lessons--bar" : ""}">` +
    LESSONS.map(
      (lesson) =>
        `<button type="button" class="lesson" data-lesson="${lesson.id}">` +
        ART[lesson.id] +
        `<span class="lesson__title">${escapeHtml(lesson.title)}</span>` +
        `<span class="lesson__go">Show me</span></button>`,
    ).join("") +
    `</div>`
  );
}

/* ------------------------------------------------------------------- thread */

const CLAMP_AT = 420;

function bubbleHtml(msg: Message, ch?: Channel): string {
  const body = `<div class="md">${markMentions(renderMd(msg.text), mentionable(ch))}</div>`;
  const clamp = msg.text.length > CLAMP_AT;
  const pinned = msg.pinned ? `<span class="bubble__pin" title="Pinned">${icon("pin")}</span>` : "";
  const react = msg.reaction ? `<div class="reacts"><span class="react">${msg.reaction}</span></div>` : "";
  return (
    `<div class="bubble${clamp ? " is-clamped" : ""}">` +
    `<div class="bubble__body">${body}</div>` +
    (clamp ? `<button type="button" class="more-btn">Show more ${icon("chev")}</button>` : "") +
    pinned +
    react +
    `</div>`
  );
}

function actsHtml(msg: Message): string {
  const extra =
    msg.from === "bot"
      ? `<button type="button" data-act="copy" title="Copy">${icon("copy")}</button>` +
        `<button type="button" data-act="retry" title="Regenerate">${icon("refresh")}</button>`
      : "";
  return (
    `<div class="acts">` +
    `<button type="button" data-act="more" title="More">${icon("dots")}</button>` +
    `<button type="button" data-act="reply" title="Reply">${icon("reply")}</button>` +
    `<button type="button" data-act="react" title="React">${icon("smile")}</button>` +
    extra +
    `</div>`
  );
}

/** Messages closer together than this, from the same person, are one run. */
const SAME_BREATH = 5 * 60 * 1000;

/** Whether this message opens a run rather than continuing one.
 *
 *  A run gets a face, a name and a time; the rest of it gets none of those and
 *  reads as one person still speaking. That is the whole of what makes a flat
 *  list readable — without it every line carries the same furniture and the eye
 *  has nothing to skip. */
function startsRun(msg: Message, prev?: Message): boolean {
  if (!prev) return true;
  // A note between two messages breaks the run: something happened in between.
  if (prev.kind === "routine" || prev.kind === "teach") return true;
  if (prev.from !== msg.from) return true;
  if (msg.from === "bot" && prev.by !== msg.by) return true;
  // The phone mark lives on the head of a run, so a change of device has to
  // start one — otherwise it would speak for messages it does not describe.
  if (!!prev.fromPhone !== !!msg.fromPhone) return true;
  return msg.at - prev.at > SAME_BREATH;
}

/** Who said it, as a name and a face.
 *
 *  A bot in a room is named by the message; a bot in its own chat is the bot
 *  whose chat it is. You are you, drawn the way the account row at the foot of
 *  the sidebar draws you, so the same person looks the same in both places. */
function saidBy(msg: Message, ch?: Channel): { name: string; face: string } {
  if (msg.from === "me") {
    const name = appSettings().name?.trim() || "You";
    const initial = escapeHtml((name[0] ?? "?").toUpperCase());
    return { name, face: `<span class="turn__me">${initial}</span>` };
  }
  const bot = ch ? state.bots.find((b) => b.id === msg.by) : activeBot();
  return bot
    ? { name: bot.name, face: faceHtml(bot, "sm") }
    : { name: "", face: `<span class="turn__me">·</span>` };
}

function turnEl(msg: Message, ch?: Channel, prev?: Message): HTMLElement {
  const wrap = document.createElement("div");
  wrap.dataset.msg = msg.id;

  if (msg.kind === "routine") {
    wrap.className = "turn turn--note";
    wrap.innerHTML =
      `<span class="learn-badge">${icon("clock")}Routine · ${escapeHtml(msg.meta?.name ?? "")}</span>`;
    return wrap;
  }

  if (msg.kind === "teach") {
    const steps = msg.meta?.steps ?? 0;
    const frames = msg.meta?.frames ?? 0;
    wrap.className = "turn turn--note";
    const label = msg.meta?.name ? `Learned: ${escapeHtml(msg.meta.name)}` : "Learned from demonstration";
    wrap.innerHTML =
      `<span class="learn-badge">${icon("cube")}${label}</span>` +
      `<span class="learn-meta">${steps} step${steps === 1 ? "" : "s"} · ${frames} frame${frames === 1 ? "" : "s"}</span>`;
    return wrap;
  }

  // A message with a thread hanging off it says so, and is the way in. Without
  // this a thread exists only in the sidebar, and the line it came from — the
  // thing you would go looking from — gives no sign anything happened.
  const hanging = ch ? channels().find((c) => c.from?.messageId === msg.id) : null;
  const head = startsRun(msg, prev);
  const who = saidBy(msg, ch);

  // A bot saying your name is the one message in a busy room you cannot afford
  // to scroll past, so the row itself is marked and not only the name in it.
  const ping = msg.from === "bot" && mentionsYou(msg.text);

  wrap.className =
    `turn turn--${msg.from}${head ? " turn--head" : ""}${ping ? " turn--ping" : ""}`;
  wrap.innerHTML =
    // The gutter carries the face at the top of a run and the time on the rest,
    // which only shows on hover: a column of timestamps down every line is the
    // thing a flat list has to avoid.
    `<div class="turn__gutter">` +
    (head ? who.face : `<span class="turn__at">${clock(msg.at)}</span>`) +
    `</div>` +
    `<div class="turn__main">` +
    (head
      ? `<div class="turn__who">` +
        `<span class="turn__name">${escapeHtml(who.name)}</span>` +
        `<span class="turn__when">${clock(msg.at)}</span>` +
        (msg.fromPhone
          ? `<span class="from-phone" title="Sent from your phone">${icon("ios")}</span>`
          : "") +
        `</div>`
      : "") +
    bubbleHtml(msg, ch) +
    askHtml(msg) +
    (hanging ? threadStrip(hanging, msg) : "") +
    `</div>` +
    actsHtml(msg);
  return wrap;
}

/** A question with its answers ready to press.
 *
 *  The reply above already asked it in the bot's own words — the tool says so
 *  and the buttons are worthless without it. This is the shortcut, not the
 *  question: what a row of buttons buys is that an answer costs a thumb rather
 *  than a sentence, which is the whole difference between a routine that gets
 *  answered this evening and one that gets answered tomorrow.
 *
 *  Once pressed the row stays, showing what was chosen. A thread read the next
 *  morning should still say what was asked and what you said back; buttons
 *  that vanish leave a question hanging over an answer that came from nowhere.
 */
function askHtml(msg: Message): string {
  if (!msg.ask) return "";
  const { question, options, answered } = msg.ask;

  return (
    `<div class="ask${answered ? " is-answered" : ""}">` +
    (question ? `<p class="ask__q">${escapeHtml(question)}</p>` : "") +
    `<div class="ask__row">` +
    options
      .map((one) => {
        const chosen = answered === one;
        return (
          `<button type="button" class="ask__opt${chosen ? " is-chosen" : ""}" ` +
          // Disabled rather than removed: the ones you did not pick are what
          // make the one you did mean anything.
          `${answered ? "disabled" : ""} data-ask="${escapeHtml(msg.id)}" ` +
          `data-answer="${escapeHtml(one)}">${escapeHtml(one)}</button>`
        );
      })
      .join("") +
    `</div></div>`
  );
}

/** Which engine and model answer for a bot, as one line.
 *
 *  Both, because neither alone says enough: "Claude Code" does not say which
 *  model, and "opus" does not say what is running it. */
function modelSays(bot: Bot): string {
  const engine = engineChoices.find((info) => info.key === (bot.engine ?? DEFAULT_ENGINE));
  const name = engine?.name ?? "Claude Code";
  return bot.model ? `${name} · ${bot.model}` : name;
}

/** Who a bot is, on one card.
 *
 *  Everything here is already somewhere in the app — the role is in its
 *  settings, the hours are on the shift picker, what it costs is on the
 *  payroll, what it answers to is behind a slash. Scattered across four panels
 *  it is configuration; gathered on the face you just clicked it is a
 *  colleague. That is the whole of what this adds, and it is most of what a
 *  server full of bots feels like.
 *
 *  Read-only. Every line has a place it is edited and the card links to it
 *  rather than growing a second set of controls that drift from the first.
 */
function cardHtml(bot: Bot): string {
  const working = inflight.get(bot.id);
  const manner = mannerOf(bot);
  const week = bot.spend?.weekUsd ?? 0;
  const live = (bot.routines ?? []).filter((r) => r.active).length;

  // What it is doing, in the present tense, because that is the question
  // somebody clicking a face has. Working beats off-the-clock: a bot mid-turn
  // is mid-turn whatever the hours say.
  const doing = working
    ? working.note || "Working"
    : bot.hours && !onTheClock(bot)
      ? `Off the clock · ${saysHours(bot)}`
      : bot.hours
        ? `On the clock · ${saysHours(bot)}`
        : "Ready";

  const line = (label: string, value: string) =>
    `<div class="card__line"><span class="card__label">${escapeHtml(label)}</span>` +
    `<span class="card__value">${escapeHtml(value)}</span></div>`;

  return (
    `<div class="card">` +
    `<div class="card__head">${faceHtml(bot, "lg")}` +
    `<div class="card__who"><p class="card__name">${escapeHtml(bot.name)}</p>` +
    `<p class="card__doing${working ? " is-working" : ""}">${escapeHtml(doing)}</p></div></div>` +
    // The job in its own words, which is the one thing here that is prose.
    (bot.role
      ? `<p class="card__role">${escapeHtml(bot.role.split("\n")[0].slice(0, 200))}</p>`
      : "") +
    `<div class="card__lines">` +
    line("Answered by", modelSays(bot)) +
    line("Manner", manner.name) +
    (live ? line("Routines", `${live} active`) : "") +
    // Only once it has cost something. A row saying $0.00 is a row about
    // nothing, and this week's is the number worth knowing.
    (week > 0 ? line("This week", money(week)) : "") +
    `</div>` +
    // What it says it can do — the same list a slash offers, in the place
    // somebody looks when they are asking what a bot is for.
    (bot.commands?.length
      ? `<div class="card__cmds">` +
        bot.commands
          .map(
            (one) =>
              `<div class="card__cmd"><code>/${escapeHtml(one.name)}</code>` +
              `<span>${escapeHtml(one.what)}</span></div>`,
          )
          .join("") +
        `</div>`
      : "") +
    `<div class="card__acts">` +
    `<button type="button" class="card__act" data-card-open="${bot.id}">Open</button>` +
    `<button type="button" class="card__act" data-card-settings="${bot.id}">Settings</button>` +
    `</div></div>`
  );
}

/** The way into a thread, from the message it was pulled out of. */
function threadStrip(thread: Channel, from: Message): string {
  // The quoted first message came from here, so it is not a reply.
  const said = Math.max(0, thread.messages.filter((m) => m.text.trim()).length - 1);
  const news = unreadIn(thread.messages, thread.seenAt);

  // A thread keeps the name it was born with — the opening words of the
  // message — so printing it directly under that message says the same thing
  // twice. Named only once somebody has renamed it to something else.
  const flat = from.text.replace(/\s+/g, " ").trim();
  const named = !flat.startsWith(thread.name)
    ? `<span class="thread-strip__name">${escapeHtml(thread.name)}</span>`
    : "";

  return (
    `<button type="button" class="thread-strip${news.unread ? " is-unread" : ""}" ` +
    `data-open-thread="${thread.id}">` +
    `<span class="thread-strip__arrow">${icon("reply")}</span>` +
    named +
    `<span class="thread-strip__count">` +
    `${said === 0 ? "Thread — nothing said yet" : said === 1 ? "1 reply" : `${said} replies`}` +
    `</span></button>`
  );
}

/** How many pinned messages the open conversation has. */
function pinsHere(): Message[] {
  const room = activeChannel();
  const all = room ? room.messages : (activeBot()?.messages ?? []);
  return all.filter((m) => m.pinned);
}

function paintPins(): void {
  const many = pinsHere().length;
  const button = $<HTMLButtonElement>("#btn-pins");
  button.hidden = false;
  button.title = many ? `${many} pinned` : "Nothing pinned yet";
  $<HTMLSpanElement>("#btn-pins-count").textContent = many ? String(many) : "";
}

$<HTMLButtonElement>("#btn-pins").addEventListener("click", (event) => {
  const pinned = pinsHere();
  if (!pinned.length) {
    toast("Nothing pinned — pin a message from its ⋯ menu");
    return;
  }
  openMenu(
    event.currentTarget as HTMLElement,
    pinned
      .map(
        (m) =>
          `<button type="button" class="menu-item menu-item--pin" data-goto="${m.id}">` +
          `<span class="pin-who">${escapeHtml(nameOf(m.by) || (m.from === "me" ? userName() || "You" : "Bot"))}</span>` +
          `<span class="pin-said">${escapeHtml(m.text.replace(/\s+/g, " ").slice(0, 70))}</span></button>`,
      )
      .join(""),
    "menu--pins",
  );
});

menu.addEventListener("click", (event) => {
  const go = (event.target as HTMLElement).closest<HTMLElement>("[data-goto]");
  if (!go) return;
  closeMenu();
  const at = thread.querySelector<HTMLElement>(`[data-msg="${go.dataset.goto}"]`);
  at?.scrollIntoView({ behavior: "smooth", block: "center" });
  at?.classList.add("is-found");
  window.setTimeout(() => at?.classList.remove("is-found"), 1400);
});

/** Redraw whichever conversation is on screen. */
function redrawConversation(): void {
  if (activeChannel()) renderChannel();
  else renderThread();
}

/** A message and where it lives — a room, or a bot's own chat.
 *
 *  Everything a message can have done to it used to look in `activeBot()`,
 *  which meant not one of copy, react, pin or delete worked in a channel: the
 *  room's messages are not any bot's. */
function messageAt(id: string): { msg: Message; room?: Channel; bot?: Bot } | null {
  const room = activeChannel();
  if (room) {
    const msg = room.messages.find((m) => m.id === id);
    return msg ? { msg, room } : null;
  }
  const bot = activeBot();
  const msg = bot?.messages.find((m) => m.id === id);
  return bot && msg ? { msg, bot } : null;
}

/** The live body element of a message, if that message is currently on screen. */
const bodyOf = (msgId: string) =>
  thread.querySelector<HTMLElement>(`[data-msg="${msgId}"] .bubble__body`);

/** The number on the clock. Its own function because a routine can now appear
 *  while a thread is on screen — a colleague scheduled it — and re-rendering
 *  the whole thread to move one digit would throw away a streaming reply. */
function paintRoutineCount(): void {
  const bot = activeBot();
  const live = (bot?.routines ?? []).filter((r) => r.active).length;
  $<HTMLButtonElement>("#btn-routines").title = live
    ? `${live} active routine${live === 1 ? "" : "s"}`
    : "Routines";
  $<HTMLSpanElement>("#btn-routines-count").textContent = live ? String(live) : "";
}

function renderThread(): void {
  const bot = activeBot();
  const was = heldPlace(`bot:${bot?.id ?? ""}`);
  if (!bot) {
    topbarId.innerHTML = "";
    thread.innerHTML = `<div class="empty"><h2>No bots yet</h2><p>Hit + to cage your first bot.</p></div>`;
    input.placeholder = "Message";
    return;
  }

  // The face alone. Which bot you are talking to is answered three times over
  // — the highlighted row in the sidebar, the face here, and the placeholder
  // in the composer — and the name spelled out in the bar was the least of
  // them.
  topbarId.innerHTML = `<span title="${escapeHtml(bot.name)}">${faceHtml(bot, "sm")}</span>`;
  input.placeholder = `Message ${bot.name}`;

  paintRoutineCount();

  if (!bot.messages.length) {
    // On a fresh install this is the whole app: one bot, nothing said yet. Say
    // where more come from, because a plus icon in a corner is not an answer to
    // "what now".
    thread.innerHTML =
      `<div class="empty">${faceHtml(bot, "lg")}<h2>${escapeHtml(bot.name)}</h2>` +
      (bot.guide ? "" : `<p>${escapeHtml(bot.role || "Say hello to get started.")}</p>`) +
      `</div>` +
      // Under the guide's own face rather than above it: this is what it is
      // offering, and a stack of cards over the top of an introduction reads
      // as though the introduction were an afterthought.
      (bot.guide ? lessonsHtml() : "");
  } else {
    thread.innerHTML = "";
    bot.messages.forEach((msg, n) => thread.append(turnEl(msg, undefined, bot.messages[n - 1])));
  }

  // Once it has been spoken to, the lessons move above the conversation: they
  // are not things it said, and they should not read as the last thing it did.
  if (bot.guide && bot.messages.length) {
    thread.insertAdjacentHTML("afterbegin", lessonsHtml(true));
  }
  if (bot.guide && !bot.messages.length) scroller.scrollTop = 0;

  // Re-attach the waiting indicator if this bot is mid-turn.
  const pending = inflight.get(bot.id);
  if (pending && !pending.sawText) waitingHtml(pending.message.id, pending.note);

  markSeen();
  paintPins();
  syncSend();
  restorePlace(was);
}

function scrollToEnd(smooth = false): void {
  // Going to the end is the end of having missed anything, whoever asked for
  // it — opening a conversation, sending a message, or pressing the pill.
  missed = 0;
  jump.hidden = true;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;

/* ------------------------------------------------------------ finding a line */

/** Searching what is in front of you: this room, this thread, this bot.
 *
 *  The box in the sidebar answers a different question — which conversation —
 *  and this one answers which message, then takes you to it. Both are worth
 *  having and neither replaces the other. */


/** The messages of whatever is open, and where they live. */
function openConversation(): { messages: Message[]; channel?: Channel } | null {
  const room = activeChannel();
  if (room) return { messages: room.messages, channel: room };
  const bot = activeBot();
  return bot ? { messages: bot.messages } : null;
}

function closeFind(): void {
  findBox.value = "";
  findClear.hidden = true;
  found.hidden = true;
}

function runFind(): void {
  const q = findBox.value.trim().toLowerCase();
  findClear.hidden = !q;
  if (!q) {
    found.hidden = true;
    return;
  }

  const open = openConversation();
  const hits = (open?.messages ?? [])
    .filter((m) => m.text.toLowerCase().includes(q))
    // Newest first, which is where a search in a conversation usually means.
    .reverse();

  found.hidden = false;
  foundHead.textContent = hits.length
    ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
    : "No results";

  if (!hits.length) {
    foundList.innerHTML = `<p class="found__none">Nothing in this conversation says that.</p>`;
    return;
  }

  foundList.replaceChildren(
    ...hits.map((msg) => {
      const who = saidBy(msg, open?.channel);
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "hit";
      hit.dataset.goto = msg.id;
      hit.innerHTML =
        `<span class="hit__who">` +
        `<span class="hit__name">${escapeHtml(who.name)}</span>` +
        `<span class="hit__when">${clock(msg.at)}</span>` +
        `</span>` +
        `<span class="hit__text">${highlight(msg.text, q)}</span>`;
      return hit;
    }),
  );
}

/** The words that were searched for, marked in what came back. */
function highlight(text: string, q: string): string {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return escapeHtml(text);
  // A little of what came before, so the match is not stranded at the top of
  // an answer that starts three paragraphs earlier.
  const from = Math.max(0, at - 60);
  const lead = from > 0 ? "…" : "";
  return (
    lead +
    escapeHtml(text.slice(from, at)) +
    `<mark>${escapeHtml(text.slice(at, at + q.length))}</mark>` +
    escapeHtml(text.slice(at + q.length, at + q.length + 160))
  );
}

/** Take me to that line, and make it obvious which one it was. */
function gotoMessage(id: string): void {
  // The calendar covers the conversation while leaving the search in the
  // header, so a result could be clicked with nothing to scroll: the line was
  // there, behind a week view, and the app looked broken. Going to a message
  // means going to where messages are.
  if (routinesOpen) showRoutines(false);

  const el = thread.querySelector<HTMLElement>(`[data-msg="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("turn--lit");
  window.setTimeout(() => el.classList.remove("turn--lit"), 1800);
}

findBox.addEventListener("input", runFind);
findClear.addEventListener("click", () => {
  closeFind();
  findBox.focus();
});

findBox.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeFind();
    findBox.blur();
  }
});

foundList.addEventListener("click", (event) => {
  const hit = (event.target as HTMLElement).closest<HTMLElement>("[data-goto]");
  if (!hit?.dataset.goto) return;
  gotoMessage(hit.dataset.goto);
});

/* --------------------------------------------------------- jump to present */

/** Something landed in the conversation you have open.
 *
 *  Used instead of scrolling outright, for anything you did not type: a bot
 *  answering, a routine firing, a message sent from your phone. Reading back
 *  through a room while bots talk used to drag you to the bottom mid-sentence,
 *  which is the one thing a chat window must not do. Now it counts, and the
 *  pill offers to take you down when you are ready to go. */
function arrived(): void {
  if (nearBottom()) {
    scrollToEnd(true);
    return;
  }
  missed += 1;
  paintJump();
}

function paintJump(): void {
  const away = !nearBottom();
  jump.hidden = !away;
  if (!away) return;
  // Quiet when it is only offering to take you back, loud when you are being
  // told something you have not seen.
  jump.classList.toggle("is-new", missed > 0);
  jumpWhat.textContent = missed
    ? `${missed} new message${missed === 1 ? "" : "s"}`
    : "Jump to present";
}

scroller.addEventListener(
  "scroll",
  () => {
    // Scrolling back down yourself counts as having caught up.
    if (nearBottom()) missed = 0;
    paintJump();
  },
  { passive: true },
);

jump.addEventListener("click", () => scrollToEnd(true));

/** Which conversation the scroller is showing, so that a repaint can tell
 *  itself apart from a change of subject. */
let showing = "";

/** Where the view was, for a repaint that is about to throw the thread away.
 *
 *  `null` means either that it was already at the end, or that this is a
 *  different conversation from the one that was open — both of which are
 *  answered by going to the end rather than by putting anything back. */
function heldPlace(what: string): number | null {
  const same = showing === what;
  // Results belong to the conversation they were found in, so a change of
  // subject takes them down rather than leaving a panel of lines that are no
  // longer anywhere on screen.
  if (!same) closeFind();
  showing = what;
  return same && !nearBottom() ? scroller.scrollTop : null;
}

/** Put it back, after the thread has been rebuilt.
 *
 *  Opening a conversation and repainting the one you are already reading are
 *  the same function, so the difference has to be where you were rather than
 *  which of the two it was. A bot finishing a turn repaints the whole room, and
 *  before this that meant being dragged to the bottom mid-sentence every time
 *  anyone answered — the one thing a window full of talking bots must not do.
 *  Anything that arrived is still counted on the pill, so nothing is lost by
 *  staying put. */
function restorePlace(was: number | null): void {
  if (was === null) {
    scrollToEnd();
    return;
  }
  scroller.scrollTop = was;
  paintJump();
}

function waitingHtml(msgId: string, note: string): void {
  const body = bodyOf(msgId);
  if (!body) return;
  body.innerHTML = note
    ? `<p class="thinking"><span class="shimmer">${escapeHtml(note)}</span></p>`
    : `<div class="typing"><i></i><i></i><i></i></div>`;
}

/* ------------------------------------------------------------------ turns */

/** How a bot writes.
 *
 *  Register only: how long its sentences run, how it opens, how warm it is on
 *  the surface. Nothing here touches what it is willing to say, how sure it
 *  claims to be, or whether it agrees with you — a "manner" that reached those
 *  would be a personality prompt, and a personality prompt is how a competent
 *  assistant is made worse. That is what the last line guards, and it is sent
 *  with every one of them.
 *
 *  Picked by the id like the face and the voice, so a bot sounds like itself
 *  from the first message and keeps sounding like itself. "Plain" is nothing
 *  at all, for anyone who wants the model's own voice.
 */
const MANNERS: { key: string; name: string; line: string }[] = [
  { key: "plain", name: "Plain", line: "" },
  {
    key: "brisk",
    name: "Brisk",
    line:
      "Answer in as few words as the question needs. Lead with the answer and put the reasoning " +
      "after it, if it is load-bearing at all.",
  },
  {
    key: "warm",
    name: "Warm",
    line:
      "Write the way a helpful colleague talks: whole sentences, and a word of acknowledgement when " +
      "somebody has hit a wall. The warmth is in the phrasing and never in the facts — a problem is " +
      "still a problem.",
  },
  {
    key: "dry",
    name: "Dry",
    line:
      "Understated. Say the awkward part plainly, without softening it and without dressing it up. " +
      "No exclamation marks and no enthusiasm you do not have.",
  },
  {
    key: "precise",
    name: "Precise",
    line:
      "Say exactly what you mean, with the qualifications attached to the claim rather than trailing " +
      "after it. Prefer a number to an adjective, and name the thing rather than calling it 'it'.",
  },
  {
    key: "plan-first",
    name: "Plan first",
    line:
      "Open with one line saying what you are about to do, then do it. If a job has more than three " +
      "steps, list them before you start.",
  },
];

/** A guard sent with every manner: the manner is a way of writing, and it is
 *  never a reason to be less straight with somebody. */
const MANNER_GUARD =
  "This is how you write, not what you say. Never soften a fact, overstate a result, or agree with " +
  "something you do not agree with in order to sound a particular way.";

function mannerOf(bot: Bot): { key: string; name: string; line: string } {
  const chosen = bot.manner && MANNERS.find((m) => m.key === bot.manner);
  if (chosen) return chosen;
  // The same trick the face uses, on its own slice of the hash so two bots
  // with the same eyes do not have to have the same manner.
  const picked = MANNERS.slice(1);
  return picked[(seedOf(bot.id) >> 15) % picked.length];
}

/** The line to put in a prompt, if there is one. */
function mannerLine(bot: Bot): string {
  const manner = mannerOf(bot);
  return manner.line ? `How you write: ${manner.line} ${MANNER_GUARD}` : "";
}

/** The shortcuts this bot declared, said back to it.
 *
 *  It writes the list with a tool, botcage stores it, and the user picks from
 *  it — and none of that reaches the bot, whose next turn sees "/breakfast"
 *  and has no idea what it is. It answered "unknown command", correctly.
 *
 *  So the list goes back into the prompt every turn. The bot is the one that
 *  decided what these mean, and the only thing it is missing is its own list. */
function commandsLine(bot: Bot): string {
  if (!bot.commands?.length) return "";
  const list = bot.commands.map((one) => `/${one.name} — ${one.what}`).join("\n");
  return (
    `Shortcuts you offer. The user picks one from a menu and it arrives at the start of ` +
    `their message, with whatever they typed after it:\n\n${list}\n\n` +
    `Treat a message beginning with one as that job being asked for, in the words above. ` +
    `Anything after it is the detail. If you no longer do one of these, say so and revise ` +
    `the list rather than refusing — you wrote it.`
  );
}

function systemPromptFor(bot: Bot): string {
  return [
    `You are "${bot.name}", one of several bots the user keeps in botcage, a desktop app where each bot is a persistent chat.`,
    // Bots have been talking to "the user", who is nobody. If this person has
    // said what they are called, say it — once, plainly, without instructing
    // anyone to use it in every sentence.
    userName() ? `The person you are talking to is called ${userName()}.` : "",
    // In the user's own words, whole. This used to be a one-line "what it does"
    // that read as a subtitle; it is now where someone describes a job, so it
    // is passed through rather than dressed up as a sentence.
    bot.role ? `What you are here to do, as the user described it:\n\n${bot.role}` : "",
    `You are talking in a chat window, so reply conversationally and keep it tight — a couple of short paragraphs unless depth is asked for. Markdown is rendered: bold, lists, and fenced code blocks all display properly.`,
    mannerLine(bot),
    commandsLine(bot),
    `Your working directory is a private scratch folder for this bot. You can read and write files there, and search the web, but you have no shell access and no access to the rest of the machine.`,
    `CLAUDE.md in that folder is loaded automatically at the start of every turn — it is your memory across sessions. When you learn something that will still matter next time (a decision, a preference, context that took work to establish), add it to the Memory section with the Edit tool. Don't record what the chat already shows.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function setStreaming(on: boolean): void {
  sendIcon.setAttribute("href", on ? "#i-stop" : input.value.trim() ? "#i-arrow-up" : "#i-mic");
  sendBtn.classList.toggle("is-stop", on);
  sendBtn.title = on ? "Stop" : "Send";
}

const syncSend = () => {
  const room = activeChannel();
  // In a room the button is a stop button while anybody in it is speaking —
  // it is one conversation, whoever's turn it happens to be.
  const busy = room
    ? [...inflight.values()].some((p) => p.channelId === room.id)
    : inflight.has(state.activeId ?? "");
  setStreaming(busy);
};

// It knows you are talking to it before you have finished the sentence.
input.addEventListener("input", () => {
  if (state.activeId && input.value.trim()) setMood(state.activeId, "listen");
});

// Click a bot's face anywhere it appears — the list, the header, the top of
// its own thread — and it waves back. Bound to the face rather than to each
// place one shows up, so a face added to a new screen tomorrow waves too.
document.addEventListener("click", (e) => {
  const face = (e.target as HTMLElement).closest<HTMLElement>(".face[data-bot]");
  if (face?.dataset.bot) setMood(face.dataset.bot, "wave");
});

// A bot leans over when you point at it in the list.
botsEl.addEventListener("mouseover", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-bot]");
  const botId = row?.dataset.bot;
  if (botId && !moods.has(botId)) setMood(botId, "peek");
});

// And every so often, one of the idle ones stretches. Not on a schedule anyone
// could predict — a roster of statues is the thing this is meant to avoid, and
// a roster that all moves at once is the same problem wearing a different hat.
window.setInterval(() => {
  if (document.hidden) return;
  const resting = state.bots.filter(
    (bot) => !inflight.has(bot.id) && !moods.has(bot.id) && restingMood(bot.id) === "idle",
  );
  if (!resting.length) return;
  setMood(resting[Math.floor(Math.random() * resting.length)].id, "stretch");
}, 24_000);

async function respond(bot: Bot, prompt: string, style?: string): Promise<void> {
  const message: Message = { id: uid(), from: "bot", text: "", at: Date.now() };
  bot.messages.push(message);
  inflight.set(bot.id, { message, sawText: false, note: "" });
  // A bot that had gone to sleep wakes rather than simply starting to read:
  // three days is long enough that coming back should look like coming back.
  setMood(bot.id, restingMood(bot.id) === "sleep" ? "wake" : "read");

  if (bot.id === state.activeId) {
    thread.append(turnEl(message, undefined, bot.messages[bot.messages.length - 2]));
    waitingHtml(message.id, "");
    arrived();
  }
  syncSend();
  renderRoster();

  try {
    await invoke("ask", {
      req: {
        botId: bot.id,
        engine: bot.engine ?? DEFAULT_ENGINE,
        provider: bot.provider,
        sessionId: bot.sessionId,
        resume: bot.started,
        prompt,
        // `style` is how this turn should be delivered rather than who the bot
        // is — a call asks for two spoken sentences from the same bot with the
        // same memory, not for a different bot.
        systemPrompt: style ? `${systemPromptFor(bot)}\n\n${style}` : systemPromptFor(bot),
        model: bot.model || MODEL,
        botName: bot.name,
        botRole: bot.role,
        // Who else it could hand work to. Names, not ids, because that is what
        // a bot has to say out loud — and only the bots that carry tools can
        // act on it anyway.
        colleagues: state.bots.filter((b) => b.id !== bot.id).map((b) => b.name),
        computer: bot.computer,
        brand: {
          name: bot.name,
          color: bot.color,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          locale: navigator.language ?? "",
          network: bot.network,
          github: (bot.plugins ?? []).includes("github"),
          ...machineBrand(bot),
        },
        plugins: bot.plugins ?? [],
        // Everything else this machine offers, named so it can be denied: the
        // servers load whatever we do, so scoping is subtraction, not omission.
        blockedPlugins: plugins.map((p) => p.key).filter((key) => !(bot.plugins ?? []).includes(key)),
      },
    });
  } catch (err) {
    finish(bot.id, { botId: bot.id, kind: "error", text: String(err) });
  }
}

/** The week's tab, per bot.
 *
 *  Turns first and money second, because for a bot answering on a local model
 *  the money is zero and the turns are the whole story — and because "which of
 *  them is busy" is a question people ask more often than "which of them is
 *  expensive". A bot that has never taken a turn is not listed: a row of
 *  zeroes is a row that has to be read to learn nothing.
 */
function paintPayroll(): void {
  const week = isoDate(weekStart(Date.now()));
  const paid = state.bots
    .filter((bot) => bot.spend?.turns)
    .sort((a, b) => (b.spend?.weekTurns ?? 0) - (a.spend?.weekTurns ?? 0));

  const wrap = $<HTMLDivElement>("#app-payroll");
  if (!paid.length) {
    wrap.innerHTML = "";
    return;
  }

  const money = (usd: number) => (usd >= 0.005 ? `$${usd.toFixed(2)}` : "—");
  const turns = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;

  const week_ = paid.filter((bot) => bot.spend?.week === week && bot.spend.weekTurns);
  const totalTurns = week_.reduce((all, bot) => all + (bot.spend?.weekTurns ?? 0), 0);
  const totalUsd = week_.reduce((all, bot) => all + (bot.spend?.weekUsd ?? 0), 0);

  wrap.innerHTML =
    `<p class="payroll__cap">This week</p>` +
    (week_.length
      ? week_
          .map((bot) => {
            const tab = bot.spend!;
            return (
              `<div class="payroll__row">` +
              faceHtml(bot, "xs") +
              `<span class="payroll__who">${escapeHtml(bot.name)}</span>` +
              `<span class="payroll__turns">${turns(tab.weekTurns)}</span>` +
              `<span class="payroll__usd">${money(tab.weekUsd)}</span>` +
              `</div>`
            );
          })
          .join("") +
        `<div class="payroll__row payroll__row--sum">` +
        `<span class="payroll__who">Everyone</span>` +
        `<span class="payroll__turns">${turns(totalTurns)}</span>` +
        `<span class="payroll__usd">${money(totalUsd)}</span>` +
        `</div>`
      : `<p class="payroll__none">Nothing yet this week.</p>`) +
    // All time, one line: the week is the useful number and the total is the
    // one people want once and then rarely again.
    `<p class="payroll__all">All time: ${turns(
      paid.reduce((all, bot) => all + (bot.spend?.turns ?? 0), 0),
    )} · ${money(paid.reduce((all, bot) => all + (bot.spend?.usd ?? 0), 0))}</p>`;
}

/** Put a turn on a bot's tab.
 *
 *  Every turn counts, whether or not it came with a price. Claude Code reports
 *  what a turn cost; Ollama on this machine costs nothing and says so by
 *  saying nothing, and a bot answering fifty times a day for free is still a
 *  bot answering fifty times a day. Counting only the priced ones would make
 *  the cheap bots invisible, which is the opposite of what a ledger is for.
 */
function bill(bot: Bot, usd: number): void {
  const week = isoDate(weekStart(Date.now()));
  const tab = bot.spend ?? { turns: 0, usd: 0, week, weekTurns: 0, weekUsd: 0 };
  // A new week starts the week's columns again and leaves the totals alone.
  if (tab.week !== week) {
    tab.week = week;
    tab.weekTurns = 0;
    tab.weekUsd = 0;
  }
  tab.turns += 1;
  tab.weekTurns += 1;
  tab.usd += usd;
  tab.weekUsd += usd;
  bot.spend = tab;
}

function finish(botId: string, event: BotEvent): void {
  const pending = inflight.get(botId);
  const bot = state.bots.find((b) => b.id === botId);
  if (!pending || !bot) return;
  inflight.delete(botId);

  if (event.kind === "done") {
    const spend = event.detail as { costUsd?: number } | null;
    // The turn happened whether or not anybody charged for it: the count used
    // to be inside the price check, so a session of Ollama turns reported none
    // at all.
    session.turns += 1;
    session.costUsd += spend?.costUsd ?? 0;
    bill(bot, spend?.costUsd ?? 0);
    // The result field is authoritative; deltas can be shed under load.
    if (event.text && event.text.length > pending.message.text.length) {
      pending.message.text = event.text;
    }
    // Only the bot's own session. A turn taken in a room created a different
    // session entirely, and flagging this one would have the next private turn
    // resume a conversation that was never started.
    if (!pending.channelId) bot.started = true;
  } else if (event.kind === "cancelled") {
    pending.message.text = pending.message.text || "_Stopped._";
  } else {
    pending.message.error = event.text ?? "Something went wrong";
    pending.message.text = pending.message.text || `⚠︎ ${pending.message.error}`;
    toast(pending.message.error);
  }

  pending.message.at = Date.now();
  save();
  renderRoster();
  if (pending.channelId) {
    if (pending.channelId === state.activeChannel) renderChannel();
    else syncSend();
  } else if (botId === state.activeId) renderThread();
  else syncSend();

  // Whoever was waiting on this turn — the room, taking one voice at a time.
  pending.settle?.();
  // And the call, if this bot is on one, which is where it gets spoken.
  callHeardBack(botId, pending.message.text, event.kind !== "done");

  // If the demonstration went out unnamed, the bot was asked to name it.
  const demo = [...bot.messages].reverse().find((m) => m.kind === "teach");
  if (event.kind === "done" && demo?.meta && !demo.meta.name) {
    void invoke<string | null>("teach_name", { botId, slug: demo.meta.slug })
      .then((name) => {
        if (!name || !demo.meta) return;
        demo.meta.name = name;
        save();
        if (botId === state.activeId) renderThread();
        renderRoster();
      })
      .catch(() => {});
  }
}

function handleBotEvent(event: BotEvent): void {
  // Any event at all proves the CLI ran, and the session file exists from that
  // moment. Marking the bot started only when a turn *finished* meant a first
  // turn that was cancelled or failed left the flag false with the session
  // already on disk — so every later turn asked for a new session with an id
  // that was taken, and the bot answered "Session ID … is already in use"
  // forever. Recording it here also heals a bot already in that state: the
  // failure itself is the event that sets the flag.
  const from = state.bots.find((bot) => bot.id === event.botId);
  if (from && !from.started && !inflight.get(event.botId)?.channelId) {
    from.started = true;
    save();
  }

  // What the bot's face does about it. Everything here is already in botcage's
  // vocabulary, so a mood costs a line rather than a new event.
  // Work a bot put on a calendar — its own, or a colleague's. Applied at the
  // end of a turn for the same reason a face is: the tool wrote a file and the
  // process that wrote it is gone.
  if (event.kind === "done" || event.kind === "error" || event.kind === "cancelled") {
    void invoke<Record<string, unknown>[]>("take_routines", { botId: event.botId })
      .then((wanted) => {
        const author = state.bots.find((b) => b.id === event.botId);
        if (!author || !wanted?.length) return;
        for (const one of wanted) {
          const named = String(one.bot ?? "").trim();
          // No name means its own calendar. A name that matches nobody is
          // dropped rather than guessed at: the roster can change while a turn
          // runs, and the wrong bot doing the work is worse than none.
          const target = named
            ? state.bots.find((b) => b.name.toLowerCase() === named.toLowerCase())
            : author;
          if (!target) continue;

          target.routines = target.routines ?? [];
          target.routines.push({
            id: uid(),
            name: String(one.name ?? "Routine").slice(0, 48),
            instruction: String(one.instruction ?? ""),
            every: String(one.every ?? "day") as Routine["every"],
            at: String(one.at ?? "09:00"),
            minutes: Number(one.minutes) || 15,
            day: Number(one.day) || 0,
            date: one.date ? String(one.date) : undefined,
            by: author.name,
            active: true,
            lastRunAt: Date.now(),
          });
          toast(
            target.id === author.id
              ? `${author.name} scheduled "${one.name}" for itself`
              : `${author.name} scheduled "${one.name}" for ${target.name}`,
          );
        }
        save();
        renderRoster();
        paintRoutineCount();
        if (routinesOpen) renderRoutines();
      })
      .catch(() => {});
  }

  // A bot may have changed its own face this turn. Checked at the end rather
  // than watched for: the tool writes a file, the window reads it once, and
  // nothing has to be listening while a turn runs.
  if (event.kind === "done" || event.kind === "error" || event.kind === "cancelled") {
    void invoke<(Partial<Face> & { colour?: string }) | null>("take_face", { botId: event.botId })
      .then((wanted) => {
        const bot = state.bots.find((b) => b.id === event.botId);
        if (!bot || !wanted) return;
        const { colour, ...traits } = wanted;
        // A new drawing replaces the old one rather than merging with it: two
        // hats stacked is nobody's intention.
        bot.face = { ...bot.face, ...traits };
        if (traits.mark && traits.mark !== "custom") delete bot.face.parts;
        if (colour) bot.color = colour;
        save();
        renderRoster();
        if (state.activeChannel) renderChannel();
        else renderThread();
        toast(`${bot.name} changed how it looks`);
      })
      .catch(() => {});
  }

  // It may also have revised what it says it can do. Same moment, same
  // reason: a file left by a process that has since exited.
  if (event.kind === "done") {
    void invoke<{ name?: unknown; what?: unknown }[] | null>("take_commands", {
      botId: event.botId,
    })
      .then((offered) => {
        const bot = state.bots.find((b) => b.id === event.botId);
        if (!bot || !offered) return;
        const clean = offered
          .map((one) => ({ name: String(one.name ?? "").trim(), what: String(one.what ?? "").trim() }))
          .filter((one) => one.name && one.what)
          .slice(0, 8);
        // An empty list is a bot withdrawing its shortcuts, which is why the
        // field is deleted rather than set to nothing: a bot with none should
        // look like a bot that never had any.
        if (clean.length) bot.commands = clean;
        else delete bot.commands;
        save();
        tellPhones();
      })
      .catch(() => {});
  }

  // And it may have left a question with its answers ready to press. Read the
  // same way and at the same moment as the face, because it is the same kind
  // of thing: a note from a process that has already exited.
  if (event.kind === "done") {
    const asked = inflight.get(event.botId)?.message;
    void invoke<{ question?: string; options?: unknown } | null>("take_ask", {
      botId: event.botId,
    })
      .then((left) => {
        if (!asked || !left) return;
        const options = Array.isArray(left.options)
          ? left.options.map(String).filter((one) => one.trim()).slice(0, 4)
          : [];
        // Checked again here rather than trusted: the file is written by a
        // process outside this window, and one button is not a choice.
        if (options.length < 2) return;
        asked.ask = { question: left.question?.trim() || undefined, options };
        save();
        redrawConversation();
        // A phone reads the snapshot again the moment a turn ends, and this
        // lands a beat after that — the file is read once the process has
        // exited. Without a second word the phone shows the reply and never
        // the buttons, which is the one place they were most wanted.
        tellPhones();
      })
      .catch(() => {});
  }

  // The words arriving is a different thing from the pause before them, and
  // the face said the same for both: a bot that had been writing for a minute
  // still looked like a bot staring into space.
  if (event.kind === "delta") {
    if (moods.get(event.botId) !== "write") setMood(event.botId, "write");
  }

  if (event.kind === "done") setMood(event.botId, "happy");
  else if (event.kind === "error") setMood(event.botId, "sad");

  // The two things that wait for you, said out loud if you are elsewhere.
  const whose = state.bots.find((b) => b.id === event.botId);
  const said = inflight.get(event.botId)?.message.text ?? "";
  // A turn taken in a muted room says nothing out loud. This is the half of
  // muting that matters: a mark you can ignore, a notification arrives whether
  // you were ready for it or not — and on a phone, in a pocket.
  const inMuted = (() => {
    const id = inflight.get(event.botId)?.channelId;
    const room = id ? channels().find((c) => c.id === id) : undefined;
    if (!room) return false;
    // Or in a thread of one: a side conversation out of a silenced room is
    // still that room talking.
    const parent = room.from && channels().find((c) => c.id === room.from?.channelId);
    return !!room.muted || !!parent?.muted;
  })();
  // Work that happened while you were not here. This is the one the phone was
  // asked for: a routine ran, a bot reported, and nobody was watching.
  const ran = fromRoutine.get(event.botId);
  if (ran && (event.kind === "done" || event.kind === "error" || event.kind === "cancelled")) {
    fromRoutine.delete(event.botId);
  }

  if (inMuted) {
    // Nothing said out loud. The mood and everything below still happen — the
    // room is quiet, not stopped.
  } else if (whose && event.kind === "done" && ran) {
    void nudge(`${whose.name} · ${ran}`, said);
    void nudgePhones(`${whose.name} · ${ran}`, said);
  } else if (whose && event.kind === "done" && mentionsYou(said)) {
    void nudge(`${whose.name} needs you`, said);
    void nudgePhones(`${whose.name} needs you`, said);
  } else if (whose && event.kind === "done" && said.includes("?")) {
    // A bot that finished by asking something is waiting on you as surely as
    // one that said your name, and most of them do not say your name. Both
    // nudges are already silent while this window has focus, so this is only
    // ever a question asked while you were somewhere else.
    void nudge(`${whose.name} asked you something`, theAsk(said));
    void nudgePhones(`${whose.name} asked you something`, theAsk(said));
  } else if (whose && event.kind === "error") {
    void nudge(`${whose.name} stopped`, event.text ?? "Something went wrong");
    void nudgePhones(`${whose.name} stopped`, event.text ?? "Something went wrong");
  }
  else if (event.kind === "thinking") setMood(event.botId, "think");
  else if (event.kind === "tool") setMood(event.botId, "work");
  else if (event.kind === "cancelled") setMood(event.botId, "dizzy");
  // A usage limit is not a failure, and a bot should not look like it failed:
  // it is being told to wait, which is a shrug.
  else if (event.kind === "rate-limit") setMood(event.botId, "shrug");

  if (event.kind === "rate-limit") {
    const info = event.detail;
    session.limit = info ?? null;
    if (info && info.status && info.status !== "allowed") {
      const at = info.resetsAt ? clock(info.resetsAt * 1000) : "later";
      toast(`Claude usage limit (${info.rateLimitType ?? "window"}) — resets ${at}`);
    }
    return;
  }

  if (event.kind === "done" || event.kind === "error" || event.kind === "cancelled") {
    finish(event.botId, event);
    return;
  }

  const pending = inflight.get(event.botId);
  if (!pending) return;
  const live = pending.channelId
    ? pending.channelId === state.activeChannel
    : event.botId === state.activeId && !state.activeChannel;

  if (event.kind === "tool") {
    const tool = (event.text ?? "a tool").replace(/^mcp__desktop__/, "");
    const desktopTool = tool !== event.text;

    if (tool === "start_desktop") {
      pending.note = "Starting its computer…";
      // The MCP server started a container behind our back; catch the panel up.
      if (event.botId === screen.botId) window.setTimeout(() => void openScreen(), 4000);
    } else {
      pending.note = desktopTool ? `On its computer — ${tool}…` : `Using ${tool}…`;
    }
    if (live && !pending.sawText) waitingHtml(pending.message.id, pending.note);
    return;
  }

  if (event.kind === "thinking") {
    pending.note = "Thinking…";
    if (live && !pending.sawText) waitingHtml(pending.message.id, pending.note);
    return;
  }

  // kind === "delta"
  pending.message.text += event.text ?? "";
  pending.sawText = true;
  // On a call, each sentence goes to the voice the moment it is whole. Before
  // the `live` check, because a call is worth speaking even if the thread it
  // belongs to is not the pane on screen.
  if (call?.botId === event.botId) speakAsItArrives(event.botId, pending.message.text);
  if (!live) return;

  // Watching it arrive counts as having read it, or the row you are looking at
  // grows a badge for the thing on your screen.
  markSeen();

  const body = bodyOf(pending.message.id);
  if (!body) return;
  body.innerHTML =
    `<div class="md">${markMentions(renderMd(pending.message.text), mentionable())}</div>`;
  body.querySelector(".md")?.lastElementChild?.classList.add("caret");
  if (nearBottom()) scrollToEnd();
}

function send(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  closeMentions();

  const room = activeChannel();
  if (room) {
    if (!claudeReady) {
      toast("Claude Code CLI not found — install it to talk to your bots");
      return;
    }
    postToChannel(room, clean);
    return;
  }

  const bot = activeBot();
  if (!bot || inflight.has(bot.id)) return;
  if (!claudeReady) {
    toast("Claude Code CLI not found — install it to talk to your bots");
    return;
  }

  const wasEmpty = bot.messages.length === 0;
  const msg: Message = { id: uid(), from: "me", text: clean, at: Date.now() };
  bot.messages.push(msg);

  if (wasEmpty) thread.innerHTML = "";
  thread.append(turnEl(msg, undefined, bot.messages[bot.messages.length - 2]));
  // Sending is a thing you did on purpose, so it always takes you to the end —
  // even if you were reading back through the conversation when you typed it.
  scrollToEnd(true);

  input.value = "";
  autoGrow();
  save();
  void respond(bot, clean);
}

function retry(msgId: string): void {
  const bot = activeBot();
  if (!bot || inflight.has(bot.id)) return;
  const idx = bot.messages.findIndex((m) => m.id === msgId);
  if (idx < 1) return;

  const prior = bot.messages[idx - 1];
  if (prior.from !== "me") return;
  bot.messages.splice(idx);
  renderThread();
  void respond(bot, `${prior.text}\n\n(Please answer again, differently.)`);
}

const cancelTurn = (botId: string) => void invoke("cancel", { botId }).catch(() => {});

/* ---------------------------------------------------------------- composer */

function autoGrow(): void {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
  syncSend();
}

/* ------------------------------------------------------------- menus, sheet */

function openMenu(anchor: HTMLElement | null, html: string, extraClass = ""): void {
  if (!anchor) throw new Error("botcage: openMenu called without an anchor");
  menu.className = `menu ${extraClass}`.trim();
  menu.innerHTML = html;
  menu.hidden = false;

  const a = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const top = a.bottom + 6 + box.height < window.innerHeight ? a.bottom + 6 : a.top - box.height - 6;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.min(Math.max(8, a.left), window.innerWidth - box.width - 8)}px`;
}

const closeMenu = () => {
  menu.hidden = true;
};

/** The face at the top of a bot's sheet, in the colour being chosen.
 *
 *  Drawn by the same renderer as every other face rather than by a hand-made
 *  copy of one. The copy had drifted until it was a coloured square with two
 *  stray marks in it — it was written before a face had brows, a mouth and a
 *  mark, and nothing made it keep up. Now there is only one way to draw a face
 *  and this asks for it.
 *
 *  Still, like every face outside the roster: a preview that blinks at you
 *  while you pick a colour is not showing you the colour. */
/** Somebody to start from.
 *
 *  A blank box asking for a "role and job description" is the hardest question
 *  this app asks, and it asks it before anything has happened: the difference
 *  between a bot that is useful and one that answers like a search engine is
 *  almost entirely what is written there, and nobody knows that on day one.
 *  These are the job descriptions I would write, offered as a starting point
 *  and editable to nothing.
 *
 *  Deliberately no routines and no connectors. A template that quietly put
 *  standing work on a schedule would be a template that starts spending your
 *  usage before you have met the bot — the calendar is a decision, and it stays
 *  one. What a hire comes with is words. */
const HIRES: { name: string; blurb: string; colour: string; shape: Shape; role: string }[] = [
  {
    name: "Engineer",
    blurb: "Writes and ships",
    colour: "#0a84ff",
    shape: "squircle",
    role:
      "You write and ship code. You own the build: when something is broken you say so plainly, " +
      "and when it is fixed you say what changed and why. Prefer the small diff to the clever one. " +
      "Run things rather than guessing at their output, and when you cannot run something, say that " +
      "instead of predicting what it would have printed.",
  },
  {
    name: "Researcher",
    blurb: "Finds out",
    colour: "#bf5af2",
    shape: "circle",
    role:
      "You find things out and report back. Go to sources rather than to memory, and say where each " +
      "claim came from. Keep what you found and what you think of it in separate paragraphs. Short " +
      "answers with the working underneath them, and when the answer is 'nobody knows', that is the " +
      "answer.",
  },
  {
    name: "Ops",
    blurb: "Keeps it running",
    colour: "#30d158",
    shape: "drop",
    role:
      "You keep things running. Watch what is up, report what changed, and raise problems with the " +
      "facts attached rather than with an alarm. Write down what you did as you do it, so the next " +
      "person — or the next you — does not start from nothing. A quiet day reported as a quiet day is " +
      "a useful report.",
  },
  {
    name: "Writer",
    blurb: "Turns work into words",
    colour: "#ff5a00",
    shape: "circle",
    role:
      "You turn work into words other people can read. Draft, then cut. Keep one voice across " +
      "everything you write here. Ask who the reader is when it is not obvious, because the same " +
      "facts go to a customer and to a colleague in two different shapes.",
  },
  {
    name: "Analyst",
    blurb: "Answers with numbers",
    colour: "#ffb020",
    shape: "squircle",
    role:
      "You answer questions with numbers. Say what the number is, how you arrived at it, and what " +
      "would change it. Never round a fact into a story: if the data does not support the question " +
      "as asked, say which question it does answer.",
  },
];

/** The strip of them, and what picking one does. */
function paintHires(hiring: boolean): void {
  const wrap = $<HTMLDivElement>("#sheet-hires");
  wrap.hidden = !hiring;
  if (!hiring) return;

  $<HTMLDivElement>("#sheet-hires-row").innerHTML = HIRES.map(
    (hire) =>
      `<button type="button" class="hire" data-hire="${escapeHtml(hire.name)}">` +
      faceHtml(
        {
          id: `hire:${hire.name}`,
          color: hire.colour,
          shape: hire.shape,
          face: { head: hire.shape },
        } as unknown as Bot,
        "sm",
      ) +
      `<span class="hire__name">${escapeHtml(hire.name)}</span>` +
      `<span class="hire__blurb">${escapeHtml(hire.blurb)}</span></button>`,
  ).join("");
}

/** The manner picker: what its id chose, then the rest by name.
 *
 *  The first entry is the default and says what it resolved to, so a bot that
 *  has never been touched still tells you how it writes rather than leaving
 *  "Its own" to mean anything. */
function paintSheetManners(bot: Bot | null): void {
  const picker = $<HTMLSelectElement>("#sheet-manner");
  const own = bot ? mannerOf({ ...bot, manner: undefined }) : null;
  picker.innerHTML =
    `<option value="">${own ? `${escapeHtml(own.name)} — chosen by its id` : "Chosen by its id"}</option>` +
    MANNERS.map(
      (m) => `<option value="${m.key}">${escapeHtml(m.name)}</option>`,
    ).join("");
  picker.value = bot?.manner ?? "";
}

/** The hours row: a switch, two times, and the days.
 *
 *  Days as seven toggles rather than a dropdown of "weekdays / every day /
 *  custom", because custom is what everybody picks in the end and a dropdown
 *  that leads to a second control is two controls with an extra step. */
function paintSheetHours(bot: Bot | null): void {
  const on = $<HTMLInputElement>("#sheet-hours-on");
  const when = $<HTMLDivElement>("#sheet-hours-when");
  const hours = bot?.hours;

  on.checked = !!hours;
  when.hidden = !hours;
  $<HTMLInputElement>("#sheet-hours-from").value = hours?.from ?? "09:00";
  $<HTMLInputElement>("#sheet-hours-to").value = hours?.to ?? "18:00";
  $<HTMLSpanElement>("#sheet-hours-says").textContent = bot
    ? `${saysHours(bot)}. Routines only — a message you send is always answered.`
    : "Routines only — a message you send is always answered.";

  const days = hours?.days ?? [1, 2, 3, 4, 5];
  // Monday first: a working week starts on Monday however Date#getDay counts.
  $<HTMLDivElement>("#sheet-hours-days").innerHTML = [1, 2, 3, 4, 5, 6, 0]
    .map(
      (day) =>
        `<button type="button" class="shift__day${days.includes(day) ? " is-on" : ""}" ` +
        `data-day="${day}">${DAY_NAME[day]}</button>`,
    )
    .join("");
}

/** What the hours row is currently saying, as a value to save. */
function hoursFromSheet(): Bot["hours"] {
  if (!$<HTMLInputElement>("#sheet-hours-on").checked) return undefined;
  const days = [...document.querySelectorAll<HTMLElement>(".shift__day.is-on")].map((el) =>
    Number(el.dataset.day),
  );
  return {
    from: tidyClock($<HTMLInputElement>("#sheet-hours-from").value),
    to: tidyClock($<HTMLInputElement>("#sheet-hours-to").value),
    // No days at all is not a shift, it is a bot that never works — which
    // nobody means by unticking the last one.
    days: days.length ? days : [1, 2, 3, 4, 5],
  };
}

/** Whatever was typed, as HH:MM. The phone's calendar learned this lesson
 *  first: a time saved as "9" never comes round. */
function tidyClock(typed: string): string {
  const digits = typed.replace(/\D/g, "").slice(0, 4);
  if (!digits) return "09:00";
  const hh = digits.length <= 2 ? Number(digits) : Number(digits.slice(0, digits.length - 2));
  const mm = digits.length <= 2 ? 0 : Number(digits.slice(-2));
  return `${pad2(Math.min(23, hh))}:${pad2(Math.min(59, mm))}`;
}

function renderSheetPreview(bot?: Bot | null): void {
  const shown: Bot = bot
    ? { ...bot, color: draftColor }
    : ({
        // A bot that does not exist yet has no id to derive a face from, so it
        // gets a plain one — the real face is settled the moment it is made.
        id: "",
        color: draftColor,
        shape: SHAPES[state.bots.length % SHAPES.length],
        face: { head: SHAPES[state.bots.length % SHAPES.length], eyes: "dot", brow: "none", smile: "soft", mark: "none" },
      } as unknown as Bot);
  sheetPreview.innerHTML = faceHtml(shown, "lg");
  swatches.innerHTML = COLORS.map(
    (c) =>
      `<button type="button" class="swatch${c === draftColor ? " is-on" : ""}" data-color="${c}" ` +
      `style="background:${c};color:${c}" aria-label="${c}"></button>`,
  ).join("");
}

/** One hour of the grid, in pixels. Must match .cal__slot and .cal__hour. */
const HOUR_PX = 44;

/** How much of an hour is kept clear of events, so the hour itself can still be
 *  clicked when something is already scheduled in it. */
const FREE_PX = 22;

/** Sunday first, as Date#getDay counts. */
const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The Monday of the week `when` falls in. Weeks start on Monday here because
 *  weekday routines are a working-week idea, and a grid that split Saturday
 *  from Sunday would cut the weekend in half. */
function weekStart(when: number): Date {
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

/** The nth day of the shown week. Built by date arithmetic rather than by
 *  adding milliseconds, so the clocks going back does not shift a column. */
function dayOfWeek(from: Date, index: number): Date {
  const day = new Date(from);
  day.setDate(day.getDate() + index);
  day.setHours(0, 0, 0, 0);
  return day;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (day: Date) =>
  `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;

/** Parse an ISO date back into a local midnight. `new Date("2026-08-26")` is
 *  parsed as UTC and lands on the day before in half the world. */
function fromIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Midnight on the day `when` falls in. */
function dayStart(when: number | Date): Date {
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** How much of the calendar is on screen at once.
 *
 *  A day and a week are the same hour grid with a different number of columns.
 *  A month is a different drawing — twenty-four hours a day across five weeks
 *  is four hundred rows of nothing, so a month shows what happens on each day
 *  rather than when in the day it happens. */
type CalSpan = "day" | "week" | "month";

let calSpan: CalSpan = "week";

/** The first day of what the calendar is showing.
 *
 *  Nothing bounds this in either direction: every number below comes out of
 *  date arithmetic on this one date, so a routine can be put on a Tuesday four
 *  years out the same way it is put on tomorrow. */
let calAt = weekStart(Date.now());

/** The first day of the range `when` falls in. */
function spanStart(when: number | Date, span: CalSpan): Date {
  if (span === "week") return weekStart(+new Date(when));
  const day = dayStart(when);
  if (span === "month") day.setDate(1);
  return day;
}

/** The days the grid draws.
 *
 *  A month is drawn as whole weeks — the greyed days either side that every
 *  month grid has — because a month that started mid-row would put Wednesday
 *  under the Monday heading. */
function spanDays(at: Date, span: CalSpan): Date[] {
  if (span === "day") return [at];
  if (span === "week") return Array.from({ length: 7 }, (_, n) => dayOfWeek(at, n));

  const first = weekStart(+at);
  const last = new Date(at.getFullYear(), at.getMonth() + 1, 0);
  // Rounded, not floored: a month containing a clock change is 23 or 25 hours
  // short of a whole number of days, and flooring loses the last row of it.
  const days = Math.round((+dayStart(last) - +first) / 86_400_000) + 1;
  return Array.from({ length: Math.ceil(days / 7) * 7 }, (_, n) => dayOfWeek(first, n));
}

/** The same range, one step earlier or later. Months step as months rather
 *  than as thirty days: a calendar that goes 31 January → 2 March is one
 *  nobody trusts again. */
function stepSpan(at: Date, span: CalSpan, by: number): Date {
  const next = new Date(at);
  if (span === "day") next.setDate(next.getDate() + by);
  else if (span === "week") next.setDate(next.getDate() + by * 7);
  else next.setMonth(next.getMonth() + by, 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** What the range is called, above the grid. The year appears once it is not
 *  this one — the calendar goes on forever, and "3–9 August" alone would not
 *  say which August you had scrolled to. */
function calRange(at: Date, span: CalSpan): string {
  const month = (day: Date) => day.toLocaleDateString(undefined, { month: "long" });
  if (span === "month") return `${month(at)} ${at.getFullYear()}`;

  const thisYear = new Date().getFullYear();
  const year = (day: Date) => (day.getFullYear() === thisYear ? "" : ` ${day.getFullYear()}`);
  if (span === "day") return `${DAY_FULL[at.getDay()]} ${at.getDate()} ${month(at)}${year(at)}`;

  // Named from the last day of the week rather than the first, so the week that
  // runs from December into January says which January.
  const last = dayOfWeek(at, 6);
  return at.getMonth() === last.getMonth()
    ? `${at.getDate()}\u2013${last.getDate()} ${month(at)}${year(last)}`
    : `${at.getDate()} ${month(at)} \u2013 ${last.getDate()} ${month(last)}${year(last)}`;
}

/** What Back and Forward do from here, said out loud for the button titles. */
const SPAN_STEP: Record<CalSpan, string> = { day: "day", week: "week", month: "month" };

/** Show a different amount, keeping the day you were looking at.
 *
 *  Today wins when it is inside what is on screen, which is the reading anyone
 *  makes of switching to Day while looking at this week. */
function setCalSpan(span: CalSpan): void {
  const today = dayStart(Date.now());
  const shown = spanDays(calAt, calSpan).map(isoDate);
  const keep = shown.includes(isoDate(today)) ? today : calAt;
  calSpan = span;
  calAt = spanStart(keep, span);
  state.app = { ...appSettings(), calSpan: span };
  save();
  renderRoutines();
  paintCalScroll();
}

/** Start where the day is rather than at midnight, with enough above it to see
 *  what has just been and gone. A month has no hours to scroll to. */
function paintCalScroll(): void {
  const body = $<HTMLDivElement>("#cal-body");
  body.scrollTop =
    calSpan === "month" ? 0 : Math.max(0, (new Date().getHours() - 2) * HOUR_PX);
}

/** Does this routine land on that day? False for the kinds that repeat faster
 *  than the grid can draw — those live in the band above it. */
function fallsOn(routine: Routine, day: Date): boolean {
  switch (routine.every) {
    case "day":
      return true;
    case "weekday":
      return WEEKDAY.includes(day.getDay());
    case "week":
      return day.getDay() === (routine.day ?? 1);
    case "once":
      return routine.date === isoDate(day);
    default:
      return false;
  }
}

function renderRoutines(): void {
  const drawn = calBots();
  if (!drawn.length) return;
  // One flat list, each item remembering whose it is — everything below this
  // draws a routine without caring whether one bot's calendar is on screen or
  // everybody's.
  const routines = drawn.flatMap((bot) => (bot.routines ?? []).map((routine) => ({ bot, routine })));
  const now = new Date();
  const today = isoDate(now);

  const month = calSpan === "month";
  const days = spanDays(calAt, calSpan);

  $<HTMLSpanElement>("#cal-range").textContent = calRange(calAt, calSpan);

  const step = SPAN_STEP[calSpan];
  for (const [id, way] of [["#cal-prev", "Previous"], ["#cal-next", "Next"]] as const) {
    const button = $<HTMLButtonElement>(id);
    button.title = `${way} ${step}`;
    button.setAttribute("aria-label", button.title);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(".cal__span")) {
    const on = button.dataset.span === calSpan;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  }

  const cal = $<HTMLDivElement>("#cal");
  cal.classList.toggle("cal--month", month);

  // The gutter is the hours' column, and a month has none. Set here rather than
  // in the stylesheet because the number of columns is data: one on a day,
  // seven on a week.
  $<HTMLDivElement>("#cal-days").style.gridTemplateColumns = month
    ? "repeat(7, 1fr)"
    : `52px repeat(${days.length}, 1fr)`;
  $<HTMLDivElement>("#cal-cols").style.gridTemplateColumns = `repeat(${month ? 7 : days.length}, 1fr)`;

  $<HTMLDivElement>("#cal-days").innerHTML = month
    ? // The weekday names only: the dates are in the cells, and printing them
      // twice would say the first week's dates over every other week's.
      days
        .slice(0, 7)
        .map((day) => `<div class="cal__day">${DAY_NAME[day.getDay()]}</div>`)
        .join("")
    : `<div class="cal__day"></div>` +
      days
        .map(
          (day) =>
            `<div class="cal__day${isoDate(day) === today ? " is-today" : ""}">` +
            `${DAY_NAME[day.getDay()]}<b>${day.getDate()}</b></div>`,
        )
        .join("");

  $<HTMLDivElement>("#cal-hours").innerHTML = Array.from(
    { length: 24 },
    // The midnight label would sit above the grid with nothing to name, so the
    // first hour is left blank rather than pushed off the top.
    (_, hour) => `<div class="cal__hour">${hour ? `${pad2(hour)}:00` : ""}</div>`,
  ).join("");

  // Anything faster than an hour would be a stripe through every column.
  const often = routines.filter(
    ({ routine }) => routine.every === "hour" || routine.every === "minutes",
  );
  const band = $<HTMLDivElement>("#cal-often");
  band.hidden = often.length === 0 && routines.length > 0;
  band.innerHTML = routines.length
    ? often
        .map(
          ({ bot, routine }) =>
            `<button type="button" class="cal__chip${routine.active ? "" : " is-off"}" ` +
            `data-edit="${routine.id}"><i style="--tint:${bot.color}"></i>` +
            (calEveryone ? faceHtml(bot, "xs") : "") +
            `<b>${escapeHtml(routine.name)}</b>` +
            `<span>${escapeHtml(describeRoutine(routine))}</span></button>`,
        )
        .join("")
    : `<div class="cal__empty">Nothing scheduled. ${
        calEveryone
          ? "Open a bot's own calendar to give it a standing instruction."
          : `Click any slot to give ${escapeHtml(drawn[0].name)} a standing instruction`
      } — routines run while botcage is open.</div>`;

  /** What this bot has to do on that day, earliest first. */
  const dueOn = (day: Date) =>
    routines
      .filter(({ routine }) => fallsOn(routine, day))
      .sort((one, two) => one.routine.at.localeCompare(two.routine.at));

  $<HTMLDivElement>("#cal-cols").innerHTML = days
    .map((day) =>
      month
        ? monthCell(day, dueOn(day), today)
        : hourColumn(day, dueOn(day), now, today, drawn.length === 1 ? drawn[0] : undefined),
    )
    .join("");
}

/** One day as hours: the grid a day and a week are both made of. */
function hourColumn(
  day: Date,
  due: { bot: Bot; routine: Routine }[],
  now: Date,
  today: string,
  /** Whose hours to draw, when the calendar is one bot's. On everybody's it is
   *  nobody's: five shifts laid over each other is a grid with no clear hours
   *  at all, which is worse than not saying. */
  shift?: Bot,
): string {
  const iso = isoDate(day);
  const slots = Array.from({ length: 24 }, (_, hour) => {
    // The hour is off if the bot is off for the whole of it. Judged on the
    // half hour rather than the start: a shift that ends at 09:30 leaves half
    // an hour of work in the nine o'clock slot, and greying it would be a lie
    // about a routine that will run.
    const off =
      shift?.hours &&
      !onTheClock(shift, new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0)) &&
      !onTheClock(shift, new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 30));
    return `<div class="cal__slot${off ? " is-off" : ""}" data-day="${iso}" data-hour="${hour}"></div>`;
  }).join("");

  // Two routines in the same hour would sit exactly on top of each other, and
  // the one underneath would be a routine nobody could see was there. They
  // share the width of the hour instead.
  //
  // And they never take all of it: an event that filled its hour would be the
  // only thing there to click, so that hour could never be given a second
  // routine — clicking it would open the first one, and saving would edit it
  // rather than add to it. The strip down the right stays empty and clickable,
  // which is what makes an hour able to hold two.
  const crowd = new Map<number, number>();
  for (const { routine } of due) {
    const hour = Number(routine.at.split(":")[0]) || 0;
    crowd.set(hour, (crowd.get(hour) ?? 0) + 1);
  }
  const placed = new Map<number, number>();

  const events = due
    .map(({ bot, routine }) => {
      const [hh, mm] = routine.at.split(":").map(Number);
      const hour = hh || 0;
      const of = crowd.get(hour) ?? 1;
      const lane = placed.get(hour) ?? 0;
      placed.set(hour, lane + 1);
      const top = (hour + (mm || 0) / 60) * HOUR_PX;
      // Stacked within the hour rather than side by side. A calendar splits the
      // width when two things overlap because both last an hour; a routine is a
      // moment, not a span, so splitting only makes two unreadable slivers
      // where the names should be.
      const slice = (HOUR_PX - 6) / of;
      const solo = of === 1;
      return (
        `<button type="button" class="cal__event${solo ? "" : " cal__event--tight"}` +
        `${routine.active ? "" : " is-off"}" data-edit="${routine.id}" ` +
        `style="top:${top + lane * slice}px;height:${slice - (solo ? 0 : 2)}px;` +
        `right:${FREE_PX}px;--tint:${bot.color}">` +
        // On everybody's calendar, whose it is comes first: the same face as in
        // the sidebar, on a block already in that bot's colour.
        (calEveryone ? faceHtml(bot, "xs") : "") +
        `<b>${escapeHtml(routine.name)}</b>` +
        // Who put it there beats when it runs: the hour is already legible from
        // where the block sits, and a tile this narrow fits one line.
        (solo ? `<span>${routine.by ? `by ${escapeHtml(routine.by)}` : routine.at}</span>` : "") +
        `</button>`
      );
    })
    .join("");

  const isToday = iso === today;
  const line = isToday
    ? `<div class="cal__now" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>`
    : "";

  return `<div class="cal__col${isToday ? " is-today" : ""}">${slots}${events}${line}</div>`;
}

/** How many routines a month's cell shows before it gives up and counts. */
const CELL_FITS = 3;

/** One day as a square: what happens, not when in the day it happens. */
function monthCell(day: Date, due: { bot: Bot; routine: Routine }[], today: string): string {
  const iso = isoDate(day);
  // The days either side of the month, greyed. Drawing them at full strength
  // makes a month look like it starts on the 28th of the one before.
  const outside = day.getMonth() !== calAt.getMonth();

  const pips = due
    .slice(0, CELL_FITS)
    .map(
      ({ bot, routine }) =>
        `<button type="button" class="cal__pip${routine.active ? "" : " is-off"}" ` +
        `data-edit="${routine.id}" style="--tint:${bot.color}" ` +
        `title="${escapeHtml(routine.name)} — ${routine.at}">` +
        `<i></i><b>${escapeHtml(routine.name)}</b><span>${routine.at}</span></button>`,
    )
    .join("");

  // Not a tooltip listing the rest: it opens that day, which is the view that
  // can actually show them.
  const more =
    due.length > CELL_FITS
      ? `<button type="button" class="cal__more" data-open="${iso}">` +
        `${due.length - CELL_FITS} more</button>`
      : "";

  return (
    `<div class="cal__cell${outside ? " is-outside" : ""}${iso === today ? " is-today" : ""}" ` +
    `data-day="${iso}">` +
    `<span class="cal__date">${day.getDate()}</span>${pips}${more}</div>`
  );
}

/** Which voice this bot speaks in, and every other one it could have.
 *
 *  The one its id chose is first and marked as such, because that is what it
 *  already sounds like and the list is otherwise fifty names with nothing to
 *  choose between them. */
async function paintSheetVoices(bot: Bot | null): Promise<void> {
  const row = $<HTMLLabelElement>("#sheet-voice-row");
  const picker = $<HTMLSelectElement>("#sheet-voice");
  const all = await knownVoices();

  // Nothing installed that can speak. Offering an empty list would be a
  // setting that looks broken rather than one that is not applicable.
  row.hidden = !all.length;
  if (!all.length) return;

  const given = bot ? voiceNames[seedOf(bot.id) % voiceNames.length] : all[0];
  picker.innerHTML =
    `<option value="">${escapeHtml(given)} — chosen by its id</option>` +
    all
      .filter((v) => v !== given)
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("");
  // A pinned voice that happens to be the one its id chose still reads as the
  // default, because that is what it is — the pin only stops it moving.
  picker.value = bot?.voice && bot.voice !== given && all.includes(bot.voice) ? bot.voice : "";
}

$<HTMLButtonElement>("#sheet-voice-try").addEventListener("click", () => {
  const picker = $<HTMLSelectElement>("#sheet-voice");
  const chosen = picker.value || picker.options[0]?.textContent?.split(" — ")[0] || "";
  const name = sheetName.value.trim() || "your new bot";
  void invoke("speak", {
    text: `Hello. I am ${name}, and this is how I sound.`,
    voice: chosen,
  }).catch(() => {});
});

/** What could answer for this bot, and what is stopping the rest.
 *
 *  An engine that is missing is still listed, greyed, with the reason on it: a
 *  choice that quietly disappears is harder to understand than one that says
 *  "not installed". And a bot keeps the engine it was given even when that
 *  engine has since gone missing — silently moving a bot to something else
 *  would change what answers for it without asking. */
function paintSheetEngines(bot: Bot | null): void {
  const list: EngineInfo[] = engineChoices.length
    ? engineChoices
    : [
        // The list could not be fetched. Offering nothing would make the sheet
        // unusable, and Claude Code is what every bot used before this existed.
        {
          key: DEFAULT_ENGINE,
          name: "Claude Code",
          ready: { usable: true, missing: null },
          ownsTranscript: true,
          tools: "native",
          searchable: false,
          models: [
            { key: "opus", name: "Opus", hint: "The most capable, and the hungriest." },
            { key: "sonnet", name: "Sonnet", hint: "Easier on your usage limits." },
          ],
        },
      ];

  const options = list.map((info) => {
    const option = document.createElement("option");
    option.value = info.key;
    // The name alone. What is wrong with an engine goes in the hint below,
    // where there is room for a sentence — a select is only as wide as its
    // widest option, and "not installed — npm install …" is a paragraph.
    option.textContent = info.name;
    option.disabled = !info.ready.usable;
    return option;
  });

  // A bot pointed at something this build has never heard of: name it rather
  // than showing the wrong engine as selected.
  const known = bot?.engine ? list.some((info) => info.key === bot.engine) : true;
  if (bot?.engine && !known) {
    const option = document.createElement("option");
    option.value = bot.engine;
    option.textContent = `${bot.engine} — unknown to this version`;
    option.disabled = true;
    options.push(option);
  }

  sheetEngine.replaceChildren(...options);
  // An existing bot keeps its own; a new one starts from what setup arranged.
  sheetEngine.value =
    bot?.engine ??
    appSettings().engine ??
    list.find((info) => info.ready.usable)?.key ??
    DEFAULT_ENGINE;
  paintSheetModels(bot?.model ?? appSettings().model);
}

/** The models the chosen engine can be asked for.
 *
 *  Repainted whenever the engine changes, because "opus" means nothing to
 *  Gemini: a bot that kept its old model would ask for one that does not exist
 *  and fail on its next message. The model is kept when the new engine also
 *  has it, and otherwise becomes that engine's first. */
function paintSheetModels(want?: string): void {
  const chosen = engineChoices.find((info) => info.key === sheetEngine.value);

  // Six thousand models do not fit in a select, so that engine gets a button
  // onto the catalogue instead — the same row, a different way of answering it.
  const open = $<HTMLButtonElement>("#sheet-model-open");
  const searchable = chosen?.searchable ?? false;
  open.hidden = !searchable;
  sheetModel.hidden = searchable;
  if (searchable) {
    // A model picked for another engine means nothing here. "opus" is not
    // something models.dev or Ollama can be asked for, and it arrived without
    // a provider to ask — so it is dropped rather than displayed, and the
    // button goes back to asking. Without this the sheet offers "opus · From
    // undefined", the save guard sees a model and lets it through, and the bot
    // fails on its first message instead of in the sheet where it was made.
    //
    // A model that does have a provider was chosen from the catalogue, so it
    // survives switching engines and back.
    if (!draftModel.provider) draftModel.model = "";
    open.textContent = draftModel.model || "Choose a model…";
    paintSheetHints();
    return;
  }

  const models = chosen?.models.length
    ? chosen.models
    : [
        { key: "opus", name: "Opus", hint: "The most capable, and the hungriest." },
        { key: "sonnet", name: "Sonnet", hint: "Easier on your usage limits." },
      ];

  sheetModel.replaceChildren(
    ...models.map((model) => {
      const option = document.createElement("option");
      option.value = model.key;
      option.textContent = model.name;
      return option;
    }),
  );
  sheetModel.value = models.some((model) => model.key === want) ? want! : models[0].key;
  paintSheetHints();
}

/** The sentence under each picker. The engine's says who keeps the
 *  conversation, because that is the one difference a person can feel: a bot
 *  whose engine cannot resume one is remembered by botcage instead. */
function paintSheetHints(): void {
  const chosen = engineChoices.find((info) => info.key === sheetEngine.value);
  // Two things worth saying, in the order they matter: what picking this one
  // means, and why the others are greyed out.
  const lines: string[] = [];
  if (chosen?.searchable) {
    // What it is, rather than how it remembers: someone choosing this is
    // choosing reach, and the transcript is botcage's problem either way.
    lines.push("Any model on models.dev, and Ollama on this machine.");
  } else if (chosen) {
    lines.push(
      chosen.ownsTranscript
        ? `${chosen.name} keeps this bot's conversation itself.`
        : `${chosen.name} can't resume a conversation, so botcage keeps the thread.`,
    );
  }
  for (const info of engineChoices) {
    // A colon, not a dash: the reason may itself contain one ("not installed —
    // npm install …"), and two dashes in a sentence read as a mistake.
    if (!info.ready.usable) lines.push(`${info.name}: ${info.ready.missing ?? "not available"}`);
  }
  $<HTMLSpanElement>("#sheet-engine-hint").textContent =
    lines.join(" ") || "Which installed tool runs this bot's turns.";

  if (chosen?.searchable) {
    // The provider's name, not the id it is keyed by: "From ollama" is a
    // database row, "From Ollama · this machine" is an answer.
    const from = providerList.find((p) => p.id === draftModel.provider);
    if (draftModel.provider && !from && !providerList.length) {
      // Nobody has opened the chooser yet this session, so the names have not
      // been fetched. Get them, then say it properly.
      void invoke<ProviderInfo[]>("catalogue_providers")
        .then((all) => {
          providerList = all;
          paintSheetHints();
        })
        .catch(() => {});
    }
    $<HTMLSpanElement>("#sheet-model-hint").textContent = draftModel.model
      ? `From ${from?.name ?? draftModel.provider}.`
      : "Anything on models.dev, or Ollama on this machine — click to search.";
    return;
  }

  const model = chosen?.models.find((entry) => entry.key === sheetModel.value);
  $<HTMLSpanElement>("#sheet-model-hint").textContent =
    model?.hint ?? "Sonnet is easier on your usage limits.";
}

sheetEngine.addEventListener("change", () => paintSheetModels(sheetModel.value));
sheetModel.addEventListener("change", paintSheetHints);

/* ------------------------------------------------------- the model chooser */

const modelsWrap = $<HTMLDivElement>("#models-wrap");
const modelsSearch = $<HTMLInputElement>("#models-search");
const modelsTools = $<HTMLInputElement>("#models-tools");
const modelsList = $<HTMLDivElement>("#models-list");
const modelsNote = $<HTMLParagraphElement>("#models-note");
const modelsKey = $<HTMLDivElement>("#models-key");
const modelsKeyInput = $<HTMLInputElement>("#models-key-input");

/** What the chooser is currently showing, so a click can find its listing
 *  without another round trip. */
let shown: Listing[] = [];
/** The model this sheet would save. Held apart from the bot because the sheet
 *  applies on Save like everything else in it, and because a bot being created
 *  does not exist yet to hold anything. */
let draftModel: { provider?: string; model: string } = { model: "" };
/** The provider whose key is being asked for, and the model that will be
 *  chosen the moment it is given. */
let pending: Listing | null = null;
let providerList: ProviderInfo[] = [];

/** Search is typed, and 6,000 models is a lot to re-rank on every keystroke. */
let searchTimer = 0;
/** Which provider's models are being shown. Null means every provider, which
 *  is what a search across all of them wants. */
let onlyProvider: string | null = null;

function money(dollars: number | null): string {
  if (dollars === null) return "";
  if (dollars === 0) return "free";
  return dollars >= 1 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(2).replace(/^0/, "")}`;
}

function facts(model: Listing): string {
  const bits: string[] = [];
  if (model.context) bits.push(`${Math.round(model.context / 1000)}k`);
  // "free/M in" is not a price. Something that costs nothing is just free.
  if (model.costIn === 0) bits.push("free");
  else if (model.costIn !== null) bits.push(`${money(model.costIn)}/M in`);
  if (model.tools) bits.push("tools");
  return bits.join(" · ");
}

/** The left column: whose models these are.
 *
 *  Ordered by what you can use — the one on this machine, then the ones botcage
 *  holds a key for, then the rest by how much they offer. A green dot means it
 *  will answer right now; a dim one means it needs a key first. */
function paintProviders(): void {
  const list = $<HTMLDivElement>("#models-providers");
  const all = document.createElement("button");
  all.type = "button";
  all.className = `provider-row${onlyProvider === null ? " is-on" : ""}`;
  all.dataset.provider = "";
  all.innerHTML =
    `<span class="provider-row__dot" data-ready="true"></span>` +
    `<span class="provider-row__name">Everything</span>` +
    `<span class="provider-row__count"></span>`;
  all.querySelector(".provider-row__count")!.textContent = String(
    providerList.reduce((sum, p) => sum + p.models, 0) || "",
  );

  list.replaceChildren(
    all,
    ...providerList.map((provider) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `provider-row${onlyProvider === provider.id ? " is-on" : ""}`;
      row.dataset.provider = provider.id;
      row.innerHTML =
        `<span class="provider-row__dot" data-ready="${provider.hasKey}"></span>` +
        `<span class="provider-row__name"></span>` +
        `<span class="provider-row__count"></span>`;
      row.querySelector(".provider-row__name")!.textContent = provider.name;
      row.querySelector(".provider-row__count")!.textContent = provider.local
        ? "free"
        : provider.models
          ? String(provider.models)
          : "";
      return row;
    }),
  );
}

async function paintModels(): Promise<void> {
  const query = modelsSearch.value.trim();
  // Typing searches everywhere: nobody who types "sonnet" means "sonnet, but
  // only from the provider I happened to have selected".
  if (query) onlyProvider = null;
  paintProviders();

  const from = providerList.find((p) => p.id === onlyProvider);
  $<HTMLDivElement>("#models-heading").textContent = query
    ? `Matching “${query}”`
    : from
      ? from.name
      : "Every model";

  shown = await invoke<Listing[]>("catalogue_search", {
    query,
    toolsOnly: modelsTools.checked,
    provider: onlyProvider,
    limit: 60,
  }).catch(() => []);

  if (!shown.length) {
    const state = await invoke<{ models: number }>("catalogue_state").catch(() => ({ models: 0 }));
    modelsList.innerHTML = !state.models
      ? `<p class="models__note">The catalogue hasn't been fetched yet.</p>`
      : from?.local
        ? `<p class="models__note">Ollama isn't running, or has no models pulled. ` +
          `<code>ollama pull llama3</code> gives this bot something to answer with, for nothing.</p>`
        : `<p class="models__note">Nothing matches “${escapeHtml(query)}”.</p>`;
    if (!state.models) void fetchCatalogue();
    return;
  }

  modelsList.replaceChildren(
    ...shown.map((model, at) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-row";
      row.dataset.at = String(at);
      if (draftModel.provider === model.provider && draftModel.model === model.id) {
        row.classList.add("is-on");
      }
      row.innerHTML =
        `<span class="model-row__name"></span>` +
        `<span class="model-row__by"></span>` +
        `<span class="model-row__facts"></span>` +
        (model.ready ? "" : `<span class="model-row__locked">needs a key</span>`);
      row.querySelector(".model-row__name")!.textContent = model.name;
      // Whose model it is, unless that is the question already answered by the
      // column on the left — a provider's name on every one of its own rows is
      // just the heading, repeated.
      row.querySelector(".model-row__by")!.textContent = onlyProvider ? "" : model.providerName;
      row.querySelector(".model-row__facts")!.textContent = facts(model);
      return row;
    }),
  );
}

async function fetchCatalogue(): Promise<void> {
  modelsNote.textContent = "Fetching the catalogue from models.dev…";
  try {
    const count = await invoke<number>("catalogue_refresh");
    modelsNote.textContent = `${count.toLocaleString()} models.`;
    await paintModels();
  } catch (err) {
    modelsNote.textContent = String(err);
  }
}

/** Ask for the key this provider needs, naming it the way its own
 *  documentation does — the string someone will recognise from the page they
 *  copied it from. */
function askForKey(model: Listing): void {
  pending = model;
  const provider = providerList.find((p) => p.id === model.provider);
  $<HTMLSpanElement>("#models-key-head").textContent = provider?.env[0] ?? "API key";
  modelsKeyInput.value = "";
  modelsKey.hidden = false;
  $<HTMLButtonElement>("#models-key-forget").hidden = !provider?.hasKey;
  modelsNote.textContent = provider?.doc
    ? `${model.providerName} issues keys at ${provider.doc} — botcage keeps it in your keychain.`
    : "botcage keeps the key in your keychain, and hands it to nothing but this provider.";
  modelsKeyInput.focus();
}

/** What to do with the model that gets picked. The bot sheet is one caller;
 *  setup is another, and it is choosing a default rather than editing a bot. */
let onPick: (model: Listing) => void = (model) => {
  draftModel = { provider: model.provider, model: model.id };
  paintSheetModels(model.id);
};

function chooseModel(model: Listing): void {
  modelsWrap.hidden = true;
  onPick(model);
}

async function openModels(pick?: (model: Listing) => void): Promise<void> {
  onPick =
    pick ??
    ((model) => {
      draftModel = { provider: model.provider, model: model.id };
      paintSheetModels(model.id);
    });
  pending = null;
  modelsKey.hidden = true;
  modelsWrap.hidden = false;
  modelsSearch.value = "";
  providerList = await invoke<ProviderInfo[]>("catalogue_providers").catch(() => []);

  // Open where this bot already is, or on something that will answer without a
  // key. Landing on six thousand strangers is not a starting point.
  onlyProvider =
    draftModel.provider ??
    providerList.find((p) => p.local)?.id ??
    providerList.find((p) => p.hasKey)?.id ??
    null;

  const usable = providerList.filter((p) => p.hasKey).length;
  modelsNote.textContent =
    `${providerList.length} providers, ${usable} you can use now. ` +
    `Pick one on the left, or search every model at once.`;

  await paintModels();
  modelsSearch.focus();
}

modelsSearch.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void paintModels(), 140);
});
modelsTools.addEventListener("change", () => void paintModels());
$<HTMLButtonElement>("#models-close").addEventListener("click", () => {
  modelsWrap.hidden = true;
});
modelsWrap.addEventListener("mousedown", (e) => {
  if (e.target === modelsWrap) modelsWrap.hidden = true;
});
$<HTMLFormElement>("#models-sheet").addEventListener("submit", (e) => e.preventDefault());

$<HTMLDivElement>("#models-providers").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-provider]");
  if (!row) return;
  onlyProvider = row.dataset.provider || null;
  // A provider chosen is a narrowing, and a search term is a widening: keeping
  // both would show one provider's matches while looking like all of them.
  modelsSearch.value = "";
  void paintModels();
});

modelsList.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-at]");
  if (!row) return;
  const model = shown[Number(row.dataset.at)];
  if (!model) return;
  if (model.ready) chooseModel(model);
  else askForKey(model);
});

$<HTMLButtonElement>("#models-key-save").addEventListener("click", () => {
  if (!pending) return;
  const key = modelsKeyInput.value.trim();
  const model = pending;
  invoke("provider_key_set", { provider: model.provider, key })
    .then(async () => {
      modelsKey.hidden = true;
      providerList = await invoke<ProviderInfo[]>("catalogue_providers").catch(() => []);
      chooseModel(model);
      toast(`Key saved for ${model.providerName}`);
    })
    .catch((err) => {
      modelsNote.textContent = String(err);
    });
});

$<HTMLButtonElement>("#models-key-forget").addEventListener("click", () => {
  if (!pending) return;
  const gone = pending;
  void invoke("provider_key_clear", { provider: gone.provider }).then(async () => {
    modelsKey.hidden = true;
    pending = null;
    providerList = await invoke<ProviderInfo[]>("catalogue_providers").catch(() => []);
    await paintModels();
    toast(`Forgot the key for ${gone.providerName}`);
  });
});

$<HTMLButtonElement>("#sheet-model-open").addEventListener("click", () => void openModels());

$<HTMLDivElement>("#setup-picks").addEventListener("change", (e) => {
  const chosen = (e.target as HTMLInputElement).value;
  if (chosen !== "claude-code" && chosen !== "ollama" && chosen !== "hosted") return;
  setupRoute = chosen;
  // A model picked for one route means nothing to another.
  setupPick = null;
  paintSetup();
});


function openSheet(bot: Bot | null = null): void {
  editing = bot;
  draftColor = bot?.color ?? COLORS[state.bots.length % COLORS.length];
  sheetTitle.textContent = bot ? `${bot.name} settings` : "New bot";
  sheetSubmit.textContent = bot ? "Save" : "Create bot";
  sheetName.value = bot?.name ?? "";
  sheetRole.value = bot?.role ?? "";
  // A bot that does not exist yet has learned nothing, and the box would only
  // invite somebody to write its memory for it.
  sheetMemoryRow.hidden = !bot;
  sheetMemory.value = "";
  memoryWas = "";
  if (bot) {
    void invoke<string>("read_memory", { botId: bot.id })
      .then((text) => {
        // Only if the sheet is still showing the bot this was asked for: two
        // quick opens would otherwise land one bot's memory in another's box.
        if (editing?.id !== bot.id) return;
        memoryWas = text;
        sheetMemory.value = text;
      })
      .catch(() => {});
  }
  // Hidden rather than shown empty: a bot that has declared none has nothing
  // to say here, and a heading over an empty box teaches you to skip it.
  // Nothing to hand over until there is something to hand over.
  $<HTMLButtonElement>("#sheet-share").hidden = !bot;
  sheetCommandsRow.hidden = !bot?.commands?.length;
  sheetCommands.innerHTML = (bot?.commands ?? [])
    .map(
      (one) =>
        `<div class="cmd"><code>/${escapeHtml(one.name)}</code>` +
        `<span>${escapeHtml(one.what)}</span></div>`,
    )
    .join("");
  sheetComputer.checked = bot?.computer ?? false;
  sheetNetwork.value = bot?.network ?? "full";
  draftModel = {
    provider: bot?.provider ?? (bot ? undefined : appSettings().provider),
    model: bot?.model ?? (appSettings().engine ? appSettings().model : ""),
  };
  paintSheetManners(bot);
  paintSheetHours(bot);
  paintSheetEngines(bot);
  void paintSheetVoices(bot);
  sheetBrowser.value = bot?.machine?.browser ?? "";
  sheetRendering.value = bot?.machine?.rendering ?? "";
  // Say what "Automatic" resolved to, or the tab reads as though nothing is set
  // while the machine is in fact distinct.
  const resolved = machineProfile(bot);
  $<HTMLParagraphElement>("#sheet-machine-note").textContent =
    `Automatic here means ${resolved.browser} at ${resolved.screen}, ${resolved.cores} cores, ` +
    `${resolved.fonts} fonts, ${resolved.rendering} text — derived from this bot's id, so no two ` +
    `bots get the same machine.`;
  sheetScreen.value = bot?.machine?.screen ?? "";
  sheetCores.value = bot?.machine?.cores ? String(bot.machine.cores) : "";
  sheetWindow.value = bot?.machine?.window ?? "";
  sheetFonts.value = bot?.machine?.fonts ?? "";
  sheetLanguage.value = bot?.machine?.language ?? "";
  paintHires(!bot);
  renderSheetPreview(bot);
  // Only an existing bot can be deleted, and the confirm never carries over
  // from a previous visit to this sheet.
  sheetDelete.hidden = !bot;
  disarmDelete();
  showSheetTab("general");
  showSheet(true);
  sheetName.focus();
}

/* ------------------------------------------------------------- marketplace */

const pluginsWrap = $<HTMLDivElement>("#plugins");
const pluginsBody = $<HTMLDivElement>("#plugins-body");
const pluginsSearch = $<HTMLInputElement>("#plugins-search");
let catalog: CatalogEntry[] = [];
let marketTab: "all" | "installed" = "all";
let catalogVerified = false;

/** One fetch per plugin, so it happens once in the background — started at
 *  launch so the first browse is already filtered rather than filtering itself
 *  while being read. */
function verifyCatalogue(): void {
  if (catalogVerified) return;
  catalogVerified = true;
  void invoke("verify_catalogue")
    .then(async () => {
      catalog = await invoke<CatalogEntry[]>("plugin_catalog").catch(() => catalog);
      if (!pluginsWrap.hidden) renderCatalog();
    })
    .catch(() => {});
}

/** A mark for a service or plugin. The remote avatar sits on top of a generated
 *  one, so a failed or offline fetch simply reveals the fallback instead of
 *  leaving a broken image. */
function iconMark(name: string, url: string): string {
  const hue = Array.from(name).reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  const initial = escapeHtml((name.trim()[0] ?? "?").toUpperCase());
  const image = url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" />` : "";
  return (
    `<span class="mark" style="background:hsl(${hue} 42% 34%)">` +
    `<span class="mark__initial">${initial}</span>${image}</span>`
  );
}

/** Words the catalogue's slugs spell out that read wrong title-cased. */
const ACRONYMS = new Set([
  "ai", "api", "aws", "cli", "cd", "ci", "cms", "crm", "css", "db", "dns", "gcp",
  "gpu", "html", "http", "id", "ide", "io", "ios", "k8s", "llm", "mcp", "ml",
  "os", "qa", "sdk", "seo", "sql", "ssh", "ui", "ux", "vpc", "yaml",
]);

/** The catalogue ships slugs like "aws-sdk-dev", not display names. */
function pluginTitle(name: string): string {
  return name
    .split(/[-_]/)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** Services botcage connects itself, with the credential we hold for each. */
function connectedSection(query: string): string {
  const services = connectors.filter(
    (service) => !query || service.name.toLowerCase().includes(query),
  );
  if (!services.length) return "";

  return (
    `<div class="market__group"><div class="market__head">` +
    `<p class="section-title">Services</p></div><div class="market__grid">` +
    services.map(connectorCard).join("") +
    `</div></div>`
  );
}

function connectorCard(service: Connector): string {
  // Connecting and granting used to be two acts on one card, so a service could
  // read "Connected" while the bot had nothing. Now there is one control: on for
  // this bot, or not. The credential behind it is shared between bots and
  // survives a bot turning the service off.
  const on = pluginsBot?.plugins?.includes(service.key) ?? false;
  const keyed = service.tokenOptional && service.connected;
  const needsAuth =
    service.needsToken || service.needsGoogle || service.needsDevice || service.needsOauth;

  const status = on
    ? service.ownAccount
      ? "Connected with its own account"
      : keyed
        ? "Connected — add a key for higher limits"
        : "Connected"
    : service.connected && needsAuth
      ? "Already signed in"
      : service.description;

  // Exactly one button per card: whether this bot uses the service. Anything to
  // do with the account behind it is a quiet link, because two buttons of equal
  // weight made the card ask two questions at once.
  const action = on
    ? `<button type="button" class="chip chip--quiet" data-disconnect="${service.key}"><span>Disconnect</span></button>`
    : `<button type="button" class="chip" data-connect="${service.key}"><span>Connect</span></button>`;

  const accountLinks = [
    // Adding a key to a service that already works is an upgrade, not a fix.
    keyed
      ? `<a class="pcard__link" href="#" data-connect="${service.key}" data-key="1">Add a key</a>`
      : "",
    // GitHub is where a separate identity earns its keep: a machine account can
    // be scoped to a few repos instead of everything the user owns.
    service.needsDevice && service.connected && !service.ownAccount && pluginsBot
      ? `<a class="pcard__link" href="#" data-own="${service.key}">Use a different account</a>`
      : "",
    service.connected && needsAuth
      ? `<a class="pcard__link" href="#" data-forget="${service.key}" ` +
        `title="${service.ownAccount ? "Removes this bot's own account" : "Removes the saved sign-in for every bot"}">` +
        `Sign out</a>`
      : "",
  ].filter(Boolean);

  return (
    `<div class="pcard" data-connector="${service.key}">${iconMark(service.name, service.icon)}` +
    `<button type="button" class="pcard__open" data-open-service="${service.key}">` +
    `<span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<span class="pcard__desc">${escapeHtml(status)}</span>` +
    `</button>` +
    (accountLinks.length ? `<span class="pcard__links">${accountLinks.join("")}</span>` : "") +
    `${action}</div>`
  );
}

interface Component {
  name: string;
  description: string;
}

interface PluginDetail {
  skills: Component[];
  commands: Component[];
  agents: Component[];
  servers: { name: string; key: string }[];
  secrets: { var: string; set: boolean }[];
  installPath: string;
}

interface ScopeChoice {
  scope: string;
  label: string;
  note: string;
  onByDefault: boolean;
}

/** Ask what the bot should be allowed to reach before asking GitHub for a code:
 *  the approval screen shows exactly these, so choosing after would be too late. */
function chooseScopes(card: HTMLElement, service: Connector): void {
  card.innerHTML =
    `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<span class="pcard__desc">Loading…</span></span>`;

  void invoke<ScopeChoice[]>("github_scopes")
    .then((choices) => {
      card.innerHTML =
        `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
        `<span class="pcard__desc">Choose what bots may reach. You can disconnect and ` +
        `reconnect with different access at any time.</span>` +
        `<span class="scopes">` +
        choices
          .map(
            (choice) =>
              `<label class="scope"><input type="checkbox" data-scope="${escapeHtml(choice.scope)}"` +
              `${choice.onByDefault ? " checked" : ""} />` +
              `<span><span class="scope__label">${escapeHtml(choice.label)}</span>` +
              `<span class="scope__note">${escapeHtml(choice.note)}</span></span></label>`,
          )
          .join("") +
        `</span></span>` +
        `<button type="button" class="chip" data-device="${service.key}"><span>Continue</span></button>`;
    })
    .catch((err) => {
      renderCatalog();
      toast(String(err));
    });
}

/** The point of this one: the server registers botcage on request, so there is
 *  nothing to set up. Press Connect, approve in the browser, done. */
function startOAuth(card: HTMLElement, service: Connector): void {
  card.innerHTML =
    `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<span class="pcard__desc">Opening ${escapeHtml(service.name)} to sign in…</span></span>`;

  const bot = pluginsBot?.id ?? null;
  void invoke<string>("mcp_oauth_start", { key: service.key, bot })
    .then(async (url) => {
      // Listen before the browser can redirect back.
      const finished = invoke("mcp_oauth_finish", { key: service.key, bot });
      const line = card.querySelector(".pcard__desc");
      if (line) line.textContent = "Waiting for you to approve it in the browser…";
      await openUrl(url);
      await finished;
      await turnOn(service.key);
      await loadConnectors(pluginsBot);
      await resyncDesktops();
      renderCatalog();
      toast(`Connected ${service.name}`);
    })
    .catch((err) => {
      renderCatalog();
      toast(String(err));
    });
}

/** Device flow: GitHub gives a short code, the user approves it in a browser,
 *  and we poll until it lands. No redirect and no client secret involved. */
function startDeviceFlow(card: HTMLElement, service: Connector, scopes: string[]): void {
  card.innerHTML =
    `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<span class="pcard__desc">Asking ${escapeHtml(service.name)} for a code…</span></span>`;

  void invoke<{ userCode: string; verificationUri: string; deviceCode: string; interval: number }>(
    "github_device_start",
    { scopes },
  )
    .then(async (device) => {
      card.innerHTML =
        `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
        `<span class="pcard__desc">Enter this code on ${escapeHtml(service.name)}, then come back. ` +
        `Waiting…</span>` +
        `<code class="pcard__code pcard__code--code">${escapeHtml(device.userCode)}</code>` +
        `<a class="pcard__help" href="#" data-help="${escapeHtml(device.verificationUri)}">Open ${escapeHtml(
          service.name,
        )}</a></span>`;
      await openUrl(device.verificationUri);
      await invoke("github_device_finish", {
        deviceCode: device.deviceCode,
        interval: device.interval,
        // Present only when connecting an account for this bot alone.
        bot: service.connected ? (pluginsBot?.id ?? null) : null,
      });
      await turnOn(service.key);
      await loadConnectors(pluginsBot);
      await resyncDesktops();
      renderCatalog();
      toast(`Connected ${service.name}`);
    })
    .catch((err) => {
      renderCatalog();
      toast(String(err));
    });
}

/** Google will not register an OAuth client for us, so the user makes one and
 *  botcage walks them through consent. Everything they must paste into the
 *  Google console is shown here rather than left to the docs. */
function askForGoogle(card: HTMLElement, service: Connector): void {
  card.innerHTML =
    `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<span class="pcard__desc">Create an OAuth client in Google Cloud, add this redirect URI and these ` +
    `scopes, then paste the client's ID and secret.</span>` +
    `<code class="pcard__code">${escapeHtml(service.redirectUri)}</code>` +
    `<code class="pcard__code">${escapeHtml(service.scopes.join("\n"))}</code>` +
    `<input class="token-input" spellcheck="false" placeholder="Client ID" data-gid="${service.key}" />` +
    `<input class="token-input" type="password" spellcheck="false" placeholder="Client secret" data-gsecret="${service.key}" />` +
    `<a class="pcard__help" href="#" data-help="${escapeHtml(service.helpUrl)}">Open the Google console</a>` +
    `</span><button type="button" class="chip" data-google="${service.key}"><span>Sign in</span></button>`;
  card.querySelector<HTMLInputElement>("[data-gid]")?.focus();
}

/** Swap a card into a credential prompt, rather than opening another dialog. */
function askForToken(card: HTMLElement, service: Connector): void {
  card.innerHTML =
    `<span class="pcard__body"><span class="pcard__name">${escapeHtml(service.name)}</span>` +
    `<input class="token-input" type="password" spellcheck="false" ` +
    `placeholder="${escapeHtml(service.tokenLabel)}" data-token="${service.key}" />` +
    `<a class="pcard__help" href="#" data-help="${escapeHtml(service.helpUrl)}">Where do I get this?</a>` +
    `</span><button type="button" class="chip" data-save-token="${service.key}"><span>Save</span></button>`;
  card.querySelector<HTMLInputElement>(".token-input")?.focus();
}

function renderCatalog(): void {
  const query = pluginsSearch.value.trim().toLowerCase();
  const shown = catalog.filter((entry) => {
    if (marketTab === "installed") {
      // Everything installed stays listed, working or not — otherwise a plugin
      // that turned out to be unusable could never be removed.
      if (!entry.installed) return false;
    } else if (entry.usable === false) {
      // Not browsable at all: it cannot run on this machine. Unverified entries
      // stay, since we have no grounds to drop what we have not checked.
      return false;
    }
    if (!query) return true;
    return (entry.name + " " + entry.description).toLowerCase().includes(query);
  });

  if (!shown.length) {
    const connected = connectedSection(query);
    if (connected) {
      pluginsBody.innerHTML = connected;
      return;
    }
    pluginsBody.innerHTML = `<p class="market__empty">${
      marketTab === "installed" && !query
        ? "Nothing installed yet. Add something from the Marketplace."
        : "No plugins match that."
    }</p>`;
    return;
  }

  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of shown) {
    const group = groups.get(entry.category) ?? [];
    group.push(entry);
    groups.set(entry.category, group);
  }

  pluginsBody.innerHTML = connectedSection(query) + Array.from(groups.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([category, entries]) =>
        `<div class="market__group"><p class="section-title">${escapeHtml(pluginTitle(category))}</p>` +
        `<div class="market__grid">` +
        entries
          .map(
            (entry) =>
              `<div class="pcard">${iconMark(entry.name, entry.icon)}` +
              `<button type="button" class="pcard__open" data-open="${escapeHtml(entry.id)}">` +
              `<span class="pcard__name">${escapeHtml(pluginTitle(entry.name))}</span>` +
              `<span class="pcard__desc">${escapeHtml(entry.description)}</span></button>` +
              (entry.installed
                ? (entry.usable === false ? `<span class="pcard__added">${escapeHtml(entry.note)}</span>` : "") +
                  `<button type="button" class="chip" data-remove-plugin="${escapeHtml(entry.id)}"><span>Remove</span></button>`
                : `<button type="button" class="chip" data-add-plugin="${escapeHtml(entry.id)}"><span>Add</span></button>`) +
              `</div>`,
          )
          .join("") +
        `</div></div>`,
    )
    .join("");
}

/** Signing in is only worth anything if the bot then has it, so every path that
 *  obtains a credential ends here. This is what "Connect" means to the user. */
async function turnOn(key: string): Promise<void> {
  if (!pluginsBot) return;
  const held = new Set(pluginsBot.plugins ?? []);
  held.add(key);
  pluginsBot.plugins = Array.from(held);
  save();
  if (pluginsBot.computer) {
    await invoke("sandbox_sync_tools", {
      botId: pluginsBot.id,
      github: held.has("github"),
    }).catch(() => {});
  }
}

async function turnOff(key: string): Promise<void> {
  if (!pluginsBot) return;
  pluginsBot.plugins = (pluginsBot.plugins ?? []).filter((k) => k !== key);
  save();
  if (pluginsBot.computer) {
    await invoke("sandbox_sync_tools", {
      botId: pluginsBot.id,
      github: (pluginsBot.plugins ?? []).includes("github"),
    }).catch(() => {});
  }
}

/** A connect, reconnect or disconnect changes the credential behind a service.
 *  Any desktop already running stays signed in with the previous one — which the
 *  provider may by then have revoked — so push the change to all of them.
 *
 *  GitHub is the sharp case: an OAuth app holds one token per user, so signing
 *  in again anywhere invalidates the token every other desktop is holding. */
async function resyncDesktops(): Promise<void> {
  await Promise.all(
    state.bots
      .filter((bot) => bot.computer)
      .map((bot) =>
        invoke("sandbox_sync_tools", {
          botId: bot.id,
          github: (bot.plugins ?? []).includes("github"),
        }).catch(() => {}),
      ),
  );
}

/** Which bot this modal is granting to. Plugins are per bot: the same service
 *  can be on for one and off for another, with its own account if it needs one. */
let pluginsBot: Bot | null = null;

/** What a plugin actually contributes, which the catalogue cannot say. Without
 *  it a skills-only plugin installs to no visible effect: it brings no MCP
 *  server, so nothing appears in the bot's connections. */
/** The same panel for a service. Connectors are what a bot actually reaches
 *  through, so leaving them unopenable meant the things people use most had no
 *  way to show what they are or who else uses them. */
function showConnectorDetail(service: Connector): void {
  const on = pluginsBot?.plugins?.includes(service.key) ?? false;
  const host = service.key;
  const holders = state.bots.filter((bot) => bot.plugins?.includes(service.key));

  const how = service.needsOauth
    ? "Signs in through your browser. botcage registers itself with the service, so there is nothing to set up."
    : service.needsDevice
      ? "Signs in with a short code you approve in your browser. No password or secret is stored by botcage."
      : service.needsGoogle
        ? "Signs in through Google, using an OAuth client you create once."
        : service.needsToken || service.tokenOptional
          ? `Uses ${service.tokenLabel || "a key"} you paste. It is kept in your system keychain.`
          : "Needs no sign-in.";

  const rows = [
    `<div class="comp"><span class="comp__main"><span class="comp__name">This bot</span>` +
      `<span class="comp__desc">${on ? "Connected" : "Not connected"}</span></span>` +
      `<span class="comp__kind">${on ? "On" : "Off"}</span></div>`,
    `<div class="comp"><span class="comp__main"><span class="comp__name">Sign-in</span>` +
      `<span class="comp__desc">${escapeHtml(how)}</span></span>` +
      `<span class="comp__kind">${service.connected ? "Done" : "Needed"}</span></div>`,
    holders.length
      ? `<div class="comp"><span class="comp__main"><span class="comp__name">Used by</span>` +
        `<span class="comp__desc">${escapeHtml(holders.map((b) => b.name).join(", "))}</span></span>` +
        `<span class="comp__kind">${holders.length} bot${holders.length === 1 ? "" : "s"}</span></div>`
      : "",
    service.scopes.length
      ? `<div class="comp"><span class="comp__main"><span class="comp__name">Access</span>` +
        `<span class="comp__desc">${escapeHtml(service.scopes.join("\n"))}</span></span>` +
        `<span class="comp__kind">${service.scopes.length} scopes</span></div>`
      : "",
  ].filter(Boolean);

  const action = on
    ? `<button type="button" class="chip chip--quiet" data-disconnect="${service.key}"><span>Disconnect</span></button>`
    : `<button type="button" class="chip" data-connect="${service.key}"><span>Connect</span></button>`;

  pluginsBody.innerHTML =
    `<div class="detail">` +
    `<button type="button" class="detail__back" data-back="1">← Plugins</button>` +
    `<div class="detail__head">${iconMark(service.name, service.icon)}` +
    `<span class="detail__id"><span class="detail__name">${escapeHtml(service.name)}</span>` +
    `<span class="detail__source">${escapeHtml(host)}</span></span>${action}</div>` +
    `<p class="detail__desc">${escapeHtml(service.description)}</p>` +
    `<details class="group" open><summary class="group__head">Details</summary>${rows.join("")}</details>` +
    (service.connected && (service.needsToken || service.needsGoogle || service.needsDevice || service.needsOauth)
      ? `<button type="button" class="chip chip--quiet" data-forget="${service.key}"><span>Sign out</span></button>`
      : "") +
    `</div>`;
}

function showPluginDetail(entry: CatalogEntry): void {
  const link = entry.sourceUrl || entry.homepage;
  const action = entry.installed
    ? `<button type="button" class="chip chip--quiet" data-remove-plugin="${escapeHtml(entry.id)}"><span>Remove</span></button>`
    : `<button type="button" class="chip" data-add-plugin="${escapeHtml(entry.id)}"><span>Add</span></button>`;

  // Identity, provenance and the one action on a single line, so everything
  // below is only ever about what the plugin contains.
  const head =
    `<button type="button" class="detail__back" data-back="1">← Plugins</button>` +
    `<div class="detail__head">${iconMark(entry.name, entry.icon)}` +
    `<span class="detail__id"><span class="detail__name">${escapeHtml(pluginTitle(entry.name))}</span>` +
    (link
      ? `<a class="detail__source" href="#" data-help="${escapeHtml(link)}">View source ↗</a>`
      : `<span class="detail__source">${escapeHtml(entry.author || entry.marketplace)}</span>`) +
    `</span>${action}</div>` +
    `<p class="detail__desc">${escapeHtml(entry.description)}</p>`;

  if (!entry.installed) {
    pluginsBody.innerHTML =
      `<div class="detail">${head}` +
      `<p class="market__empty">Add it to see the skills and connections it brings.</p></div>`;
    return;
  }

  pluginsBody.innerHTML = `<div class="detail">${head}<p class="market__empty">Reading…</p></div>`;
  void invoke<PluginDetail>("plugin_detail", { id: entry.id })
    .then((detail) => {
      // <details> rather than scripted folding: it counts, collapses and is
      // keyboard-navigable with no state of ours to get wrong.
      const group = (label: string, rows: string[]) =>
        rows.length
          ? `<details class="group" open><summary class="group__head">` +
            `${rows.length} ${rows.length === 1 ? label : label + "s"}</summary>` +
            rows.join("") +
            `</details>`
          : "";

      const componentRows = (items: Component[], kind: string) =>
        items.map(
          (item) =>
            `<div class="comp"><span class="comp__main">` +
            `<span class="comp__name">${escapeHtml(item.name)}</span>` +
            (item.description ? `<span class="comp__desc">${escapeHtml(item.description)}</span>` : "") +
            `</span><span class="comp__kind">${kind}</span></div>`,
        );

      const serverRows = detail.servers.map(
        (server) =>
          `<div class="comp"><span class="comp__main">` +
          `<span class="comp__name">${escapeHtml(server.name)}</span>` +
          `<span class="comp__desc">Connect it to this bot from the Services list.</span>` +
          `</span><span class="comp__kind">Connector</span></div>`,
      );

      const secretRows = detail.secrets.map(
        (secret) =>
          `<div class="comp"><span class="comp__main">` +
          `<span class="comp__name">${escapeHtml(secret.var)}</span>` +
          `<span class="comp__desc">${secret.set ? "Saved" : "Needed before this plugin can authenticate."}</span>` +
          `<input class="token-input" type="password" spellcheck="false" ` +
          `placeholder="${secret.set ? "Saved — type to replace" : "Paste the value"}" ` +
          `data-secret="${escapeHtml(secret.var)}" />` +
          `</span><button type="button" class="chip" data-save-secret="${escapeHtml(secret.var)}" ` +
          `data-plugin-id="${escapeHtml(entry.id)}"><span>Save</span></button></div>`,
      );

      const body =
        group("skill", componentRows(detail.skills, "Skill")) +
        group("command", componentRows(detail.commands, "Command")) +
        group("agent", componentRows(detail.agents, "Agent")) +
        group("connector", serverRows) +
        group("credential", secretRows);

      pluginsBody.innerHTML =
        `<div class="detail">${head}` +
        (body || `<p class="market__empty">This plugin ships no skills or connections.</p>`) +
        `</div>`;
    })
    .catch((err) => toast(String(err)));
}

async function openPlugins(): Promise<void> {
  pluginsBot = activeBot();
  $<HTMLHeadingElement>("#plugins-title").textContent = pluginsBot
    ? `${pluginsBot.name} · plugins`
    : "Plugins";
  pluginsWrap.hidden = false;
  pluginsSearch.value = "";
  pluginsBody.innerHTML = `<p class="market__empty">Loading…</p>`;
  void Promise.all([loadConnectors(pluginsBot), loadPlugins()]).then(() => renderCatalog());

  verifyCatalogue();
  try {
    catalog = await invoke<CatalogEntry[]>("plugin_catalog");
  } catch (err) {
    catalog = [];
    pluginsBody.innerHTML = `<p class="market__empty">${escapeHtml(String(err))}</p>`;
    return;
  }
  renderCatalog();
}

pluginsSearch.addEventListener("input", renderCatalog);

for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs--market .tab"))) {
  tab.addEventListener("click", () => {
    marketTab = tab.dataset.market === "installed" ? "installed" : "all";
    for (const other of document.querySelectorAll<HTMLButtonElement>(".tabs--market .tab")) {
      other.setAttribute("aria-selected", String(other === tab));
    }
    renderCatalog();
  });
}

$<HTMLButtonElement>("#plugins-close").addEventListener("click", () => {
  pluginsWrap.hidden = true;
});

pluginsWrap.addEventListener("mousedown", (event) => {
  if (event.target === pluginsWrap) pluginsWrap.hidden = true;
});

pluginsBody.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const add = target.closest<HTMLButtonElement>("[data-add-plugin]");
  const remove = target.closest<HTMLButtonElement>("[data-remove-plugin]");
  const forget = target.closest<HTMLElement>("[data-forget]");
  if (forget) {
    event.preventDefault();
    void invoke("disconnect_connector", { key: forget.dataset.forget, bot: pluginsBot?.id ?? null })
      .then(async () => {
        await loadConnectors(pluginsBot);
        await resyncDesktops();
        renderCatalog();
        toast("Signed out");
      })
      .catch((err) => toast(String(err)));
    return;
  }

  const own = target.closest<HTMLAnchorElement>("[data-own]");
  if (own) {
    event.preventDefault();
    const service = connectors.find((c) => c.key === own.dataset.own);
    const card = own.closest<HTMLElement>(".pcard");
    if (service && card) chooseScopes(card, service);
    return;
  }

  if (target.closest("[data-back]")) {
    renderCatalog();
    return;
  }

  const openService = target.closest<HTMLButtonElement>("[data-open-service]");
  if (openService) {
    const service = connectors.find((c) => c.key === openService.dataset.openService);
    if (service) showConnectorDetail(service);
    return;
  }

  const open = target.closest<HTMLButtonElement>("[data-open]");
  if (open) {
    const entry = catalog.find((c) => c.id === open.dataset.open);
    if (entry) showPluginDetail(entry);
    return;
  }

  const saveSecret = target.closest<HTMLButtonElement>("[data-save-secret]");
  if (saveSecret) {
    const id = saveSecret.dataset.pluginId!;
    const name = saveSecret.dataset.saveSecret!;
    const field = pluginsBody.querySelector<HTMLInputElement>(`[data-secret="${name}"]`);
    saveSecret.disabled = true;
    void invoke("set_plugin_secret", { id, var: name, value: field?.value ?? "" })
      .then(() => {
        const entry = catalog.find((c) => c.id === id);
        if (entry) showPluginDetail(entry);
        toast("Saved");
      })
      .catch((err) => {
        saveSecret.disabled = false;
        toast(String(err));
      });
    return;
  }

  const help = target.closest<HTMLAnchorElement>("[data-help]");
  if (help) {
    event.preventDefault();
    void openUrl(help.dataset.help!);
    return;
  }

  const connect = target.closest<HTMLElement>("[data-connect]");
  if (connect) {
    // "Add a key" reuses the credential prompt rather than the connect flow.
    if (connect.dataset.key) {
      event.preventDefault();
      const service = connectors.find((c) => c.key === connect.dataset.connect);
      const card = connect.closest<HTMLElement>(".pcard");
      if (service && card) askForToken(card, service);
      return;
    }
    const service = connectors.find((c) => c.key === connect.dataset.connect);
    const card = connect.closest<HTMLElement>(".pcard");
    if (!service || !card) return;

    // Nothing to sign into: either it needs no credential, or one is already
    // stored from another bot. Turning it on is the whole action.
    if (service.connected) {
      void turnOn(service.key).then(renderCatalog);
      return;
    }

    if (service.needsOauth) startOAuth(card, service);
    else if (service.needsDevice) chooseScopes(card, service);
    else if (service.needsGoogle) askForGoogle(card, service);
    else askForToken(card, service);
    return;
  }

  const device = target.closest<HTMLButtonElement>("[data-device]");
  if (device) {
    const service = connectors.find((c) => c.key === device.dataset.device);
    const card = device.closest<HTMLElement>(".pcard");
    if (!service || !card) return;
    const scopes = Array.from(card.querySelectorAll<HTMLInputElement>("[data-scope]"))
      .filter((box) => box.checked)
      .map((box) => box.dataset.scope!);
    startDeviceFlow(card, service, scopes);
    return;
  }

  const google = target.closest<HTMLButtonElement>("[data-google]");
  if (google) {
    const key = google.dataset.google!;
    const clientId = pluginsBody.querySelector<HTMLInputElement>(`[data-gid="${key}"]`)?.value ?? "";
    const secret = pluginsBody.querySelector<HTMLInputElement>(`[data-gsecret="${key}"]`)?.value ?? "";
    google.disabled = true;
    google.innerHTML = `<span>Waiting for Google…</span>`;

    void invoke<string>("google_consent_url", { key, clientId })
      .then(async (url) => {
        // Start listening before the browser can redirect back.
        const finished = invoke("google_finish", { key, clientId, clientSecret: secret });
        await openUrl(url);
        await finished;
        await turnOn(key);
        await loadConnectors(pluginsBot);
        await resyncDesktops();
        renderCatalog();
        toast("Connected");
      })
      .catch((err) => {
        google.disabled = false;
        google.innerHTML = `<span>Sign in</span>`;
        toast(String(err));
      });
    return;
  }

  const saveToken = target.closest<HTMLButtonElement>("[data-save-token]");
  if (saveToken) {
    const key = saveToken.dataset.saveToken!;
    const input = pluginsBody.querySelector<HTMLInputElement>(`[data-token="${key}"]`);
    saveToken.disabled = true;
    void invoke("connect_connector", { key, token: input?.value ?? "", bot: null })
      .then(async () => {
        await turnOn(key);
        await loadConnectors(pluginsBot);
        await resyncDesktops();
        renderCatalog();
        toast("Connected");
      })
      .catch((err) => {
        saveToken.disabled = false;
        toast(String(err));
      });
    return;
  }

  const disconnect = target.closest<HTMLButtonElement>("[data-disconnect]");
  if (disconnect) {
    // Off for this bot only. The credential stays for whatever else uses it —
    // Forget is the way to remove that.
    void turnOff(disconnect.dataset.disconnect!).then(renderCatalog);
    return;
  }

  const button = add ?? remove;
  if (!button) return;

  const id = (add?.dataset.addPlugin ?? remove?.dataset.removePlugin)!;
  const command = add ? "install_plugin" : "uninstall_plugin";
  button.disabled = true;
  button.innerHTML = `<span>${add ? "Adding…" : "Removing…"}</span>`;

  void invoke(command, { id })
    .then(async () => {
      // A plugin brings MCP servers with it, so the per-bot list is now stale.
      plugins = [];
      catalog = await invoke<CatalogEntry[]>("plugin_catalog").catch(() => catalog);
      renderCatalog();
      toast(add ? `Added ${pluginTitle(id.split("@")[0])}` : "Removed");
    })
    .catch((err) => {
      button.disabled = false;
      button.innerHTML = `<span>${add ? "Add" : "Remove"}</span>`;
      toast(String(err));
    });
});

/** What a machine can vary by — all real settings, not claims to be something
 *  else. The order must stay stable: a bot's machine is derived from its id, so
 *  reordering would silently change an existing bot's fingerprint. */
const MACHINE_CHOICES = {
  browser: ["chromium", "firefox"],
  rendering: ["slight", "full", "none", "subpix"],
  screen: ["1280x800", "1440x900", "1512x982", "1680x1050", "1920x1080"],
  window: ["1100x740", "1280x800", "1400x860", "1600x980"],
  fonts: ["full", "core", "wide", "liberation", "noto"],
  cores: ["2", "4", "6", "8"],
} as const;

/** Stable per bot and per field, so ten bots get ten different machines with
 *  nobody configuring them, and each keeps the same one for life. */
function derived(botId: string, field: keyof typeof MACHINE_CHOICES): string {
  const options = MACHINE_CHOICES[field];
  let hash = 2166136261;
  for (const ch of `${botId}:${field}`) {
    hash = ((hash ^ ch.charCodeAt(0)) * 16777619) >>> 0;
  }
  return options[hash % options.length];
}

/** What this bot's machine resolves to: its own choices where it has them, its
 *  derived defaults elsewhere. */
function machineProfile(bot: Bot | null | undefined): Record<string, string> {
  const id = bot?.id ?? "unassigned";
  const chosen = (bot?.machine ?? {}) as Record<string, unknown>;
  const pick = (field: keyof typeof MACHINE_CHOICES) => {
    const value = chosen[field];
    return value === undefined || value === "" ? derived(id, field) : String(value);
  };
  return {
    browser: pick("browser"),
    rendering: pick("rendering"),
    screen: pick("screen"),
    window: pick("window"),
    fonts: pick("fonts"),
    cores: pick("cores"),
  };
}

/** The machine half of a brand: the bot's own choices, or the app defaults.
 *  Locale doubles as the browser language, so a per-bot language overrides it —
 *  timezone deliberately does not, since it should agree with the IP. */
function machineBrand(bot: Bot | null | undefined): Record<string, unknown> {
  const machine = machineProfile(bot);
  return {
    browser: machine.browser,
    rendering: machine.rendering,
    screen: machine.screen,
    window: machine.window,
    fonts: machine.fonts,
    cores: Number(machine.cores),
    // Language follows the host unless chosen: a browser announcing French from
    // a London address is a stronger signal than the one it removes.
    locale: bot?.machine?.language || navigator.language || "",
  };
}

/** What this machine offers. Discovered once, then reused. */
let plugins: Plugin[] = [];
let connectors: Connector[] = [];

async function loadConnectors(bot?: Bot | null): Promise<Connector[]> {
  try {
    connectors = await invoke<Connector[]>("connectors", { bot: bot?.id ?? null });
  } catch {
    connectors = [];
  }
  return connectors;
}

/** Held as a promise, not a result: "none" is a real answer worth remembering,
 *  and reopening mid-flight should join the run in progress rather than start
 *  a second one. */
let pluginsPromise: Promise<Plugin[]> | null = null;

function loadPlugins(force = false): Promise<Plugin[]> {
  if (pluginsPromise && !force) return pluginsPromise;
  pluginsPromise = invoke<Plugin[]>("list_plugins")
    // A missing CLI or a cold login is not worth an error in the user's face;
    // the section simply says there is nothing connected.
    .catch(() => [] as Plugin[])
    .then((found) => {
      plugins = found;
      return found;
    });
  return pluginsPromise;
}

function disarmDelete(): void {
  sheetDelete.classList.remove("is-armed");
  sheetDelete.textContent = "Delete bot";
}

sheetDelete.addEventListener("click", () => {
  if (!editing) return;

  if (!sheetDelete.classList.contains("is-armed")) {
    sheetDelete.classList.add("is-armed");
    sheetDelete.textContent = "Delete permanently — its files and desktop too";
    return;
  }

  const { id, name } = editing;
  showSheet(false);
  editing = null;
  disarmDelete();
  deleteBot(id);
  toast(`Deleted ${name}`);
});

/** What this sheet would save as the model, and whether it is answerable.
 *
 *  An engine with a catalogue has no select to read, and a bot on one with
 *  nothing chosen cannot be asked anything — so that is caught here rather than
 *  on the first message. */
function modelFromSheet(): { provider?: string; model: string } | null {
  const chosen = engineChoices.find((info) => info.key === sheetEngine.value);
  if (!chosen?.searchable) return { model: sheetModel.value };
  if (!draftModel.model) {
    toast("Choose a model for this bot");
    void openModels();
    return null;
  }
  return draftModel;
}

function saveSheet(): void {
  const name = sheetName.value.trim();
  if (!name) {
    sheetName.focus();
    return;
  }
  const picked = modelFromSheet();
  if (!picked) return;

  if (editing) {
    // Only when it was actually edited. A bot writes to this file during its
    // own turns, and saving unchanged text over the top would throw away
    // whatever it learned while the sheet sat open.
    if (sheetMemory.value !== memoryWas) {
      const text = sheetMemory.value;
      memoryWas = text;
      void invoke("write_memory", { botId: editing.id, text }).catch(() => {});
    }
    const before = { computer: editing.computer, network: editing.network };
    const swapped = (editing.engine ?? DEFAULT_ENGINE) !== sheetEngine.value;
    Object.assign(editing, {
      name,
      role: sheetRole.value.trim(),
      color: draftColor,
      computer: sheetComputer.checked,
      network: sheetNetwork.value as Bot["network"],
      engine: sheetEngine.value,
      provider: picked.provider,
      model: picked.model,
      // Empty means the one its id chose, which is not the same as no voice:
      // storing the resolved name would freeze it against a better one being
      // installed later.
      voice: $<HTMLSelectElement>("#sheet-voice").value || undefined,
      // Empty means the one its id chose, for the same reason as the voice.
      manner: $<HTMLSelectElement>("#sheet-manner").value || undefined,
      hours: hoursFromSheet(),
      machine: machineFromSheet(),
    });

    // A session id belongs to the engine that made it, so a bot that changed
    // engines starts a fresh one. The conversation is not lost with it: botcage
    // keeps its own transcript of every bot, and hands it to whatever answers
    // next — which is the whole reason it keeps one.
    if (swapped) {
      if (inflight.has(editing.id)) cancelTurn(editing.id);
      editing.sessionId = newSessionId();
      editing.started = false;
    }
    showSheet(false);
    editing = null;
    save();
    renderRoster();
    renderThread();
    if (screen.botId === state.activeId) void openScreen();

    // Network is baked into the container at creation, and a revoked computer
    // should actually stop running.
    if (swapped) {
      const named = engineChoices.find((info) => info.key === sheetEngine.value);
      toast(`${name} is answered by ${named?.name ?? sheetEngine.value} from now on`);
    }

    if (before.network !== sheetNetwork.value || (before.computer && !sheetComputer.checked)) {
      toast(
        sheetComputer.checked
          ? "Setting applies next time the desktop starts — stop it to take effect now"
          : "Computer access revoked",
      );
    }
    return;
  }

  createBot();
}

function createBot(): void {
  const name = sheetName.value.trim();
  const picked = modelFromSheet();
  if (!picked) return;
  const bot: Bot = {
    id: uid(),
    name,
    role: sheetRole.value.trim(),
    color: draftColor,
    shape: SHAPES[state.bots.length % SHAPES.length],
    sessionId: newSessionId(),
    started: false,
    computer: sheetComputer.checked,
    network: sheetNetwork.value as Bot["network"],
    engine: sheetEngine.value || DEFAULT_ENGINE,
    provider: picked.provider,
    model: picked.model || appSettings().model,
    machine: machineFromSheet(),
    plugins: [],
    routines: [],
    messages: [],
  };
  pinFace(bot);
  state.bots.unshift(bot);
  state.activeId = bot.id;
  showSheet(false);
  save();
  renderRoster();
  renderThread();
  input.focus();
}

function deleteBot(id: string): void {
  if (inflight.has(id)) cancelTurn(id);
  if (screen.botId === id) closeScreen();
  // Drop the transcript, the workspace, and the desktop along with the bot.
  void invoke("forget_bot", { botId: id }).catch(() => {});
  void invoke("sandbox_destroy", { botId: id }).catch(() => {});
  state.bots = state.bots.filter((b) => b.id !== id);
  if (state.activeId === id) state.activeId = state.bots[0]?.id ?? null;
  save();
  renderRoster();
  renderThread();
}

/** Wipe a guide's conversation — the messages, the session its engine resumes,
 *  and the transcript botcage keeps for engines that cannot.
 *
 *  The guide is a tutorial, not a correspondent. Coming back to it should show
 *  the five things it can teach, not the tail of a chat about cowboy hats —
 *  and a fresh page is only fresh if the model has also forgotten, or the
 *  first thing it does is pick up where you left off. */
function freshenGuide(bot: Bot): void {
  if (!bot.guide || inflight.has(bot.id) || !bot.messages.length) return;
  bot.messages = [];
  bot.sessionId = newSessionId();
  bot.started = false;
  void invoke("clear_thread", { botId: bot.id }).catch(() => {});
}

function openBot(id: string): void {
  const opening = state.bots.find((bot) => bot.id === id);
  if (opening) freshenGuide(opening);
  // The desk is a list of places to be rather than a place to be, and picking
  // somebody is going to one of them. Without this, choosing a bot from the
  // sidebar changed the name at the top and left the desk underneath it,
  // which reads as the click having done nothing.
  if (deskOpen) showDesk(false);
  // The shared calendar belongs to nobody, so picking somebody leaves it.
  if (calEveryone) {
    calEveryone = false;
    showRoutines(false);
  }
  state.activeChannel = null;
  paintTopbarFor(opening ?? null);
  state.activeId = id;
  setMood(id, "wave");
  save();
  renderRoster();
  if (routinesOpen) renderRoutines();
  else renderThread();
  // The pane always shows the bot you're talking to.
  if (!screenPane.hidden && screen.botId !== id) void openScreen();
  input.focus();
}


/* ---------------------------------------------------------------- channels */
/* A channel is several bots and you in one room. The pieces are: who is in it,
   who a message is addressed to, what a bot missed while it was not speaking,
   and how far a conversation between bots may run before it stops. Everything
   else — streaming, faces, bubbles, the stop button — is the machinery a chat
   already had, which is why a room reuses `Message` rather than inventing a
   parallel kind of thing to say. */

/** How many bot-to-bot summons one message from you may set off.
 *
 *  Bots that can summon each other can summon each other forever, and the
 *  failure mode is not a crash: it is two bots being polite at each other
 *  overnight and a bill in the morning.
 *
 *  One pot for the whole message, not one per chain. Depth alone is not a
 *  bound: naming two bots in a sentence started two chains of three, and the
 *  first one to speak spent a turn saying "I'll let X take this" — which is
 *  five turns for one question and reads as the bots enjoying themselves.
 *  Whoever *you* named always answers; this only limits what they set off. */
const HOPS = 3;

/** What is left of that pot, for one message. */
interface Budget {
  left: number;
}

/** Rooms where you have pressed stop, until you say something again.
 *
 *  Cancelling the bot that is mid-sentence is only half of it: the one it was
 *  about to bring in has not started yet, and would start the moment the
 *  cancelled turn settled. A stop button that stops one voice and lets the
 *  room carry on is worse than no stop button. */
const hushed = new Set<string>();

const channels = (): Channel[] => (state.channels ??= []);
/** Rooms, without the threads hanging off them. */
const rooms = (): Channel[] => channels().filter((c) => !c.from);
/** The threads of one room, oldest first. */
const threadsOf = (ch: Channel): Channel[] =>
  channels().filter((c) => c.from?.channelId === ch.id);
const activeChannel = (): Channel | null =>
  channels().find((c) => c.id === state.activeChannel) ?? null;
const membersOf = (ch: Channel): Bot[] =>
  ch.members.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b));

/** The seat a bot sits in: its own session for this room, made on first use. */
function seatFor(ch: Channel, bot: Bot): { sessionId: string; started: boolean } {
  return (ch.seats[bot.id] ??= { sessionId: newSessionId(), started: false });
}

/** Calling the whole room in. Three spellings because people arrive from
 *  different apps and all three mean the same thing; "@everyones" is a word
 *  and not a summons, hence the boundary.
 *
 *  A regex literal rather than one built from a template string: `\b` inside a
 *  template literal is the backspace character, not a word boundary, so the
 *  first version of this compiled, ran, and matched nothing — and a message
 *  that summons nobody is indistinguishable on screen from a message addressed
 *  to nobody, which is why it took sending one to notice. */
const callsTheRoom = (text: string): boolean => /@(everyone|channel|here)\b/i.test(text);

/** Who a message is addressed to.
 *
 *  An "@" and a name summons that member. Names have spaces in them, so this
 *  matches the longest member name that follows the "@" rather than a word —
 *  "@Research and Writing" is one person, not one person and a conjunction.
 *
 *  With nobody named, the rule depends on how crowded the room is: one bot in
 *  it answers everything, because a two-person room is a chat and making you
 *  type its name every time would be silly. More than one and an unaddressed
 *  message is left alone — that is what a channel is, and five bots all
 *  answering "morning" is the behaviour this rule exists to prevent. */
function addressees(ch: Channel, text: string, exclude?: string): Bot[] {
  const room = membersOf(ch).filter((bot) => bot.id !== exclude);

  // "@everyone" is yours alone — `exclude` is set only when a bot is the one
  // being read. A bot able to call the room in would spend a whole message's
  // budget in one line, and in a room of five that means three arbitrary bots
  // answer and two do not, which is worse than a rule that says no. Bots bring
  // in the person whose work it is, by name.
  if (exclude === undefined && callsTheRoom(text)) return room;
  const hay = text.toLowerCase();
  const named = room.filter((bot) => {
    const at = `@${bot.name.toLowerCase()}`;
    let from = hay.indexOf(at);
    while (from !== -1) {
      // Followed by a word character it is a longer name that happens to start
      // with this one, and belongs to somebody else.
      const after = hay[from + at.length] ?? " ";
      if (!/[a-z0-9]/.test(after)) return true;
      from = hay.indexOf(at, from + 1);
    }
    return false;
  });
  if (named.length) return named;
  return exclude === undefined && room.length === 1 ? room : [];
}

/** What was said in here since this bot last spoke, attributed.
 *
 *  A bot's session only ever saw what botcage sent it, so a room's other
 *  voices reach it as text or not at all. Attributed on every line because in
 *  a room "who said that" is half the message. */
function whatItMissed(ch: Channel, botId: string): string {
  const spokeAt = ch.messages.map((m) => m.by).lastIndexOf(botId);
  const fresh = ch.messages.slice(spokeAt + 1).filter((m) => m.text.trim());
  const lines = fresh.map((m) => {
    const who = m.from === "me" ? userName() || "The user" : nameOf(m.by) || "A bot";
    return `${who}: ${m.text}`;
  });
  return lines.join("\n\n");
}

const nameOf = (botId?: string): string =>
  state.bots.find((b) => b.id === botId)?.name ?? "";

/** Did a bot address you by name?
 *
 *  Not "does your name appear" — a bot discussing a file called guru.md is not
 *  talking to you. The "@" is what makes it a summons, the same as it is
 *  between bots, and it is what the prompt tells them to use. */
function mentionsYou(text: string): boolean {
  const called = userName().trim();
  if (!called) return false;
  return new RegExp(`@${reSafe(called)}\\b`, "i").test(text);
}

/** A name, made safe to drop into a pattern. */
const reSafe = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What has happened somewhere you were not looking.
 *
 *  Two numbers, because they mean different things: unread is "there is
 *  something here", and mentions is "somebody wanted you". Slack and Discord
 *  both learned to show these differently and both were right — a room that
 *  chatters is not the same as a room that asked you a question. */
function unreadIn(messages: Message[], seenAt = 0): { unread: number; mentions: number } {
  let unread = 0;
  let mentions = 0;
  for (const msg of messages) {
    // Your own words are not news, and neither is an empty streaming bubble.
    if (msg.from === "me" || msg.at <= seenAt || !msg.text.trim()) continue;
    unread += 1;
    if (mentionsYou(msg.text)) mentions += 1;
  }
  return { unread, mentions };
}

/** Mark it read. Called whenever a thing is on screen, including while it is
 *  still being written to — reading something as it arrives is still reading
 *  it, and a badge appearing on the row you are looking at is a bug. */
function markSeen(): void {
  const room = activeChannel();
  if (room) room.seenAt = Date.now();
  else {
    const bot = activeBot();
    if (bot) bot.seenAt = Date.now();
  }
}

/** What a bot is told about the room it is speaking in. */
function channelPromptFor(ch: Channel, bot: Bot): string {
  const others = membersOf(ch).filter((b) => b.id !== bot.id);
  return [
    `You are "${bot.name}". This is #${ch.name}, a shared channel in botcage — a room, not a private chat.`,
    userName() ? `The person you are talking to is called ${userName()}.` : "",
    ch.purpose ? `What this channel is for:\n\n${ch.purpose}` : "",
    bot.role ? `What you are here to do, as the user described it:\n\n${bot.role}` : "",
    // The same manner it has in its own chat: a bot that writes one way alone
    // and another in a room is two bots wearing one name.
    mannerLine(bot),
    // The same in a room, where a shortcut arrives after a mention.
    commandsLine(bot),
    others.length
      ? `Also in this channel: ${others.map((b) => `${b.name}${b.role ? ` (${b.role.split("\n")[0].slice(0, 120)})` : ""}`).join("; ")}.`
      : `You are the only bot in this channel for now.`,
    // The two rules that make a room work rather than turn into a hall of
    // mirrors. Stated as behaviour rather than as prohibitions, because a
    // model told only what not to do will still do something.
    others.length
      ? `Every message you see is labelled with who said it. To bring someone in, write @${others[0].name} — they are given the conversation and reply here. Do that when the work is genuinely theirs, and say what you want from them in the same message. Don't @ someone to thank them, agree with them, or hand back something already finished: a mention costs them a turn, and a channel where every message summons somebody is a channel nobody can read. The user can call the whole room in with @everyone; you cannot — name the person whose work it is.`
      : "",
    userName()
      ? `To get ${userName()}'s attention — a question only they can answer, or something they should know now — write @${userName()}. It marks the channel for them. Use it when you need them and not otherwise: a bot that tags someone in every message is a bot they mute.`
      : "",
    `You are not obliged to speak. If the room does not need you, reply with nothing at all.`,
    `Reply conversationally and keep it tight — this is a chat window and other people are reading. Markdown is rendered.`,
    `Your working directory is this bot's private scratch folder, and CLAUDE.md in it is your memory across sessions.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* ------------------------------------------------------------- lip sync */
/* The mouth follows the sound rather than flapping on a timer.
 *
 *  Rust reads the loudness out of the wav it is about to play and sends it
 *  here as one number every 45 ms; this walks that list in step with the clock
 *  and sets how far open the mouth is. It is the difference between a face
 *  that is animated while a voice happens and a face that is saying the words
 *  — the pauses between sentences land in the right place, and so do the
 *  loud syllables.
 *
 *  Only where the synthesiser hands us a file, which is the one botcage
 *  installs. `say` and espeak stream straight to the speakers and keep the
 *  simple flap. */
let lips: { levels: number[]; step: number; from: number; frame: number } | null = null;

void listen<{ step: number; levels: number[] }>("mouth", (event) => {
  stopLips();
  if (!call || !event.payload.levels.length) return;
  lips = { levels: event.payload.levels, step: event.payload.step, from: performance.now(), frame: 0 };
  moveLips();
});

function moveLips(): void {
  if (!lips || !call) return stopLips();
  const at = Math.floor((performance.now() - lips.from) / lips.step);
  if (at >= lips.levels.length) return stopLips();

  const who = call.speakingFor ?? call.botId;
  for (const face of document.querySelectorAll<HTMLElement>(`.face[data-bot="${who}"]`)) {
    face.dataset.lip = "1";
    face.style.setProperty("--mouth", lips.levels[at].toFixed(2));
  }
  lips.frame = requestAnimationFrame(moveLips);
}

function stopLips(): void {
  if (lips) cancelAnimationFrame(lips.frame);
  lips = null;
  for (const face of document.querySelectorAll<HTMLElement>(".face[data-lip]")) {
    delete face.dataset.lip;
    face.style.removeProperty("--mouth");
  }
}

// How the download is going, while it is going.
void listen<string>("hearing", (event) => voiceProgress(event.payload));

/** How a download is going, wherever it was asked for.
 *
 *  The same fetch can be started from three places — a call, the settings row,
 *  or the setup step — and all three have to be able to show it, because the
 *  one that started it is the one being watched. Without this the setup step
 *  said "Starting…" for four hundred megabytes and looked hung. */
function voiceProgress(note: string): void {
  if (call) callSays(note);
  speechHint.textContent = note;
  // The setup step tracks it in a variable rather than writing to the element,
  // because that step repaints from scratch whenever anything else changes.
  voiceStep = note;
  if (!setupWrap.hidden && setupAt === "voice") paintSetup();
}

/* ------------------------------------------------------- the better voices */
/* botcage can fetch a speech model rather than use the machine's own: a
   hundred and six people's voices instead of two dozen synthesisers, the same
   on macOS and Linux. About 130 MB, so it is asked for rather than assumed —
   the same bargain as a container engine. */

const speechBtn = $<HTMLButtonElement>("#app-speech");
const speechHint = $<HTMLSpanElement>("#app-speech-hint");

void listen<string>("speech", (event) => voiceProgress(event.payload));

async function paintSpeech(): Promise<void> {
  const installed = await invoke<boolean>("speech_ready").catch(() => false);
  speechBtn.textContent = installed ? "Remove" : "Get better voices";
  if (!installed) {
    // Both numbers, because they are different and the second one is the one
    // that stays: 130 MB is what crosses the network, and a third of a
    // gigabyte is what sits on the disk afterwards.
    speechHint.textContent =
      "The machine's own. Real ones arrive with your first call, or press this — a 130 MB download, 340 MB on disk.";
    return;
  }
  // The real count, not a number written here: a voice that failed to download
  // is one voice fewer rather than a failed install, so the two can differ.
  const how = (await knownVoices()).length;
  speechHint.textContent = `Kyutai Pocket TTS, on this machine. Every bot has one of ${how} real voices.`;
}

speechBtn.addEventListener("click", () => {
  void (async () => {
    const installed = await invoke<boolean>("speech_ready").catch(() => false);
    speechBtn.disabled = true;
    try {
      if (installed) {
        await invoke("speech_forget");
        toast("Back to the machine's own voices");
      } else {
        speechHint.textContent = "Starting…";
        await invoke("speech_install");
        toast("Every bot has a new voice");
      }
      // The list changed underneath every bot, so the cached one is wrong.
      voiceNames = [];
      await knownVoices();
    } catch (err) {
      toast(String(err));
    } finally {
      speechBtn.disabled = false;
      void paintSpeech();
    }
  })();
});

/** Resolves when this bot's turn ends, however it ends. */
function settled(botId: string): Promise<void> {
  const pending = inflight.get(botId);
  if (!pending) return Promise.resolve();
  return new Promise((resolve) => {
    pending.settle = resolve;
  });
}

/** One bot's turn in a room, and whatever it sets off.
 *
 *  Sequential on purpose: the addressees answer one at a time, and a bot that
 *  brings somebody in waits for them. A room where three bots stream at once
 *  is unreadable, and it is also not how the thing being modelled works. */
async function channelTurn(
  ch: Channel,
  bot: Bot,
  budget: Budget,
  /** What to answer, when it is not simply what was said since it last spoke —
   *  a routine has its own instruction, and nobody said it out loud. */
  asked?: string,
  /** How to deliver it. A room on a call wants two spoken sentences from the
   *  same bot, not a different bot. */
  style?: string,
): Promise<void> {
  if (hushed.has(ch.id)) return;
  // Busy in its own chat, or already speaking here. Skipped rather than
  // queued: by the time it is free the conversation has moved on, and an
  // answer to a message five turns back is worse than no answer.
  if (inflight.has(bot.id)) {
    toast(`${bot.name} is busy — ask again in a moment`);
    return;
  }

  const heard = asked ?? whatItMissed(ch, bot.id);
  if (!heard.trim()) return;

  const seat = seatFor(ch, bot);
  const post: Message = { id: uid(), from: "bot", by: bot.id, text: "", at: Date.now() };
  ch.messages.push(post);
  inflight.set(bot.id, { message: post, sawText: false, note: "", channelId: ch.id });
  setMood(bot.id, restingMood(bot.id) === "sleep" ? "wake" : "read");

  if (state.activeChannel === ch.id) {
    thread.append(turnEl(post, ch, ch.messages[ch.messages.length - 2]));
    waitingHtml(post.id, "");
    arrived();
  }
  // On a call, the tile should show it is working before it has anything to
  // say — a room of still faces during a twenty-second turn looks broken.
  if (call?.channelId === ch.id) paintCallStage();
  syncSend();
  renderRoster();

  const wait = settled(bot.id);
  try {
    await invoke("ask", {
      req: {
        botId: bot.id,
        engine: bot.engine ?? DEFAULT_ENGINE,
        provider: bot.provider,
        // Its seat in this room, not its chat: a different conversation with a
        // different history, which is the whole reason both can exist.
        sessionId: seat.sessionId,
        resume: seat.started,
        thread: ch.id,
        prompt: heard,
        systemPrompt: style
          ? `${channelPromptFor(ch, bot)}\n\n${style}`
          : channelPromptFor(ch, bot),
        model: bot.model || MODEL,
        botName: bot.name,
        botRole: bot.role,
        colleagues: state.bots.filter((b) => b.id !== bot.id).map((b) => b.name),
        computer: bot.computer,
        brand: {
          name: bot.name,
          color: bot.color,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          locale: navigator.language ?? "",
          network: bot.network,
          github: (bot.plugins ?? []).includes("github"),
          ...machineBrand(bot),
        },
        plugins: bot.plugins ?? [],
        blockedPlugins: plugins.map((p) => p.key).filter((key) => !(bot.plugins ?? []).includes(key)),
      },
    });
  } catch (err) {
    finish(bot.id, { botId: bot.id, kind: "error", text: String(err) });
  }
  await wait;
  seat.started = true;

  // Nothing to say is a valid turn, and an empty bubble is not. Drop it.
  if (!post.text.trim() && !post.error) {
    ch.messages.splice(ch.messages.indexOf(post), 1);
    if (state.activeChannel === ch.id) renderChannel();
  }
  save();

  // Whoever it brought in, while the message still has turns left to give.
  //
  // On a call, a name said aloud counts as bringing someone in. A bot asked to
  // hand over says "Guide, can you confirm" rather than "@Guide", because it
  // was told to talk like a person on a call — and requiring the marker meant
  // the handover it just announced never happened.
  const onward =
    call?.channelId === ch.id
      ? spokenAddressees(ch, post.text, false).filter((b) => b.id !== bot.id)
      : addressees(ch, post.text, bot.id);
  // It named somebody. The one being named already looks up; this is the other
  // end of that, and it is what makes a handover in a room legible from the
  // roster rather than only in the text.
  if (onward.length) setMood(bot.id, "point");

  for (const next of onward) {
    if (budget.left <= 0 || hushed.has(ch.id)) return;
    budget.left -= 1;
    await channelTurn(ch, next, budget);
  }
}

/** What a bot has actually been doing, from botcage's own records.
 *
 *  The whole difference between a standup worth reading and five bots
 *  generating three paragraphs of plausible progress. A bot is not asked what
 *  it has been up to — it is told, from what ran and what broke, and asked to
 *  report it. Everything here is counted from state; not one line of it costs
 *  a model anything.
 */
function weekOf(bot: Bot, since: number): string {
  const ran = (bot.routines ?? []).filter((r) => (r.lastRunAt ?? 0) > since);
  const said = bot.messages.filter((m) => m.at > since && m.from === "bot" && m.text.trim());
  const broke = bot.messages.filter((m) => m.at > since && m.error);

  // What is coming, so "what's next" is a fact rather than an intention.
  const soon = (bot.routines ?? [])
    .filter((r) => r.active)
    .map((r) => ({ r, at: nextRun(r, r.lastRunAt ?? Date.now()) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 3);

  const lines = [
    ran.length
      ? `Routines that ran: ${ran.map((r) => r.name).join(", ")}`
      : "Routines that ran: none",
    `Turns taken: ${said.length}`,
    broke.length
      ? `Failed: ${broke.map((m) => m.error).slice(0, 3).join("; ")}`
      : "Nothing failed",
    soon.length
      ? `Next due: ${soon.map(({ r, at }) => `${r.name} — ${clockDate(at)}`).join(", ")}`
      : "Nothing scheduled",
  ];
  return lines.join("\n");
}

const clockDate = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** A review: one bot, its own week, read back to it.
 *
 *  The same trick as the standup and for the same reason — a bot asked "how
 *  did the week go" writes three plausible paragraphs, and a bot handed what
 *  actually ran writes four honest lines. What is different is that this one
 *  is about the bot rather than about the room, which is what makes it worth
 *  having in a private chat: it is the conversation you would have with
 *  somebody on a Friday, and it is the only one where the answer can be
 *  checked against the record it was written from.
 */
function reviewPrompt(bot: Bot, routine: Routine, since: number, room?: Channel): string {
  return (
    (room ? `Your week, reported in #${room.name}.` : `Your week.`) +
    `\n\nFrom botcage's own records rather than from memory:\n\n` +
    `${weekOf(bot, since)}\n\n` +
    (routine.instruction.trim() ? `What this review is for:\n\n${routine.instruction}\n\n` : "") +
    `Report on it in a few short lines: what you actually did, anything that failed and whether it ` +
    `is still failing, and what is next. No headings and no lists. A quiet week said in one line is ` +
    `a useful report — do not describe work you have no record of doing, and do not pad it out to ` +
    `look busy.\n\n` +
    `If something needs ${userName() || "the user"}, say so plainly at the end.`
  );
}

/** A standup: everyone in the room takes a turn, in order.
 *
 *  Round-robin because the format solves the hardest problem in a room full of
 *  bots — who speaks next — without anyone having to decide. And because a
 *  turn takes twenty seconds, which is dead air in a conversation and simply
 *  somebody's slot in a standup.
 *
 *  Nobody is asked an open question. Each is handed what actually ran and
 *  what broke, and told to report it; a bot with nothing to say is told that
 *  saying so in one line is the right answer. Otherwise a standup is five bots
 *  writing three paragraphs of plausible progress every morning, which is
 *  worse than no standup because it looks like information. */
async function runStandup(room: Channel, routine: Routine, since: number): Promise<void> {
  room.messages.push({
    id: uid(),
    from: "bot",
    text: "",
    at: Date.now(),
    kind: "routine",
    meta: { steps: 0, frames: 0, slug: routine.id, name: `Standup · ${routine.name}` },
  });
  save();
  renderRoster();
  if (state.activeChannel === room.id) renderChannel();

  const there = membersOf(room);
  for (const bot of there) {
    if (!channels().some((c) => c.id === room.id)) return;
    fromRoutine.set(bot.id, routine.name);
    const asked =
      `Stand-up in #${room.name}. It is your turn.\n\n` +
      `Here is your week, from botcage's own records rather than from memory:\n\n` +
      `${weekOf(bot, since)}\n\n` +
      (routine.instruction.trim() ? `What this stand-up is for:\n\n${routine.instruction}\n\n` : "") +
      `Say what you did, what is next, and anything you are stuck on — two or three short lines, ` +
      `no headings, no lists. If nothing has happened since the last one, say exactly that in one ` +
      `line: it is the useful answer and it is what most days look like. Do not describe work you ` +
      `have no record of doing.\n\n` +
      `If something needs a person, tag ${userName() || "the user"}. If it needs one of the others, ` +
      `name them — they take their turn after you either way.`;

    // A slot at a time, and each waits for the last: a room where five bots
    // answer at once is not a stand-up, it is a noise.
    await channelTurn(room, bot, { left: 1 }, asked);
  }
}

/** A routine firing into a channel rather than into the bot's own chat.
 *
 *  The room gets a badge naming the routine, because a bot that suddenly
 *  starts talking about last night's backups has to say why — nobody typed
 *  anything, and without it the room reads as a bot talking to itself.
 *
 *  A fresh hop budget, so a watchdog that finds something wrong can bring in
 *  whoever should fix it. That is most of the reason to report into a room
 *  rather than a thread. */
async function runRoutineInChannel(bot: Bot, routine: Routine, room: Channel): Promise<void> {
  // Empty text on purpose: a marker, not something said. `whatItMissed` skips
  // it, so the next bot to speak is not handed the instruction as though
  // somebody had read it out.
  room.messages.push({
    id: uid(),
    from: "bot",
    by: bot.id,
    text: "",
    at: Date.now(),
    kind: "routine",
    meta: { steps: 0, frames: 0, slug: routine.id, name: routine.name },
  });
  save();
  renderRoster();
  if (state.activeChannel === room.id) renderChannel();

  // What it missed first, then what it is here to do — in that order, so the
  // instruction is the last thing it reads and the thing it acts on.
  const since = whatItMissed(room, bot.id);
  const asked = since
    ? `Since you last spoke here:\n\n${since}\n\n---\n\nYour standing instruction, which has just come due. Do it and report here:\n\n${routine.instruction}`
    : `Your standing instruction, which has just come due. Do it and report here:\n\n${routine.instruction}`;

  setMood(bot.id, "alert");
  await channelTurn(room, bot, { left: HOPS }, asked);
}

/** You said something in a room. */
function postToChannel(ch: Channel, text: string): void {
  // Saying something is how a stopped room starts again.
  hushed.delete(ch.id);
  const msg: Message = { id: uid(), from: "me", text, at: Date.now() };
  ch.messages.push(msg);
  // Only when this room is the one on screen. It used not to check, because
  // for a long time the only way to post to a room was to be looking at it —
  // now the desk can answer a question in a room that is not open, and without
  // this the message is appended to whatever conversation happens to be in
  // front of you and the composer you were typing in is cleared.
  if (state.activeChannel === ch.id) {
    if (ch.messages.length === 1) thread.innerHTML = "";
    thread.append(turnEl(msg, ch, ch.messages[ch.messages.length - 2]));
    input.value = "";
    autoGrow();
    scrollToEnd(true);
  }
  save();

  let wanted = addressees(ch, text);

  // In a thread, whoever said the thing you pulled aside answers by default.
  // You opened a side conversation about their message; making you name them
  // again to continue it would be a strange thing to ask.
  if (!wanted.length && ch.from) {
    const anchor = channels()
      .find((c) => c.id === ch.from?.channelId)
      ?.messages.find((m) => m.id === ch.from?.messageId);
    const author = membersOf(ch).find((b) => b.id === anchor?.by);
    if (author) wanted = [author];
  }

  if (!wanted.length) {
    // Said to the room rather than to anyone in it. Not an error — people do
    // it constantly — but silence with no explanation reads as a bug.
    if (membersOf(ch).length > 1) {
      toast(`Nobody was named — @${membersOf(ch)[0].name} brings one in, @everyone brings them all`);
    }
    return;
  }
  const budget: Budget = { left: HOPS };
  void (async () => {
    for (const bot of wanted) await channelTurn(ch, bot, budget);
  })();
}

/* -------------------------------------------------------------- the room UI */

function renderChannel(): void {
  const ch = activeChannel();
  if (!ch) return;
  const was = heldPlace(`chan:${ch.id}`);

  const room = membersOf(ch);
  const parent = ch.from ? channels().find((c) => c.id === ch.from?.channelId) : null;
  topbarId.innerHTML =
    `<span class="chan__hash">${icon(ch.from ? "reply" : "hash")}</span>` +
    `<span>${escapeHtml(ch.name)}</span>` +
    (parent ? `<span class="chan__parent">in #${escapeHtml(parent.name)}</span>` : "") +
    `<span class="chan__faces">${room.map((b) => faceHtml(b, "sm")).join("")}</span>`;
  input.placeholder = !room.length
    ? `#${ch.name} has nobody in it yet`
    : ch.from
      ? "Reply in this thread"
      : `Message #${ch.name}`;

  if (!ch.messages.length) {
    thread.innerHTML =
      `<div class="empty">` +
      `<h2>#${escapeHtml(ch.name)}</h2>` +
      `<p>${
        room.length
          ? escapeHtml(room.map((b) => b.name).join(", "))
          : "Nobody is in here yet."
      }</p></div>`;
  } else {
    thread.innerHTML = "";
    ch.messages.forEach((msg, n) => thread.append(turnEl(msg, ch, ch.messages[n - 1])));
  }

  // Re-attach the waiting indicator for anyone mid-turn in this room.
  for (const [, pending] of inflight) {
    if (pending.channelId === ch.id && !pending.sawText) waitingHtml(pending.message.id, pending.note);
  }
  markSeen();
  paintPins();
  syncSend();
  restorePlace(was);
}

function openChannel(id: string): void {
  if (deskOpen) showDesk(false);
  state.activeChannel = id;
  // A room has no calendar of its own, so leave the one that was open.
  if (routinesOpen) {
    routinesOpen = false;
    calEveryone = false;
    $<HTMLElement>(".main").classList.remove("is-routines");
    $<HTMLElement>("#routines").hidden = true;
    $<HTMLButtonElement>("#btn-routines").classList.remove("is-on");
  }
  save();
  renderRoster();
  paintTopbarFor(null);
  renderChannel();
  input.focus();
}

/** Which of the top-right buttons make sense for what is on screen.
 *
 *  A room has no routines, no plugins of its own and no computer — those
 *  belong to a bot. Hiding them beats showing four buttons that do nothing to
 *  the thing you are looking at. */
function paintTopbarFor(bot: Bot | null): void {
  const inRoom = !bot;
  for (const id of ["btn-routines", "btn-plugins", "btn-monitor"]) {
    $<HTMLButtonElement>(`#${id}`).hidden = inRoom;
  }
  // A room can be called too, now: everyone in it, one voice at a time.
  const phone = $<HTMLButtonElement>("#btn-call");
  phone.hidden = false;
  phone.title = inRoom ? "Call this channel" : "Call it";
  // Pins belong to a conversation, and both kinds have one.
  paintPins();
  const gear = $<HTMLButtonElement>("#btn-settings");
  gear.hidden = false;
  gear.title = inRoom ? "Channel settings" : "Bot settings";
}

/* --------------------------------------------------------- making a channel */

let editingChannel: string | null = null;
const channelWrap = $<HTMLDivElement>("#channel-wrap");
const channelName = $<HTMLInputElement>("#channel-name");
const channelPurpose = $<HTMLTextAreaElement>("#channel-purpose");
const channelMembers = $<HTMLDivElement>("#channel-members");
const channelCat = $<HTMLSelectElement>("#channel-cat");
const channelMute = $<HTMLInputElement>("#channel-mute");
const channelMuteRow = $<HTMLElement>("#channel-mute-row");
const channelCatRow = $<HTMLLabelElement>("#channel-cat-row");

function openChannelSheet(ch: Channel | null): void {
  editingChannel = ch?.id ?? null;
  channelName.value = ch?.name ?? "";
  channelPurpose.value = ch?.purpose ?? "";

  // Only worth asking once there is somewhere to put it. A picker whose only
  // entry is "None" is a question with one answer.
  channelCatRow.hidden = !categories().length;
  channelCat.innerHTML =
    `<option value="">None</option>` +
    categories()
      .map(
        (cat) =>
          `<option value="${cat.id}"${ch?.category === cat.id ? " selected" : ""}>` +
          `${escapeHtml(cat.name || "Untitled")}</option>`,
      )
      .join("");

  channelMembers.innerHTML = state.bots.length
    ? state.bots
        .map(
          (bot) =>
            `<label class="chan__member">` +
            `<input type="checkbox" value="${bot.id}"${ch?.members.includes(bot.id) ? " checked" : ""} />` +
            faceHtml(bot, "sm") +
            `<span class="chan__memberName">${escapeHtml(bot.name)}</span></label>`,
        )
        .join("")
    : `<p class="chan__fine">Make a bot first.</p>`;

  $<HTMLHeadingElement>("#channel-title").textContent = ch ? `#${ch.name}` : "New channel";
  $<HTMLButtonElement>("#channel-save").textContent = ch ? "Save" : "Create channel";
  // Nothing to silence until it exists, and a room made muted is a room whose
  // first message you never see.
  channelMuteRow.hidden = !ch;
  channelMute.checked = !!ch?.muted;
  $<HTMLButtonElement>("#channel-delete").hidden = !ch;
  channelWrap.hidden = false;
  channelName.focus();
}

/** A channel name as a handle: lowercase, no spaces, like every other app
 *  that has one. Corrected rather than rejected — nobody wants a form error
 *  for typing a capital letter. Returns "" for a name with nothing usable in
 *  it, which both callers treat as "no name given". */
function handle(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      // Again after the cut, not only before it: a long name sliced at
      // twenty-four characters can land on a separator, and #one-two-three-
      // is a name with a hyphen hanging off the end of it.
      .replace(/-+$/, "")
  );
}

$<HTMLFormElement>("#channel-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = handle(channelName.value);
  if (!name) {
    channelName.focus();
    return;
  }
  const picked = [...channelMembers.querySelectorAll<HTMLInputElement>("input:checked")].map(
    (box) => box.value,
  );

  const filed = channelCat.value || undefined;

  const existing = channels().find((c) => c.id === editingChannel);
  if (existing) {
    existing.name = name;
    existing.purpose = channelPurpose.value.trim();
    existing.members = picked;
    if (channelMute.checked) existing.muted = true;
    else delete existing.muted;
    if (filed) existing.category = filed;
    else delete existing.category;
  } else {
    const made: Channel = {
      id: uid(),
      name,
      purpose: channelPurpose.value.trim(),
      members: picked,
      messages: [],
      seats: {},
      ...(filed ? { category: filed } : {}),
    };
    channels().push(made);
    state.activeChannel = made.id;
  }
  channelWrap.hidden = true;
  save();
  renderRoster();
  renderChannel();
  input.focus();
});

/** Take a room away, and everything that hung off it.
 *
 *  Its threads go too. A thread is a channel whose parent is this one, and a
 *  thread whose parent is gone is drawn nowhere and reachable by nothing — it
 *  would sit in the store for ever, holding a transcript, as a room that
 *  cannot be opened. Each member kept its own conversation for each of them,
 *  and those go with the rooms they belong to.
 *
 *  Returns how many rooms went, so the caller can say so. */
function removeChannel(ch: Channel): number {
  const going = [ch, ...channels().filter((c) => c.from?.channelId === ch.id)];
  const gone = new Set(going.map((c) => c.id));
  state.channels = channels().filter((c) => !gone.has(c.id));
  for (const room of going) {
    for (const botId of Object.keys(room.seats)) {
      void invoke("clear_thread", { botId, thread: room.id }).catch(() => {});
    }
  }
  if (state.activeChannel && gone.has(state.activeChannel)) state.activeChannel = null;
  return going.length;
}

$<HTMLButtonElement>("#sheet-share").addEventListener("click", () => {
  if (editing) void shareTemplate(editing);
});

$<HTMLButtonElement>("#sheet-import").addEventListener("click", () => {
  showSheet(false);
  void importTemplate();
});

$<HTMLButtonElement>("#channel-delete").addEventListener("click", () => {
  const ch = channels().find((c) => c.id === editingChannel);
  if (!ch) return;
  const went = removeChannel(ch);
  channelWrap.hidden = true;
  save();
  renderRoster();
  renderThread();
  toast(went > 1 ? `Deleted #${ch.name} and ${went - 1} thread${went > 2 ? "s" : ""}` : `Deleted #${ch.name}`);
});

$<HTMLButtonElement>("#channel-close").addEventListener("click", () => {
  channelWrap.hidden = true;
});
channelWrap.addEventListener("mousedown", (e) => {
  if (e.target === channelWrap) channelWrap.hidden = true;
});


/* -------------------------------------------------------------------- calls */
/* Talking to a bot instead of typing at it.
 *
 *  The bot's own face, already carrying fifteen moods, is the video: it
 *  listens, thinks, speaks and waves without anybody having to fake a webcam.
 *  Underneath there is no new machinery — a call is a different way in and out
 *  of the same conversation, so what you say becomes an ordinary message, the
 *  reply becomes an ordinary reply, and when the call ends the whole thing is
 *  in the thread to read.
 *
 *  A turn takes fifteen to twenty-five seconds, which is unbearable as a
 *  conversation and fine as dispatch. So the call is built for handing over
 *  work rather than for chatting: you can keep talking while it is thinking,
 *  and what you say queues up behind what it is already doing. */

interface Call {
  /** Who is speaking, or who you rang. On a call with one bot these are the
   *  same thing for its whole length; in a room it changes hands. */
  botId: string;
  /** The room, when this is a call with several bots rather than one. */
  channelId?: string;
  /** What you have said that has not been sent yet, because a turn is running. */
  queue: string[];
  listening: boolean;
  /** The microphone, open for as long as the button is held. */
  tape: MediaRecorder | null;
  /** The pieces it has handed over so far. */
  bits: Blob[];
  /** What it heard you say last, shown so a misheard word is visible. */
  heard: string;
  /** How much of each bot's reply has been handed to the voice.
   *
   *  Per bot, not one number: a turn is finished as far as the model is
   *  concerned while its last sentence is still being spoken, so the bot it
   *  brought in starts streaming before the previous one has stopped talking.
   *  Two answers are in the air at once and they are different lengths. */
  spokenTo: Record<string, number>;
  /** Lines waiting their turn at the speaker, each with whose they are.
   *
   *  Whose matters: the queue outlives a turn, so a line pulled off it may
   *  belong to a bot that stopped generating a while ago. Speaking it in
   *  whoever happens to be current puts one bot's words in another's voice. */
  saying: { botId: string; line: string }[];
  /** Whether something is being said right now. */
  voicing: boolean;
  /** Whose answer is currently being read out, in a room. */
  speakingFor?: string;
}


/** What the voice download is doing, while it is doing it. Declared here
 *  because the progress arrives long before the setup step is defined. */
let voiceStep = "";

let call: Call | null = null;
let voiceNames: string[] = [];

/** Is this bot on the call — the one you rang, or one of the room's? */
function onThisCall(botId: string): boolean {
  if (!call) return false;
  if (!call.channelId) return call.botId === botId;
  const room = channels().find((c) => c.id === call?.channelId);
  return Boolean(room?.members.includes(botId));
}

/** Start a side conversation from something said in a room.
 *
 *  The same bots, so it needs no membership of its own; a fresh seat each, so
 *  what is said here is a separate conversation from the room's — which is the
 *  point of a thread, and comes free from a channel already keeping a session
 *  and a transcript per member.
 *
 *  The message it started from is quoted in, because the bots were not there
 *  when it was said: their session for this thread is new and empty. */
function openThreadFrom(room: Channel, msg: Message): void {
  const already = channels().find((c) => c.from?.messageId === msg.id);
  if (already) return openChannel(already.id);

  const said = msg.text.replace(/\s+/g, " ").trim();
  const thread: Channel = {
    id: uid(),
    // Named after what it came from, which is what anyone would call it.
    name: (said.slice(0, 40) || "thread").trim(),
    purpose: room.purpose,
    members: [...room.members],
    messages: [
      {
        id: uid(),
        from: msg.from,
        by: msg.by,
        text: said,
        at: msg.at,
        kind: msg.kind,
        meta: msg.meta,
      },
    ],
    seats: {},
    from: { channelId: room.id, messageId: msg.id },
  };
  channels().push(thread);
  save();
  openChannel(thread.id);
  toast(`Thread started in #${room.name}`);
}

/** The room this call is in, if it is in one. */
const callRoom = (): Channel | null =>
  call?.channelId ? (channels().find((c) => c.id === call?.channelId) ?? null) : null;

const callEl = $<HTMLDivElement>("#call");
const callState = $<HTMLParagraphElement>("#call-state");
const callHeard = $<HTMLParagraphElement>("#call-heard");

/** Which voice a bot speaks in.
 *
 *  Chosen from its id the same way its face is, so a bot sounds the same every
 *  time and no two next to each other are likely to sound alike. Nobody picks
 *  it, for the same reason nobody picks a face: a hundred and eighty voices is
 *  not a decision anyone wants to make per bot. */
function voiceFor(bot: Bot): string | undefined {
  // Whatever it has, as long as the machine still has it. Nothing to check
  // against yet means trust what was written down rather than lose it.
  if (bot.voice && (!voiceNames.length || voiceNames.includes(bot.voice))) return bot.voice;
  if (!voiceNames.length) return undefined;

  const given = voiceNames[seedOf(bot.id) % voiceNames.length];

  // Written down the first time it speaks, and never derived again.
  //
  // The pick is an index into however many voices are installed, and that
  // number moves: a voice that failed to download and is fetched later, the
  // engine removed and put back, a system voice added. Any of those shifts
  // every index by one and every bot in the app wakes up sounding like
  // somebody else. A bot's voice is part of what it is, so it stops being a
  // calculation as soon as there is an answer to write down.
  bot.voice = given;
  save();
  return given;
}

/** The voices this machine offers, fetched once.
 *
 *  Wanted before any call is made now, because the settings sheet lists them —
 *  so this is the one place that asks, and everywhere else waits on it. */
async function knownVoices(): Promise<string[]> {
  if (!voiceNames.length) {
    voiceNames = await invoke<string[]>("voices", {
      language: navigator.language || "en",
    }).catch(() => []);
    // The moment there is a list, every bot's voice is decided and written
    // down — not left until the first time it happens to speak. Otherwise a
    // bot's settings show one voice today and another tomorrow because
    // something was installed in between, and it never said a word either way.
    if (voiceNames.length) {
      for (const bot of state.bots) voiceFor(bot);
    }
  }
  return voiceNames;
}

/** Markdown read aloud is punctuation read aloud. */
function forSpeech(text: string): string {
  return text
    // "@Guide" is a mention on screen and the words "at Guide" out loud, which
    // is not what anybody meant. The name stays; the marker goes.
    .replace(/@(?=[A-Za-z])/g, "")
    .replace(/```[\s\S]*?```/g, " — code — ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[#>\s]*/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/^[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function callSays(note: string): void {
  callState.textContent = note;
}

/** Who is on the call, and who is talking.
 *
 *  One face when you rang one bot; the room's faces side by side when you
 *  rang a room, with whoever has the floor lit and the rest dimmed — which is
 *  what a call looks like, and here it is true rather than decorative. */
function paintCallStage(): void {
  if (!call) return;
  const room = callRoom();
  const stage = $<HTMLDivElement>("#call-face");
  const who = $<HTMLHeadingElement>("#call-who");

  if (!room) {
    const bot = state.bots.find((b) => b.id === call?.botId);
    if (!bot) return;
    stage.className = "call__face";
    stage.innerHTML = faceHtml(bot, "lg", true);
    who.textContent = bot.name;
    $<HTMLDivElement>(".call__stage").classList.remove("call__stage--room");
    return;
  }

  const speaking = call.speakingFor;
  const there = membersOf(room);
  stage.className = "call__grid";
  // The count decides the shape: one big tile, two side by side, four in a
  // square. Left to the browser it would put six in a row and each would be
  // the size of a stamp.
  // You are on the call too, and a room that shows only the bots reads as a
  // panel you are watching rather than a call you are in.
  stage.dataset.count = String(Math.min(there.length + 1, 6));
  stage.innerHTML =
    there
      .map(
        (b) =>
          `<span class="tile${b.id === speaking ? " is-speaking" : ""}${
            inflight.has(b.id) ? " is-working" : ""
          }" style="--skin:${b.color}">` +
          `<span class="tile__face">${faceHtml(b, "lg", true)}</span>` +
          `<span class="tile__name">${escapeHtml(b.name)}</span>` +
          `</span>`,
      )
      .join("") +
    `<span class="tile tile--you${call.listening ? " is-speaking" : ""}">` +
    `<span class="tile__you">${escapeHtml((userName() || "y").slice(0, 1).toUpperCase())}</span>` +
    `<span class="tile__name">${escapeHtml(userName() || "You")}</span>` +
    `</span>`;
  // A thread is not a #channel, and calling one is a real thing to do.
  who.textContent = room.from ? room.name : `#${room.name}`;
  $<HTMLDivElement>(".call__stage").classList.add("call__stage--room");
}

/** Ring a whole room. */
async function startGroupCall(room: Channel): Promise<void> {
  const there = membersOf(room);
  if (!there.length) {
    toast("Nobody is in this channel yet");
    return;
  }
  await startCall(there[0], room);
}

async function startCall(bot: Bot, room?: Channel): Promise<void> {
  if (!claudeReady) {
    toast("Claude Code CLI not found — install it to talk to your bots");
    return;
  }
  call = {
    botId: bot.id,
    channelId: room?.id,
    queue: [],
    listening: false,
    tape: null,
    bits: [],
    heard: "",
    spokenTo: {},
    saying: [],
    voicing: false,
  };

  paintCallStage();
  callHeard.textContent = "";
  callEl.hidden = false;
  callEl.style.setProperty("--skin", bot.color);
  if (room) {
    for (const b of membersOf(room)) setMood(b.id, "wave");
    callSays("Everyone can hear you. Say a name to ask just that one.");
  } else {
    setMood(bot.id, "wave");
    callSays("Hold the button, or hold space, and talk.");
  }

  await knownVoices();

  // Everything a call needs, once, on the first one ever made. Fetched here
  // rather than at install because most people will never make a call, and
  // this is a lot to spend on their behalf until they do.
  //
  // Both halves, not just the ear: a first call that can hear you and answers
  // in a 2005 satnav is a bad first impression of the whole feature, and
  // "there is a better voice, go and find the setting" is a thing nobody
  // should have to be told. Settings can take it away again.
  const needsEars = !(await invoke<boolean>("hearing_ready").catch(() => false));
  const needsVoice = !(await invoke<boolean>("speech_ready").catch(() => false));

  if (needsEars || needsVoice) {
    callSays("Setting up voice — a few hundred megabytes, once.");
    try {
      if (needsEars) await invoke("hearing_install");
      if (needsVoice) await invoke("speech_install");
      voiceNames = [];
      await knownVoices();
      callSays("Ready. Hold the button, or hold space, and talk.");
    } catch (err) {
      // A voice that could not be fetched is not a call that cannot happen:
      // the machine's own still works, and so does hearing.
      callSays(`${err}`);
      window.setTimeout(() => {
        if (call?.botId === bot.id) callSays("Hold the button, or hold space, and talk.");
      }, 2500);
    }
  }
}

function endCall(): void {
  if (!call) return;
  call.saying = [];
  stopLips();
  // A room hushed by talking over it is only hushed for the call; typing in
  // it afterwards should not be met with silence.
  const room = callRoom();
  if (room) hushed.delete(room.id);
  stopListening();
  void invoke("hush").catch(() => {});
  call = null;
  callEl.hidden = true;
}

/* ------------------------------------------------------------------ hearing */
/* Recorded here, transcribed in Rust, by a model on this machine.
 *
 * Not the webview's own recogniser: on macOS it needs a packaged build to
 * exist at all, WebKitGTK has no implementation of it, and nobody outside
 * Apple can say whether the audio stays on the machine. whisper answers all
 * three, and the only thing crossing the boundary is a list of numbers. */

/** The microphone, opened once and kept for the call.
 *
 *  Asking for it per press puts a permission check and a device warm-up in
 *  front of every sentence, which is about a second of a two-second thought. */
let microphone: MediaStream | null = null;

async function openMicrophone(): Promise<MediaStream | null> {
  if (microphone?.active) return microphone;
  try {
    microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The bot is speaking out of the same speakers you are talking over.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return microphone;
  } catch (err) {
    const why = String(err);
    callSays(
      why.includes("NotAllowed") || why.includes("denied")
        ? "botcage needs the microphone: System Settings → Privacy & Security → Microphone."
        : `No microphone: ${why}`,
    );
    return null;
  }
}

/** Whatever the browser gave us, as the mono 16 kHz whisper wants.
 *
 *  Decoded and resampled here rather than in Rust because the webview already
 *  has the codecs — asking Rust to unpick Opus would mean shipping one. */
async function samplesFrom(recorded: Blob): Promise<Float32Array> {
  const bytes = await recorded.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    // Mixed down rather than taking channel zero: a microphone that records in
    // stereo can put most of a voice in the channel you dropped.
    const length = decoded.length;
    const mixed = new Float32Array(length);
    for (let c = 0; c < decoded.numberOfChannels; c += 1) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < length; i += 1) mixed[i] += channel[i];
    }
    if (decoded.numberOfChannels > 1) {
      for (let i = 0; i < length; i += 1) mixed[i] /= decoded.numberOfChannels;
    }

    const ratio = decoded.sampleRate / WHISPER_RATE;
    if (Math.abs(ratio - 1) < 0.001) return mixed;

    // Linear interpolation. A speech model at 16 kHz is not going to notice
    // the difference between this and a windowed sinc, and this is ten lines.
    const out = new Float32Array(Math.floor(length / ratio));
    for (let i = 0; i < out.length; i += 1) {
      const at = i * ratio;
      const low = Math.floor(at);
      const high = Math.min(low + 1, length - 1);
      const frac = at - low;
      out[i] = mixed[low] * (1 - frac) + mixed[high] * frac;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

const WHISPER_RATE = 16_000;

function startListening(): void {
  if (!call || call.listening) return;
  call.listening = true;
  call.bits = [];
  // Talking over it stops it. The queue is emptied first: hushing only kills
  // the sentence in the air, and the pump would calmly start the next one —
  // which is the opposite of being interrupted. In a room the whole wave
  // stops, including whoever was about to be brought in.
  call.saying = [];
  stopLips();
  const room = callRoom();
  if (room) {
    hushed.add(room.id);
    for (const [botId, pending] of inflight) {
      if (pending.channelId === room.id) cancelTurn(botId);
    }
  }
  void invoke("hush").catch(() => {});
  setMood(call.botId, "listen");
  callSays("Listening…");
  $<HTMLSpanElement>("#call-talk-label").textContent = "Listening";
  $<HTMLButtonElement>("#call-talk").classList.add("is-live");
  paintCallStage();

  void openMicrophone().then((stream) => {
    // Let go before the microphone opened: nothing to record, and starting now
    // would leave it running with nobody to stop it.
    if (!stream || !call?.listening) return;
    const tape = new MediaRecorder(stream);
    call.tape = tape;
    tape.ondataavailable = (e) => {
      if (e.data.size) call?.bits.push(e.data);
    };
    tape.onstop = () => void heardIt();
    tape.start();
  });
}

function stopListening(): void {
  if (!call) return;
  call.listening = false;
  $<HTMLSpanElement>("#call-talk-label").textContent = "Hold to talk";
  $<HTMLButtonElement>("#call-talk").classList.remove("is-live");
  paintCallStage();
  if (call.tape?.state === "recording") {
    // The rest arrives in ondataavailable, and heardIt runs from onstop.
    call.tape.stop();
  } else {
    callSays("Go on — hold to talk.");
  }
  call.tape = null;
}

/** What the recording turned out to be. */
async function heardIt(): Promise<void> {
  if (!call) return;
  const recorded = new Blob(call.bits, { type: call.bits[0]?.type || "audio/webm" });
  call.bits = [];
  if (!recorded.size) {
    callSays("Didn't catch that — hold and try again.");
    return;
  }

  callSays("Working out what you said…");
  try {
    const samples = await samplesFrom(recorded);
    const said = await invoke<string>("transcribe", { samples: Array.from(samples) });
    if (!call) return;
    if (!said.trim()) {
      callHeard.textContent = "";
      callSays("Didn't catch that — hold and try again.");
      return;
    }
    call.heard = said;
    const room = callRoom();
    if (room) saidOnCall(room, said);
    else sayToBot(said);
  } catch (err) {
    callSays(String(err));
  }
}

/* ------------------------------------------------------------------ talking */

/** Something you said, on its way to the bot.
 *
 *  Queued rather than refused when a turn is already running: the point of a
 *  call at this latency is handing over three things in a row without waiting
 *  for the first to come back. */
function sayToBot(said: string): void {
  const bot = state.bots.find((b) => b.id === call?.botId);
  if (!bot || !call) return;

  if (inflight.has(bot.id)) {
    call.queue.push(said);
    callSays(`Noted — ${call.queue.length} waiting while it finishes.`);
    return;
  }

  callHeard.textContent = said;
  callSays("Thinking…");
  call.spokenTo = {};
  call.saying = [];
  call.speakingFor = undefined;

  const msg: Message = { id: uid(), from: "me", text: said, at: Date.now() };
  bot.messages.push(msg);
  save();
  if (bot.id === state.activeId && !state.activeChannel) renderThread();
  void respond(bot, said, CALL_STYLE);
}

/** Who you addressed out loud.
 *
 *  Typing needs the "@" because a name in a sentence is usually just a name.
 *  Speech has no "@" — you say "Ops, what is the state of the build", and the
 *  transcript says exactly that — so requiring one meant every spoken question
 *  read as addressed to nobody, and the rule for nobody is everybody. Which is
 *  why asking one bot something got you answers from all of them.
 *
 *  A name at the front wins, because that is how anyone addresses one person
 *  in a room out loud. Then a name anywhere. An "@" still works, for the
 *  transcript that happens to contain one. */
function spokenAddressees(room: Channel, said: string, yours = true): Bot[] {
  const typed = addressees(room, said, yours ? undefined : "");
  if (typed.length) return typed;

  // Said aloud, "everyone" needs no "@" either — but only from you. Calling
  // the room in is yours alone for the same reason it is when typing: a bot
  // doing it spends the whole budget in one line.
  if (yours && /\b(everyone|everybody|all of you)\b/i.test(said)) return membersOf(room);

  const heard = said.trim().toLowerCase();
  const opening = membersOf(room).filter((bot) => {
    const name = bot.name.toLowerCase();
    if (!heard.startsWith(name)) return false;
    // "Ops, ..." addresses Ops; "Opsworth is broken" does not.
    const after = heard[name.length] ?? " ";
    return !/[a-z0-9]/.test(after);
  });
  if (opening.length) return opening;

  return membersOf(room).filter((bot) =>
    new RegExp(`\\b${reSafe(bot.name)}\\b`, "i").test(said),
  );
}

/** Something you said out loud to a room.
 *
 *  Unaddressed speech reaches everyone, which is the opposite of the rule for
 *  typing. Both are right: a message nobody was named in is a note to the
 *  room and can wait, but saying something aloud into a meeting and being met
 *  with silence is baffling. Naming somebody still directs it at them. */
function saidOnCall(room: Channel, said: string): void {
  hushed.delete(room.id);

  const msg: Message = { id: uid(), from: "me", text: said, at: Date.now() };
  room.messages.push(msg);
  save();
  if (state.activeChannel === room.id) renderChannel();

  const named = spokenAddressees(room, said);
  const wanted = named.length ? named : membersOf(room);
  if (!wanted.length) {
    callSays("Nobody is in this channel yet.");
    return;
  }

  // Nobody has the floor while the room is thinking. Without this the last
  // speaker keeps its ring for the three seconds before the next one starts,
  // so the tile that is lit is the one that is not talking.
  if (call) {
    call.speakingFor = undefined;
    call.spokenTo = {};
    paintCallStage();
  }

  callSays("Thinking…");
  const budget: Budget = { left: HOPS };
  void (async () => {
    for (const bot of wanted) {
      if (!call || hushed.has(room.id)) return;
      await channelTurn(room, bot, budget, undefined, CALL_STYLE);
    }
  })();
}

/** What a bot is told while it is on a call.
 *
 *  Read aloud, a well-organised answer with three headings and a code block is
 *  punishment. It is also the same bot with the same memory, so this asks for
 *  a different delivery rather than a different personality. */
const CALL_STYLE = `You are on a voice call with the user right now: they are speaking, and your reply is read out loud by a speech synthesiser. Answer in one or two spoken sentences — no lists, no headings, no code blocks, no markdown, and no "let me know if". If they have given you something to do, say what you understood in a sentence and get on with it; the full detail belongs in the written thread, not in what you say.`;

/** Where a sentence ends, for something being read aloud.
 *
 *  A full stop followed by a space, which is enough: it leaves "3.5" and
 *  "botcage.app" alone, and the worst an abbreviation can do is put a pause
 *  where a person would not have made one. Speech is forgiving about that in a
 *  way that text is not. */
const SENTENCE = /[.!?…]["')\]]*\s/g;

/** How much to gather before speaking again, once the first sentence is out.
 *
 *  Roughly a couple of sentences. Long enough that one answer is one or two
 *  performances rather than five, short enough that nobody waits for the end
 *  of a paragraph to hear the middle of it. */
const MOUTHFUL = 150;

/** Speak the reply as it is written rather than when it is finished.
 *
 *  Measured on this machine: the first token of a turn arrives about three
 *  seconds in, and the rest of the answer takes as long as the answer is long.
 *  Waiting for the whole thing made a two-sentence reply take twenty seconds
 *  to start; speaking each sentence as it lands makes the length stop
 *  mattering, because sentence four is still being written while sentence one
 *  is in the air. It is the difference between a laggy phone line and a broken
 *  one, and it needed no new model — only not doing things in sequence that
 *  did not have to be. */
function speakAsItArrives(botId: string, whole: string, ending = false): void {
  if (!onThisCall(botId)) return;
  if (!call) return;

  // Not who has the floor — that is decided when a line actually starts being
  // spoken, which can be a while after it was written.
  const done = call.spokenTo[botId] ?? 0;
  const fresh = whole.slice(done);
  if (!fresh) return;

  // How much of what has arrived is a whole sentence. At the end of a turn
  // there is no more coming, so whatever is left counts.
  let upto = 0;
  SENTENCE.lastIndex = 0;
  for (let hit = SENTENCE.exec(fresh); hit; hit = SENTENCE.exec(fresh)) {
    upto = hit.index + hit[0].length;
  }
  if (ending) upto = fresh.length;
  if (!upto) return;

  // The first sentence goes out as soon as it exists, because that is where
  // the three seconds of waiting are. After that, wait for a decent mouthful.
  //
  // Not tidiness: the model botcage installs is generative and has no seed, so
  // every separate utterance is an independent performance of the same voice.
  // Speaking a reply one sentence at a time made a bot's voice change halfway
  // through its own answer, which is far more noticeable than it changing
  // between turns. Fewer, longer pieces means fewer performances.
  const started = done > 0;
  if (started && !ending && upto < MOUTHFUL) return;

  call.spokenTo[botId] = done + upto;
  const line = forSpeech(fresh.slice(0, upto));
  if (!line) return;
  call.saying.push({ botId, line });
  void pumpVoice();
}

/** One sentence at a time, in order.
 *
 *  Sequential because the synthesiser is: asking it to say a second thing
 *  stops it saying the first, so two overlapping calls would produce one
 *  sentence and a stump of another. */
async function pumpVoice(): Promise<void> {
  if (!call || call.voicing) return;

  // The list has to be in hand before the first word, or `voiceFor` returns
  // nothing, Rust falls back to whichever voice is first, and every bot sounds
  // the same until the fetch lands. After the first call this costs nothing.
  await knownVoices();
  if (!call) return;

  call.voicing = true;
  while (call?.saying.length) {
    const next = call.saying.shift();
    if (!next) break;
    const bot = state.bots.find((b) => b.id === next.botId);
    if (!bot) continue;

    // The floor is taken here rather than when the words were written: this is
    // the moment the sound starts, and it is what the ring and the mouth are
    // meant to be showing.
    call.speakingFor = bot.id;
    paintCallStage();
    setMood(bot.id, "talk");
    callHeard.textContent = next.line;
    callSays("Speaking…");
    try {
      await invoke("speak", { text: next.line, voice: voiceFor(bot) });
    } catch {
      break;
    }
    if (moods.get(bot.id) === "talk") setMood(bot.id, "happy");
  }
  if (!call) return;

  call.voicing = false;
  stopLips();
  const busy = [...inflight.values()].some((p) =>
    call?.channelId ? p.channelId === call.channelId : true,
  );
  if (!call.saying.length && !busy && !call.queue.length) {
    call.speakingFor = undefined;
    paintCallStage();
    callSays(callRoom() ? "Go on — everyone can hear you." : "Go on — hold to talk.");
  }
}

/** Called when a turn ends: say whatever was not a whole sentence yet. */
function callHeardBack(botId: string, text: string, failed: boolean): void {
  if (!onThisCall(botId) || !call) return;

  if (failed) {
    // Only this bot's lines. Another bot may be mid-sentence or waiting behind
    // it, and one failed turn is not a reason to cut the room off.
    call.saying = call.saying.filter((waiting) => waiting.botId !== botId);
    callSays("That turn failed — it is written up in the thread.");
  } else {
    speakAsItArrives(botId, text, true);
    if (!call.saying.length && !call.voicing) {
      callSays(callRoom() ? "Go on — everyone can hear you." : "Go on — hold to talk.");
    }
  }

  // Whatever you said while it was busy.
  const next = call.queue.shift();
  if (next) window.setTimeout(() => sayToBot(next), 300);
}

/* ------------------------------------------------------------ app settings */

const appWrap = $<HTMLDivElement>("#app-settings");
const appModel = $<HTMLSelectElement>("#app-model");
const appScreen = $<HTMLSelectElement>("#app-screen");
const appIdle = $<HTMLSelectElement>("#app-idle");
const appRoutines = $<HTMLInputElement>("#app-routines");
const appNotify = $<HTMLInputElement>("#app-notify");
/** Whether this build can send a notification at all. Asked once: it cannot
 *  change while the app is open. */
let canNotify = true;
void invoke<boolean>("can_notify")
  .then((yes) => {
    canNotify = yes;
    if (!yes) paintNotifyRow();
  })
  .catch(() => {});

/** The row says what it can do. A switch that silently does nothing is worse
 *  than no switch: you turn it on, believe it, and find out days later that
 *  the thing you were waiting for never arrived. */
function paintNotifyRow(): void {
  const row = appNotify.closest(".setting");
  const hint = row?.querySelector<HTMLElement>(".setting__hint");
  appNotify.disabled = !canNotify;
  row?.classList.toggle("is-off", !canNotify);
  if (hint) {
    hint.textContent = canNotify
      ? "A notification when a bot says your name or a turn fails, and only while you are looking at something else."
      : "Not from a development build: macOS hangs notifications off an app bundle, and this one is a bare binary. It works in the packaged app, and on Linux either way.";
  }
}
const appAwake = $<HTMLInputElement>("#app-awake");
const appLid = $<HTMLInputElement>("#app-lid");
const appLogin = $<HTMLInputElement>("#app-login");

const aboutWrap = $<HTMLDivElement>("#about");

async function openAbout(): Promise<void> {
  aboutWrap.hidden = false;
  const version = await invoke<string>("app_version").catch(() => "");
  $<HTMLParagraphElement>("#about-version").textContent = version ? `Version ${version}` : "";
}

/** Wire one modal's tab strip to its panels, scoped to that modal. Two dialogs
 *  now use tabs, and querying `.tabs .tab` across the document is exactly how
 *  one strip ended up clearing the other's selection. Returns the setter, so the
 *  caller can reset to the first tab when it opens. */
function wireTabs(root: HTMLElement): (name: string) => void {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".tabs .tab"));
  const panels = Array.from(root.querySelectorAll<HTMLElement>(".settings-panel"));

  const show = (name: string) => {
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.tab !== name;
    }
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => show(tab.dataset.tab ?? ""));
  }
  return show;
}

const showSettingsTab = wireTabs($<HTMLElement>("#app-settings"));
const showSheetTab = wireTabs($<HTMLElement>("#sheet-wrap"));

/* ------------------------------------------------------------------ backups */

/** One encrypted file holding the part of botcage that cannot be downloaded
 *  again.
 *
 *  The window's own store goes with it, and has to: the conversations live in
 *  localStorage rather than in botcage's data folder, so a backup made by
 *  walking the disk would look complete and hold none of them. */

/** Hand a bot over as a file somebody else can open.
 *
 *  A file rather than a link, for now. A link means a server holding other
 *  people's bots — somewhere to upload them, something to pay for, somebody to
 *  answer for what is on it — and this app has spent its whole life keeping
 *  nothing in the middle. The file is the same payload a link would serve, so
 *  the day there is a place to put one, this is what it puts there.
 */
async function shareTemplate(bot: Bot): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const where = await save({
    title: `Share ${bot.name}`,
    defaultPath: `${bot.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot"}.botcage`,
    filters: [{ name: "botcage template", extensions: ["botcage"] }],
  });
  if (!where) return;

  try {
    await invoke("template_write", {
      path: where,
      json: JSON.stringify(templateOf(bot), null, 2),
    });
    // Named plainly, because the difference between a bot and a template of it
    // is the whole thing somebody needs to understand before sending one.
    toast(`Saved ${bot.name} as a template — its conversation and notes stayed here`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

/** Take one in. */
async function importTemplate(): Promise<void> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: false,
    multiple: false,
    title: "Open a bot template",
    filters: [{ name: "botcage template", extensions: ["botcage", "json"] }],
  });
  if (typeof picked !== "string") return;

  try {
    const text = await invoke<string>("template_read", { path: picked });
    const made = botFromTemplate(JSON.parse(text));
    state.bots.push(made);
    save();
    renderRoster();
    openBot(made.id);
    openSheet(made);
    // Straight into its settings: an imported bot arrives with its computer
    // off and its routines idle, and the person who imported it is the one who
    // has to decide about both.
    toast(`${made.name} is here. Nothing of theirs came with it — check what it does before you switch it on.`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

/** A folder to write backups into. */
async function openFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Where to keep backups" });
  return typeof picked === "string" ? picked : null;
}

/** One archive to restore from. */
async function openBackupFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: false,
    multiple: false,
    title: "Which backup",
    filters: [{ name: "botcage backup", extensions: ["backup"] }],
  });
  return typeof picked === "string" ? picked : null;
}

/** How long ago, in the roundest terms that are still true. */
function ago(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const backupPass = $<HTMLInputElement>("#app-backup-pass");
const backupOn = $<HTMLInputElement>("#app-backup-on");
const backupSetup = $<HTMLDivElement>("#app-backup-setup");
const backupDetails = $<HTMLDivElement>("#app-backup-details");
const backupSummary = $<HTMLSpanElement>("#app-backup-summary");
const backupFolder = $<HTMLInputElement>("#app-backup-folder");
const backupEvery = $<HTMLSelectElement>("#app-backup-every");
const backupKeep = $<HTMLSelectElement>("#app-backup-keep");
const backupList = $<HTMLDivElement>("#app-backup-list");
const backupState = $<HTMLSpanElement>("#app-backup-state");
const backupMore = $<HTMLButtonElement>("#app-backup-more");

interface BackupFile {
  name: string;
  path: string;
  bytes: number;
}

/** Whether botcage is holding a passphrase. Asked once per opening of the
 *  sheet, because the answer only changes when someone changes it here. */
let hasPassphrase = false;

/** The one line under the switch.
 *
 *  Off, it says why anyone would want this. On, it says what is happening and
 *  when it last did — which is the only thing worth knowing at a glance, and
 *  the reason none of the rest of it needs to be on screen. */
function paintBackupSummary(): void {
  const app = appSettings();
  const on = (app.backupEvery ?? "off") !== "off";
  backupOn.checked = on;

  // Settings are worth offering once there is something set up to change.
  // Before that the switch does all of it, and a link to a panel of things
  // already decided is one more thing to read past. It takes the panel down
  // with it: a hidden link and an open panel is one nobody can close again.
  backupMore.hidden = !on;
  if (!on) backupDetails.hidden = true;

  if (!on) {
    backupSummary.textContent = "Everything, in one encrypted file, kept where you like.";
    return;
  }

  const how = app.backupEvery === "week" ? "Every week" : "Every day";
  const where = (app.backupFolder ?? "").includes("com~apple~CloudDocs")
    ? "iCloud Drive"
    : (app.backupFolder ?? "").split("/").pop() || "the folder you chose";
  const last = app.backupAt ? ago(app.backupAt) : "not yet";
  backupSummary.textContent = `${how} to ${where} · last one ${last}`;
}

function backupSettings(): void {
  const app = appSettings();
  backupFolder.value = app.backupFolder ?? "";
  backupEvery.value = app.backupEvery === "week" ? "week" : "day";
  backupKeep.value = String(app.backupKeep ?? 7);
  backupSetup.hidden = true;
  paintBackupSummary();
}

async function paintBackups(): Promise<void> {
  hasPassphrase = await invoke<boolean>("backup_ready").catch(() => false);
  paintBackupSummary();

  const folder = appSettings().backupFolder;
  if (!folder) {
    backupList.replaceChildren();
    backupState.textContent = "No folder chosen yet.";
    return;
  }

  const files = await invoke<BackupFile[]>("backup_list", { folder }).catch(() => []);
  backupList.replaceChildren(
    ...files.slice(0, 6).map((file) => {
      const row = document.createElement("div");
      row.className = "device";
      row.textContent = `${file.name} · ${Math.max(1, Math.round(file.bytes / 1024))} KB`;
      return row;
    }),
  );
  backupState.textContent = files.length
    ? `${files.length} in that folder`
    : "None in that folder yet";
}

/** Write one now, whoever asked — the switch, the button or the clock. */
async function backupNow(quiet = false): Promise<boolean> {
  const app = appSettings();
  if (!app.backupFolder) {
    if (!quiet) toast("Choose a folder for your backups first");
    return false;
  }
  try {
    await invoke<string>("backup_now", {
      // The whole of what the window keeps, which is the thing worth saving.
      state: JSON.stringify(state),
      folder: app.backupFolder,
      keep: app.backupKeep ?? 7,
    });
    state.app = { ...appSettings(), backupAt: Date.now() };
    save();
    if (!quiet) toast("Backed up");
    void paintBackups();
    return true;
  } catch (err) {
    // Said out loud even when the clock asked: a backup that has been failing
    // silently for a month is worse than one that was never set up.
    toast(String(err));
    return false;
  }
}

/** Due, by the clock. Checked on the same timer as routines. */
function backupDue(): boolean {
  const app = appSettings();
  const every = app.backupEvery ?? "off";
  if (every === "off" || !app.backupFolder) return false;
  const gap = every === "day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return Date.now() - (app.backupAt ?? 0) >= gap;
}

/** Switch it on, choosing everything that can be chosen for someone.
 *
 *  A folder and a frequency are decisions with obvious right answers, and
 *  asking for them is how a feature that should be one switch becomes a form.
 *  The passphrase is the exception — nobody can pick that for you — so it is
 *  the only thing the switch stops to ask about. */
async function turnBackupsOn(): Promise<void> {
  if (!hasPassphrase) {
    backupSetup.hidden = false;
    backupPass.focus();
    backupOn.checked = false;
    return;
  }

  const folder =
    appSettings().backupFolder ?? (await invoke<string>("backup_default_folder").catch(() => ""));
  state.app = {
    ...appSettings(),
    backupFolder: folder || undefined,
    backupEvery: appSettings().backupEvery === "week" ? "week" : "day",
    backupKeep: appSettings().backupKeep ?? 7,
  };
  save();
  backupSettings();
  // The first one now, rather than in up to a day's time: switching this on and
  // being told "no backups yet" is the wrong answer to the question it asks.
  await backupNow(true);
  void paintBackups();
}

backupOn.addEventListener("change", () => {
  if (backupOn.checked) {
    void turnBackupsOn();
    return;
  }
  state.app = { ...appSettings(), backupEvery: "off" };
  save();
  backupSetup.hidden = true;
  paintBackupSummary();
});

backupMore.addEventListener("click", () => {
  backupDetails.hidden = !backupDetails.hidden;
  if (!backupDetails.hidden) void paintBackups();
});

$<HTMLButtonElement>("#app-backup-change-pass").addEventListener("click", () => {
  backupSetup.hidden = false;
  backupPass.value = "";
  backupPass.focus();
});

backupEvery.addEventListener("change", () => {
  state.app = { ...appSettings(), backupEvery: backupEvery.value as "day" | "week" };
  save();
  paintBackupSummary();
});

backupKeep.addEventListener("change", () => {
  state.app = { ...appSettings(), backupKeep: Number(backupKeep.value) };
  save();
});

backupFolder.addEventListener("change", () => {
  state.app = { ...appSettings(), backupFolder: backupFolder.value.trim() || undefined };
  save();
  paintBackupSummary();
  void paintBackups();
});

$<HTMLButtonElement>("#app-backup-pass-save").addEventListener("click", () => {
  void invoke("backup_passphrase", { passphrase: backupPass.value })
    .then(() => {
      backupPass.value = "";
      backupSetup.hidden = true;
      hasPassphrase = true;
      // Whoever asked for the passphrase wanted the thing behind it.
      if ((appSettings().backupEvery ?? "off") === "off") void turnBackupsOn();
      else toast("Passphrase changed");
    })
    .catch((err) => toast(String(err)));
});

$<HTMLButtonElement>("#app-backup-pick").addEventListener("click", () => {
  void openFolder().then((picked: string | null) => {
    if (!picked) return;
    backupFolder.value = picked;
    state.app = { ...appSettings(), backupFolder: picked };
    save();
    paintBackupSummary();
    void paintBackups();
  });
});

$<HTMLButtonElement>("#app-backup-now").addEventListener("click", () => void backupNow());

$<HTMLButtonElement>("#app-backup-restore").addEventListener("click", () => void restoreBackup());

/** Put one back.
 *
 *  Asks in a sheet of our own rather than with prompt(), which the webview does
 *  not implement — it returns null without drawing anything, so the first
 *  version of this silently did nothing at all. The passphrase is asked for
 *  rather than taken from the keychain, because restoring a backup made on
 *  another machine is the whole case this exists for.
 *
 *  The warning and the button are the confirmation. A dialog that says what is
 *  about to happen, next to a button that says it too, beats a second dialog
 *  asking whether you meant the first one. */
const restoreWrap = $<HTMLDivElement>("#restore-wrap");
const restorePass = $<HTMLInputElement>("#restore-pass");
let restoring: string | null = null;

async function restoreBackup(): Promise<void> {
  const file = await openBackupFile();
  if (!file) return;
  restoring = file;
  restorePass.value = "";
  $<HTMLParagraphElement>("#restore-what").textContent =
    `From ${file.split("/").pop() ?? file}.`;
  restoreWrap.hidden = false;
  restorePass.focus();
}

function closeRestore(): void {
  restoreWrap.hidden = true;
  restoring = null;
  restorePass.value = "";
}

$<HTMLButtonElement>("#restore-close").addEventListener("click", closeRestore);
$<HTMLButtonElement>("#restore-cancel").addEventListener("click", closeRestore);

$<HTMLButtonElement>("#restore-go").addEventListener("click", () => {
  const path = restoring;
  const word = restorePass.value;
  if (!path) return;
  if (!word) {
    toast("Enter the passphrase this backup was made with");
    return;
  }
  void invoke<string>("backup_restore", { path, passphrase: word })
    .then((restored) => {
      // Written straight to storage rather than merged: a half-restored roster
      // is worse than either end of the operation. The reload is what picks it
      // up, because everything in the window was built from the old one.
      localStorage.setItem(STORE, restored);
      window.location.reload();
    })
    .catch((err) => toast(String(err)));
});

async function openAppSettings(): Promise<void> {
  showSettingsTab("general");
  backupSettings();
  void paintBackups();
  void paintSpeech();
  const settings = appSettings();
  $<HTMLInputElement>("#app-name").value = settings.name ?? "";
  appModel.value = settings.model;
  appScreen.value = settings.screen;
  appIdle.value = String(settings.idleMinutes);
  appRoutines.checked = settings.routinesOn;
  appNotify.checked = Boolean(settings.notify);
  paintNotifyRow();
  appAwake.checked = settings.awake;
  appWrap.hidden = false;

  void refreshRemote();
  void paintPush();
  // Unqualified on purpose: this function has a local named `window` (the usage
  // limit window), which shadows the global.
  if (codeTimer !== null) clearInterval(codeTimer);
  codeTimer = setInterval(() => {
    if (appWrap.hidden) {
      if (codeTimer !== null) clearInterval(codeTimer);
      codeTimer = null;
      return;
    }
    void refreshRemote();
  }, 15000);

  void invoke<boolean>("lid_awake").then((on) => (appLid.checked = on)).catch(() => {});
  void invoke<boolean>("login_launch").then((on) => (appLogin.checked = on)).catch(() => {});

  void paintEngines();

  const [claude, docker] = await Promise.all([
    invoke<ClaudeState>("claude_state"),
    invoke<{ version: string | null }>("docker_info"),
  ]);
  // Signed out is worth naming here too: the CLI being present is not the same
  // as it being able to answer.
  const cli = claude.path
    ? `Claude Code ${claude.version?.split(" ")[0] ?? "?"}${claude.signedIn ? "" : " (signed out)"}`
    : "Claude Code missing";
  $<HTMLSpanElement>("#app-environment").textContent =
    `${cli} · ${docker.version ?? "no container engine"}`;

  paintPayroll();

  const spent = session.turns
    ? `$${session.costUsd.toFixed(2)} over ${session.turns} turn${session.turns === 1 ? "" : "s"} this session`
    : "No turns yet this session.";
  const window = session.limit?.resetsAt
    ? ` · ${session.limit.status === "allowed" ? "within limits" : "limit reached"}, resets ${clock(
        session.limit.resetsAt * 1000,
      )}`
    : "";
  $<HTMLSpanElement>("#app-usage").textContent = spent + window;

}

/** List what could answer for a bot, and what is stopping each one. Each bot
 *  picks from the same list in its own settings; this is the overview. */
async function paintEngines(): Promise<void> {
  const engines = await loadEngineChoices();
  const list = $<HTMLDivElement>("#app-engines");
  list.replaceChildren(
    ...engines.map((engine) => {
      const row = document.createElement("div");
      row.className = "engine-row";
      row.innerHTML =
        `<span class="engine-row__light" data-ready="${engine.ready.usable}"></span>` +
        `<span class="engine-row__name"></span>` +
        `<span class="engine-row__missing"></span>`;
      row.querySelector(".engine-row__name")!.textContent = engine.name;
      row.querySelector(".engine-row__missing")!.textContent = engine.ready.usable
        ? "ready"
        : (engine.ready.missing ?? "not available");
      return row;
    }),
  );
}

/** The login name, which stands in until somebody says otherwise. Asked once
 *  and kept, because a name is not worth a round trip per render. */
let loginName = "";

/** What this person is called: what they told setup, or failing that whatever
 *  the operating system calls them. */
function userName(): string {
  return appSettings().name?.trim() || loginName;
}

function paintAccount(): void {
  const name = userName();
  $<HTMLSpanElement>("#account-name").textContent = name || "botcage";
  $<HTMLSpanElement>("#account-initial").textContent = (name || "b").slice(0, 1).toUpperCase();
}

void invoke<string>("user_name")
  .then((name) => {
    loginName = name;
    paintAccount();
  })
  .catch(() => {});

function saveAppSettings(): void {
  // Spread first. This rebuilt the whole object from the controls on screen,
  // so every setting that has no control in this panel — the backup folder and
  // its passphrase schedule, the calendar's span, whether the setup music is
  // hushed — was dropped on the floor the moment anybody touched a switch.
  // Toggling "Run routines" forgot where your backups went.
  state.app = {
    ...appSettings(),
    model: appModel.value,
    screen: appScreen.value,
    idleMinutes: Number(appIdle.value),
    routinesOn: appRoutines.checked,
    awake: appAwake.checked,
    notify: appNotify.checked,
    name: $<HTMLInputElement>("#app-name").value.trim() || undefined,
    engine: appSettings().engine,
    provider: appSettings().provider,
    toured: appSettings().toured,
    onboarded: appSettings().onboarded,
    remoteOn: appSettings().remoteOn,
  };
  save();
  paintAccount();
  verifyCatalogue();

void invoke("set_idle_limit", { minutes: state.app.idleMinutes }).catch(() => {});
  void invoke("set_awake", { on: state.app.awake }).catch((err) => {
    appAwake.checked = false;
    if (state.app) state.app.awake = false;
    save();
    toast(String(err));
  });
}

/* ------------------------------------------------------------------ routines */

const WEEKDAY = [1, 2, 3, 4, 5];

/** When this routine should next run, strictly after `from`. */
function nextRun(routine: Routine, from: number): number {
  if (routine.every === "minutes") {
    return from + Math.max(1, routine.minutes ?? 15) * 60_000;
  }

  const [hh, mm] = routine.at.split(":").map(Number);

  // A one-off happens at its moment and never again — the tick switches it off
  // afterwards. One whose time has already passed runs at the next tick rather
  // than never: a reminder that was missed is still worth delivering.
  if (routine.every === "once") {
    const [y, m, d] = (routine.date ?? "").split("-").map(Number);
    if (!y) return Number.MAX_SAFE_INTEGER;
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
  }

  const at = new Date(from);

  if (routine.every === "hour") {
    at.setMinutes(mm || 0, 0, 0);
    if (at.getTime() <= from) at.setHours(at.getHours() + 1);
    return at.getTime();
  }

  at.setHours(hh || 0, mm || 0, 0, 0);
  const wrongDay = () =>
    (routine.every === "weekday" && !WEEKDAY.includes(at.getDay())) ||
    (routine.every === "week" && at.getDay() !== (routine.day ?? 1));
  while (at.getTime() <= from || wrongDay()) {
    at.setDate(at.getDate() + 1);
    at.setHours(hh || 0, mm || 0, 0, 0);
  }
  return at.getTime();
}

function describeRoutine(routine: Routine): string {
  const room = routine.channel ? channels().find((c) => c.id === routine.channel) : null;
  // Where it lands, when that is not the bot's own chat. On the calendar this
  // is the difference between a bot muttering to itself and a bot posting to a
  // room, which is worth four characters.
  const into = room ? ` → #${room.name}` : "";
  const kind =
    routine.format === "standup" ? " · stand-up" : routine.format === "review" ? " · review" : "";
  return `${howOften(routine)}${into}${kind}`;
}

function howOften(routine: Routine): string {
  if (routine.every === "minutes") {
    const gap = Math.max(1, routine.minutes ?? 15);
    return gap === 1 ? "Every minute" : `Every ${gap} minutes`;
  }
  if (routine.every === "hour") return `Every hour at :${routine.at.split(":")[1]}`;
  if (routine.every === "week") return `Every ${DAY_FULL[routine.day ?? 1]} at ${routine.at}`;
  if (routine.every === "once") {
    const [y, m, d] = (routine.date ?? "").split("-").map(Number);
    const when = y ? new Date(y, m - 1, d) : null;
    return when
      ? `Once on ${when.toLocaleDateString(undefined, { day: "numeric", month: "long" })} at ${routine.at}`
      : `Once at ${routine.at}`;
  }
  const when = routine.every === "weekday" ? "Every weekday" : "Every day";
  return `${when} at ${routine.at}`;
}

/** "Wed 20 Aug, 09:00" — what a schedule amounts to, spelled out, so nobody has
 *  to work out what "every weekday" means from a Friday evening. */
function whenNext(routine: Routine): string {
  const at = nextRun(routine, Date.now());
  if (at === Number.MAX_SAFE_INTEGER) return "";
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

let routinesOpen = false;

/** Whose routines the calendar is showing: the bot you have open, or the lot.
 *
 *  Everything a bot does on a schedule is invisible from every other bot's
 *  calendar, which is fine until you have five of them and want to know what
 *  Tuesday morning actually looks like. */
let calEveryone = false;

/** The bots the calendar is drawing, and the owner of anything drawn. */
function calBots(): Bot[] {
  if (calEveryone) return state.bots;
  const bot = activeBot();
  return bot ? [bot] : [];
}

function ownerOf(routineId: string): { bot: Bot; routine: Routine } | null {
  for (const bot of calBots()) {
    const routine = bot.routines?.find((r) => r.id === routineId);
    if (routine) return { bot, routine };
  }
  return null;
}

/** Every bot's routines on one calendar, from the account menu.
 *
 *  Reached from there rather than from the clock in a bot's header because it
 *  is not about a bot: the clock belongs to whoever is on screen, and this is
 *  the one calendar that belongs to you. */
function openCalendar(): void {
  if (!state.bots.length) return;
  calEveryone = true;
  state.activeChannel = null;
  showRoutines(true);
}

/** The main pane shows either the conversation or the calendar. */
function showRoutines(open: boolean): void {
  routinesOpen = open;
  $<HTMLElement>(".main").classList.toggle("is-routines", open);
  $<HTMLElement>("#routines").hidden = !open;
  $<HTMLButtonElement>("#btn-routines").classList.toggle("is-on", open);
  routineWrap.hidden = true;
  if (!open) {
    calEveryone = false;
    paintTopbarFor(activeBot());
    renderThread();
    return;
  }

  // Whose calendar, in the bar where a bot's face usually is. The shared one is
  // the one view in the app that belongs to no bot, so it says so — and the top
  // right is emptied, because a plug, a screen and a clock all belong to a
  // single bot and none of them mean anything here.
  if (calEveryone) {
    paintTopbarFor(null);
    $<HTMLButtonElement>("#btn-settings").hidden = true;
    topbarId.innerHTML =
      `<span class="chan__hash">${icon("clock")}</span><span>Calendar</span>` +
      `<span class="chan__faces">${state.bots.map((b) => faceHtml(b, "sm")).join("")}</span>`;
  } else {
    $<HTMLButtonElement>("#btn-settings").hidden = false;
  }

  // Opening always lands on now, wherever it was left — but at the size it was
  // last read at, because how much of a calendar you want on screen is a habit
  // rather than a decision to be made again every time.
  calSpan = appSettings().calSpan ?? "week";
  calAt = spanStart(Date.now(), calSpan);
  renderRoutines();
  paintCalScroll();
}

/** Run a routine now, from the clock or from the Run now button. */
function runRoutine(bot: Bot, routine: Routine): void {
  if (inflight.has(bot.id)) {
    toast(`${bot.name} is busy — try again when it has finished`);
    return;
  }

  const was = routine.lastRunAt ?? 0;
  routine.lastRunAt = Date.now();
  // So the notification can say "Build check" rather than "Engineer said
  // something", which is the difference between a notification worth having
  // and one worth switching off.
  fromRoutine.set(bot.id, routine.name);
  // A task, not a routine: it has now happened, and should not happen again.
  if (routine.every === "once") routine.active = false;

  // Reporting into a room rather than into its own chat. Its own path,
  // because the bot speaks there as a member of the channel, from its seat in
  // it, and everyone else in the room sees it happen.
  const into = routine.channel ? channels().find((c) => c.id === routine.channel) : null;
  if (into && into.members.includes(bot.id)) {
    // Since the last one, which is what "what have you been doing" means. The
    // first standup has no last one, so it looks back a day.
    const since = was || Date.now() - 24 * 60 * 60 * 1000;
    if (routine.format === "standup") void runStandup(into, routine, since);
    else if (routine.format === "review") {
      void channelTurn(into, bot, { left: 1 }, reviewPrompt(bot, routine, since, into));
    } else void runRoutineInChannel(bot, routine, into);
    return;
  }

  // Something arrived that nobody typed, so the bot says so before it starts.
  setMood(bot.id, "alert");
  const note: Message = {
    id: uid(),
    from: "me",
    text: routine.instruction,
    at: Date.now(),
    kind: "routine",
    meta: { steps: 0, frames: 0, slug: routine.id, name: routine.name },
  };
  bot.messages.push(note);
  if (bot.id === state.activeId) {
    if (bot.messages.length === 1) thread.innerHTML = "";
    thread.append(turnEl(note, undefined, bot.messages[bot.messages.length - 2]));
    arrived();
  }
  save();
  renderRoster();
  // A review writes its own prompt out of the record; everything else says
  // what you told it to say.
  void respond(
    bot,
    routine.format === "review"
      ? reviewPrompt(bot, routine, was || Date.now() - 7 * 24 * 60 * 60 * 1000)
      : routine.instruction,
  );
}

/** Fire anything due. This runs while the app is open; there is no daemon. */
/** Is this bot on the clock?
 *
 *  A bot with no hours set works whenever, which is what every bot did before
 *  this existed and what most of them should keep doing. A shift that runs
 *  past midnight — 22:00 to 06:00 — is a night shift rather than an empty one,
 *  and the day it belongs to is the day it started.
 */
function onTheClock(bot: Bot, when = new Date()): boolean {
  const hours = bot.hours;
  if (!hours) return true;

  const at = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
  const day = when.getDay();
  const overnight = hours.to <= hours.from;

  if (!overnight) {
    return hours.days.includes(day) && at >= hours.from && at < hours.to;
  }
  // Before the shift ends, it is still yesterday's shift: a Tuesday-night bot
  // is still working at one on Wednesday morning.
  if (at < hours.to) return hours.days.includes((day + 6) % 7);
  return hours.days.includes(day) && at >= hours.from;
}

/** What its hours say, in a line. */
function saysHours(bot: Bot): string {
  const hours = bot.hours;
  if (!hours) return "Any time";
  const days = hours.days.length === 7
    ? "every day"
    : hours.days.length === 5 && [1, 2, 3, 4, 5].every((d) => hours.days.includes(d))
      ? "weekdays"
      : hours.days.map((d) => DAY_NAME[d]).join(", ");
  return `${hours.from}–${hours.to}, ${days}`;
}

function tickRoutines(): void {
  if (!appSettings().routinesOn) return;
  const now = Date.now();

  for (const bot of state.bots) {
    if (inflight.has(bot.id)) continue;
    // Off the clock, a routine waits rather than being missed: nothing here
    // moves `lastRunAt`, so whatever came due overnight is still due when the
    // shift opens and fires once — not once for every half hour it slept
    // through, which is the way to wake up to forty messages.
    if (!onTheClock(bot)) continue;

    for (const routine of bot.routines ?? []) {
      if (!routine.active) continue;

      // A routine with no history schedules from now; it never fires on sight.
      if (!routine.lastRunAt) {
        routine.lastRunAt = now;
        continue;
      }
      if (nextRun(routine, routine.lastRunAt) > now) continue;

      runRoutine(bot, routine);
      break; // at most one routine per bot per tick
    }
  }
}

/* -------------------------------------------------------- the bot's desktop */

const screen: {
  botId: string | null;
  state: SandboxState;
  vncPort: number | null;
  rfb: RFB | null;
  connected: boolean;
  control: boolean;
  log: string[];
  /** Retry timer for connections that drop before the handshake completes. */
  retry: number;
} = {
  botId: null,
  state: "stopped",
  vncPort: null,
  rfb: null,
  connected: false,
  control: false,
  log: [],
  retry: 0,
};

const CONNECT_ATTEMPTS = 6;

/** Native sandbox display size, mirroring SCREEN in the Dockerfile. */
const SCREEN_SIZE = { w: 1440, h: 900 };

/** Recording a demonstration: what you do becomes the bot's prompt. */
const teach: {
  on: boolean;
  arming: boolean;
  name: string;
  slug: string;
  frames: string[];
  steps: string[];
  typed: string;
  grabbing: boolean;
} = { on: false, arming: false, name: "", slug: "", frames: [], steps: [], typed: "", grabbing: false };

const teachName = $<HTMLInputElement>("#teach-name");

/** A name you'd actually type: "Open my X profile" → "open-my-x-profile". */
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Machine-replayable form of the same demonstration. */
type TeachEvent =
  | { t: "click"; x: number; y: number; button: string }
  | { t: "key"; keys: string }
  | { t: "type"; text: string };

let teachEvents: TeachEvent[] = [];

const MAX_FRAMES = 12;

const STATE_LABEL: Record<SandboxState, string> = {
  stopped: "Stopped",
  building: "Building image",
  starting: "Starting",
  running: "Live",
  error: "Failed",
  "no-docker": "Not set up",
  "no-computer": "No computer",
};

const STATE_MESSAGE: Record<SandboxState, string> = {
  stopped:
    "No desktop running for this bot. Starting one gives it a private Linux machine — browser, terminal, files — that only it touches.",
  building:
    "Building the sandbox image. The first run pulls Debian and installs a desktop, so this takes a few minutes; it's cached afterwards.",
  starting: "Waking the desktop…",
  running: "Connecting to the desktop…",
  error: "The desktop didn't come up.",
  // Deliberately says nothing about Docker. botcage brings its own engine and
  // the button under this offers to fetch it, so a list of things to go and
  // install was the app talking somebody out of the answer it already had —
  // in words they may have no reason to know. What it says instead depends on
  // whether botcage can actually supply one here, which `paintScreen` decides.
  "no-docker": "",
  "no-computer":
    "This bot doesn't have a computer. Turn on Own computer in its settings to give it one — routines below work either way.",
};

function pushLog(line: string): void {
  screen.log.push(line);
  paintScreen();
}

/** What to say when there is no machine for a bot to work on.
 *
 *  Two different situations wearing one state. On a platform botcage can serve,
 *  nothing is missing that the button below cannot fetch — so this says what it
 *  is and what it costs, and never the word Docker. Where it cannot, naming an
 *  engine is the only useful thing left to do. */
function noEngineSays(): string {
  if (engine?.supported) {
    return (
      "A bot's computer is a small Linux machine. botcage can set one up for itself — " +
      `about ${engine.downloadMb ?? 0} MB, kept in botcage's own folder, and nothing else on ` +
      "this computer is touched. Everything else works without it."
    );
  }
  return (
    "A bot's computer runs in a Linux container, and botcage cannot set one up on this " +
    "platform. Installing podman or docker from your package manager gives it one. " +
    "Everything else in botcage works without it."
  );
}

function paintScreen(): void {
  const bot = state.bots.find((b) => b.id === screen.botId);
  screenId.innerHTML = bot
    ? `${faceHtml(bot, "sm")}<span>${escapeHtml(bot.name)}'s computer</span>`
    : "";

  const busy = screen.state === "building" || screen.state === "starting";
  const bad = screen.state === "error" || screen.state === "no-docker";
  screenStateEl.textContent = STATE_LABEL[screen.state];
  screenStateEl.className = `state-pill${screen.state === "running" ? " is-live" : busy ? " is-busy" : bad ? " is-bad" : ""}`;

  const live = screen.state === "running" && screen.connected;
  screenIdle.hidden = live;
  controlBtn.hidden = !live;

  $<HTMLDivElement>("#screen-caption").textContent = bot ? `${bot.name}'s screen` : "";

  const teachBtn = $<HTMLButtonElement>("#btn-teach");
  teachBtn.hidden = !live;
  teachBtn.classList.toggle("is-recording", teach.on);
  teachName.hidden = !live || !teach.arming;
  teachBtn.title = teach.on ? "Stop recording" : "Record a demonstration";
  $<HTMLSpanElement>("#btn-teach-label").textContent = teach.on
    ? `Stop (${teachEvents.length} step${teachEvents.length === 1 ? "" : "s"})`
    : teach.arming
      ? "Start recording"
      : "Teach a task";
  $<HTMLButtonElement>("#btn-screen-power").hidden = screen.state !== "running";

  screenMessage.textContent =
    engineStep ||
    (screen.state === "no-docker" ? noEngineSays() : STATE_MESSAGE[screen.state]);

  // With no engine, the useful button is the one that gets you an engine —
  // otherwise the download machinery exists and nobody can reach it.
  const needsEngine = screen.state === "no-docker" && (engine?.supported ?? false);
  startBtn.hidden = !(screen.state === "stopped" || screen.state === "error" || needsEngine);
  startBtn.disabled = installing;
  startBtn.textContent = installing
    ? "Setting up…"
    : needsEngine
      ? `Set up botcage's engine (${engine?.downloadMb ?? 0} MB)`
      : screen.state === "error"
        ? "Try again"
        : "Start desktop";

  screenLog.hidden = screen.log.length === 0;
  screenLog.textContent = screen.log.slice(-40).join("\n");
  screenLog.scrollTop = screenLog.scrollHeight;

  controlLabel.textContent = screen.control ? "You have control" : "View only";
  controlBtn.title = screen.control ? "Give control back to the bot" : "Take control of the desktop";
  controlBtn.classList.toggle("is-on", screen.control);
  controlBtn.querySelector("use")?.setAttribute("href", screen.control ? "#i-hand" : "#i-eye");
}

function disconnectScreen(): void {
  window.clearTimeout(screen.retry);
  screen.retry = 0;
  if (screen.rfb) {
    try {
      screen.rfb.disconnect();
    } catch {
      /* already gone */
    }
  }
  screen.rfb = null;
  screen.connected = false;
  screenCanvas.replaceChildren();
}

function connectScreen(port: number, attempt = 0): void {
  disconnectScreen();
  screen.vncPort = port;

  // No credentials: x11vnc runs password-less behind a loopback-only port.
  const rfb = new RFB(screenCanvas, `ws://127.0.0.1:${port}`, { shared: true });
  rfb.viewOnly = !screen.control;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = "#07070a";

  rfb.addEventListener("connect", () => {
    screen.connected = true;
    paintScreen();
  });
  rfb.addEventListener("disconnect", () => {
    const wasConnected = screen.connected;
    screen.connected = false;
    screen.rfb = null;

    if (wasConnected) {
      pushLog("The desktop connection dropped.");
    } else if (attempt + 1 < CONNECT_ATTEMPTS) {
      // websockify may not be listening yet even though its port answers.
      if (attempt === 0) pushLog("Waiting for the desktop to accept connections…");
      screen.retry = window.setTimeout(() => connectScreen(port, attempt + 1), 1500);
    } else {
      screen.state = "error";
      pushLog(`Could not connect on port ${port} after ${CONNECT_ATTEMPTS} tries.`);
    }
    paintScreen();
  });

  screen.rfb = rfb;
  paintScreen();
}

type EngineSaid = { path: string | null; version: string | null; error: string | null };

/** Make sure there is an engine answering, waking botcage's own if it is asleep.
 *
 *  Installed and asleep is not a state worth reporting. botcage owns this
 *  engine — it put it there, it knows where it is and it is the only program
 *  that can start it — so it starts it. Nobody installs a thing in order to be
 *  told later that it is not running, and on macOS the engine is a VM that
 *  stops whenever the machine sleeps, which makes this the ordinary
 *  first-desktop-of-the-day case rather than a rare one.
 *
 *  Called from both ways in, because there are two: opening the pane, and
 *  pressing the button after something failed. The second used to go straight
 *  to starting a container, so a retry could never fix the thing that had gone
 *  wrong — it re-ran the step after it.
 */
async function wakeEngine(): Promise<EngineSaid> {
  let said = await invoke<EngineSaid>("docker_info");
  if (said.version) return said;

  engine = await invoke<EngineStatus>("engine_status").catch(() => null);
  if (!engine?.installed || !engine.needsVm || engine.vmRunning) return said;

  engineStep = "Waking botcage's engine…";
  paintScreen();
  try {
    await invoke("start_engine");
    engine = await invoke<EngineStatus>("engine_status").catch(() => engine);
    said = await invoke<EngineSaid>("docker_info");
  } catch {
    // Left to the caller, which offers to set one up. A start that fails is
    // not worth its own screen when the next thing to try is what that screen
    // already does.
  } finally {
    engineStep = "";
  }
  return said;
}

async function openScreen(): Promise<void> {
  const bot = activeBot();
  if (!bot) return;


  screen.botId = bot.id;
  screen.log = [];
  screen.control = false;
  screen.state = "stopped";
  // The other way round from showSheet: they share one column, so whichever
  // is asked for puts the other away.
  if (!sheetWrap.hidden) showSheet(false);
  screenPane.hidden = false;
  appEl.classList.add("has-screen");
  state.screenOpen = true;
  relayout();
  save();
  paintScreen();

  if (!bot.computer) {
    screen.state = "no-computer";
    paintScreen();
    return;
  }

  const docker = await wakeEngine();
  if (!docker.version) {
    // Ask whether botcage could supply one itself, so the pane can offer that
    // rather than only naming things to go and install.
    engine = await invoke<EngineStatus>("engine_status").catch(() => null);
    screen.state = "no-docker";
    // Only when botcage cannot supply one itself. Where it can, the message
    // above already says what will happen and the button below does it — and
    // the engine's own words underneath them say the same thing a third time,
    // in the vocabulary this pane is trying not to use.
    screen.log = !engine?.supported && docker.error ? [docker.error] : [];
    paintScreen();
    return;
  }

  const status = await invoke<{ state: SandboxState; vncPort: number | null; controlPort: number | null }>(
    "sandbox_status",
    { botId: bot.id },
  );
  screen.state = status.state;
  paintScreen();
  if (status.state === "running" && status.vncPort) connectScreen(status.vncPort);
}

function closeScreen(): void {
  disconnectScreen();
  screenPane.hidden = true;
  appEl.classList.remove("has-screen");
  screen.botId = null;
  state.screenOpen = false;
  relayout();
  save();
}

function handleSandboxEvent(event: SandboxEvent): void {
  if (event.botId === "app") {
    if (event.text) toast(event.text);
    return;
  }
  if (event.botId !== screen.botId) return;

  if (event.kind === "log") {
    if (event.text) pushLog(event.text);
    return;
  }
  screen.state = event.state ?? screen.state;
  if (event.state === "running" && event.vncPort) connectScreen(event.vncPort);
  else if (event.state !== "running") disconnectScreen();
  paintScreen();
}

function setPaneWidth(px: number): void {
  const width = Math.min(SCREEN_PANE.max, Math.max(SCREEN_PANE.min, Math.round(px)));
  appEl.style.setProperty("--screen-w", `${width}px`);
  state.screenWidth = width;
}

function setPaneHeight(px: number): void {
  const height = Math.min(SCREEN_ROW.max, Math.max(SCREEN_ROW.min, Math.round(px)));
  appEl.style.setProperty("--screen-h", `${height}px`);
  state.screenHeight = height;
}

const isStacked = () => appEl.classList.contains("is-stacked");

/** Rail and stacking follow the room available, not a fixed window size — a
    collapsed sidebar can buy back enough width to stay side by side. */
function relayout(): void {
  const railed = Boolean(state.railed) || appEl.clientWidth < RAIL_AT;
  appEl.classList.toggle("is-rail", railed);

  // Both of these are `--sidebar-w` in the stylesheet, which this cannot read;
  // the rail was widened to 92 there and this still said 66, so the width left
  // for the conversation was being over-estimated by twenty-six points.
  const sidebar = railed ? 92 : 268;

  // One column, one width, whichever of the two is in it. Giving the settings
  // pane a width of its own meant it and the computer crossed the stacking
  // threshold at different window sizes — so on one window the computer opened
  // beside the conversation and settings opened underneath it.
  const anyPane = !screenPane.hidden || !sheetWrap.hidden;
  const pane = anyPane ? (state.screenWidth ?? SCREEN_PANE.initial) : 0;
  const chatWidth = appEl.clientWidth - sidebar - pane;
  appEl.classList.toggle("is-stacked", anyPane && chatWidth < MIN_CHAT_WIDTH);

  $<HTMLButtonElement>("#btn-rail").title = railed ? "Expand sidebar  (⌘B)" : "Collapse sidebar  (⌘B)";
}

function toggleRail(): void {
  state.railed = !state.railed;
  save();
  relayout();
}

screenGrip.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  screenGrip.setPointerCapture(event.pointerId);
  const drag = (move: PointerEvent) =>
    isStacked()
      ? setPaneHeight(window.innerHeight - move.clientY)
      : setPaneWidth(window.innerWidth - move.clientX);
  const drop = () => {
    screenGrip.removeEventListener("pointermove", drag);
    screenGrip.removeEventListener("pointerup", drop);
    relayout();
    save();
  };
  screenGrip.addEventListener("pointermove", drag);
  screenGrip.addEventListener("pointerup", drop);
});

// noVNC only recomputes its scale on window resize, so nudge it whenever the
// pane itself changes size — dragging the grip, or the pane opening.
new ResizeObserver(() => {
  if (screen.rfb && screen.connected) screen.rfb.scaleViewport = true;
}).observe(screenCanvas);

// Re-evaluate rail and stacking whenever the window changes size.
new ResizeObserver(() => relayout()).observe(appEl);

/* ------------------------------------------------------------ teach a task */

/** Panel coordinates → real screen pixels, since the canvas is scaled to fit. */
function remotePoint(event: PointerEvent): { x: number; y: number } | null {
  const canvas = screenCanvas.querySelector("canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.round(((event.clientX - rect.left) / rect.width) * SCREEN_SIZE.w),
    y: Math.round(((event.clientY - rect.top) / rect.height) * SCREEN_SIZE.h),
  };
}

/** Flush buffered keystrokes into one readable "type" step. */
function flushTyped(): void {
  if (!teach.typed) return;
  teach.steps.push(`type \`${teach.typed}\``);
  teachEvents.push({ t: "type", text: teach.typed });
  teach.typed = "";
}

async function grabFrame(): Promise<void> {
  if (!teach.on || teach.grabbing || teach.frames.length >= MAX_FRAMES) return;
  const botId = screen.botId;
  if (!botId) return;

  teach.grabbing = true;
  try {
    const path = await invoke<string>("teach_capture", {
      botId,
      slug: teach.slug,
      index: teach.frames.length + 1,
    });
    teach.frames.push(path);
    teach.steps.push(`_(frame ${teach.frames.length}: ${path})_`);
  } catch (err) {
    pushLog(`Frame capture failed: ${String(err)}`);
  } finally {
    teach.grabbing = false;
  }
}

function onTeachPointer(event: PointerEvent): void {
  const point = remotePoint(event);
  if (!point) return;
  flushTyped();
  // Frame first: what the screen looked like when the decision was made.
  void grabFrame().then(() => {
    const button = event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
    const label = button === "left" ? "click" : `${button}-click`;
    teach.steps.push(`${label} at (${point.x}, ${point.y})`);
    teachEvents.push({ t: "click", x: point.x, y: point.y, button });
  });
}

function onTeachKey(event: KeyboardEvent): void {
  if (event.key === "Escape") return; // handled by the global shortcut

  const chord = [event.metaKey && "cmd", event.ctrlKey && "ctrl", event.altKey && "alt"]
    .filter(Boolean)
    .join("+");

  if (event.key.length === 1 && !chord) {
    teach.typed += event.key;
    return;
  }

  flushTyped();
  const named = chord ? `${chord}+${event.key}` : event.key;
  teach.steps.push(`press \`${named}\``);
  teachEvents.push({ t: "key", keys: named === "Enter" ? "Return" : named });
  if (event.key === "Enter") void grabFrame();
}

function armTeaching(): void {
  if (!screen.connected) return;
  teach.arming = true;
  paintScreen();
  teachName.value = "";
  teachName.focus();
}

function cancelArming(): void {
  teach.arming = false;
  paintScreen();
}

function startTeaching(): void {
  const bot = state.bots.find((b) => b.id === screen.botId);
  if (!bot || !screen.connected) return;

  teach.on = true;
  teach.arming = false;
  teach.name = teachName.value.trim();
  teach.slug =
    slugify(teach.name) || `task-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
  teach.frames = [];
  teach.steps = [];
  teach.typed = "";
  teachEvents = [];

  // Teaching means driving it yourself, so control is implied.
  screen.control = true;
  if (screen.rfb) {
    screen.rfb.viewOnly = false;
    screen.rfb.focus();
  }

  screenCanvas.addEventListener("pointerdown", onTeachPointer, true);
  document.addEventListener("keydown", onTeachKey, true);

  void grabFrame();
  paintScreen();
  toast(
    teach.name
      ? `Recording "${teach.name}" — show the bot what to do, then press Stop`
      : "Recording — show the bot what to do, then press Stop",
  );
}

async function stopTeaching(): Promise<void> {
  if (!teach.on) return;
  const botId = screen.botId;
  const bot = state.bots.find((b) => b.id === botId);

  screenCanvas.removeEventListener("pointerdown", onTeachPointer, true);
  document.removeEventListener("keydown", onTeachKey, true);
  flushTyped();
  await grabFrame();
  teach.on = false;
  paintScreen();

  if (!botId || !bot) return;
  if (teach.steps.length === 0) {
    toast("Nothing recorded");
    return;
  }

  const log =
    `# Demonstration\n\n` +
    `Recorded on ${bot.name}'s desktop at ${SCREEN_SIZE.w}x${SCREEN_SIZE.h}. ` +
    `Coordinates are real screen pixels, origin top-left. Frames are in this folder.\n\n` +
    teach.steps.map((step, i) => `${i + 1}. ${step}`).join("\n") +
    `\n`;

  let dir = `teach/${teach.slug}`;
  try {
    dir = await invoke<string>("teach_save", {
      botId,
      slug: teach.slug,
      steps: log,
      events: JSON.stringify(
        { screen: SCREEN_SIZE, recordedAt: new Date().toISOString(), events: teachEvents },
        null,
        2,
      ),
    });
  } catch (err) {
    toast(`Could not save the demonstration: ${String(err)}`);
    return;
  }

  closeScreen();

  const named = teach.name
    ? `I call this task "${teach.name}".`
    : `I did not name it — pick a short name for it yourself and write that name, alone, to ` +
      `./${dir}/name.txt so the app can label it.`;

  const prompt =
    `I recorded a demonstration on your desktop — learn the task from it. ${named}\n\n` +
    `Start with ./${dir}/steps.md: every click and keystroke in order, with real screen ` +
    `coordinates. That is usually enough on its own. There are also ${teach.frames.length} ` +
    `screenshots (frame-01…${String(teach.frames.length).padStart(2, "0")}.png) — each one costs a lot ` +
    `of context, so open only the ones where the log leaves you guessing what was on screen, and ` +
    `skip the rest.\n\n` +
    `Then write the procedure to tasks/${teach.slug}.md and add one line to CLAUDE.md's Memory ` +
    `section pointing at it. Prefer exec where a shell beats clicking. To repeat the demonstration ` +
    `exactly, you can call the desktop \`replay\` tool with slug "${teach.slug}" instead of ` +
    `re-deriving the clicks — it costs nothing and is deterministic.\n\n` +
    `Reply with a short paragraph: what the task is, how you would do it, and anything you need ` +
    `from me.`;

  const msg: Message = {
    id: uid(),
    from: "me",
    text: prompt,
    at: Date.now(),
    kind: "teach",
    meta: {
      steps: teachEvents.length,
      frames: teach.frames.length,
      slug: teach.slug,
      name: teach.name || undefined,
    },
  };
  bot.messages.push(msg);
  if (bot.messages.length === 1) thread.innerHTML = "";
  thread.append(turnEl(msg, undefined, bot.messages[bot.messages.length - 2]));
  save();
  void respond(bot, prompt);
}

/* -------------------------------------------------------------------- wiring */

$<HTMLButtonElement>("#btn-teach").addEventListener("click", () => {
  if (teach.on) void stopTeaching();
  else if (teach.arming) startTeaching();
  else armTeaching();
});

teachName.addEventListener("keydown", (event) => {
  event.stopPropagation(); // typing a name is not a shortcut
  if (event.key === "Enter") startTeaching();
  else if (event.key === "Escape") cancelArming();
});

$<HTMLButtonElement>("#btn-screen-close").addEventListener("click", closeScreen);

startBtn.addEventListener("click", () => {
  // No engine means the desktop cannot start at all, so this button installs one
  // first rather than failing the same way twice.
  if (screen.state === "no-docker" && engine?.supported && !engine.installed) {
    void setUpEngine();
    return;
  }

  const botId = screen.botId;
  if (!botId) return;
  const bot = state.bots.find((b) => b.id === botId);
  screen.log = [];
  screen.state = "starting";
  paintScreen();
  // Before anything else: the reason the last attempt failed may be that the
  // engine went to sleep, and starting a container in an engine that is not
  // running fails the same way for ever. "Try again" has to be able to fix the
  // step that broke, not repeat the one after it.
  void wakeEngine().then(() => invoke("sandbox_start", {
    botId,
    brand: {
      name: bot?.name ?? "",
      color: bot?.color ?? "",
      // Read from this machine rather than hardcoded, so a desktop matches
      // whatever host it is running on.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
      locale: navigator.language ?? "",
      network: bot?.network ?? "full",
      github: (bot?.plugins ?? []).includes("github"),
      ...machineBrand(bot),
    },
  })).catch((err) => {
    screen.state = "error";
    pushLog(String(err));
  });
});

$<HTMLButtonElement>("#btn-screen-power").addEventListener("click", () => {
  const botId = screen.botId;
  if (!botId) return;
  disconnectScreen();
  screen.state = "stopped";
  paintScreen();
  void invoke("sandbox_stop", { botId }).catch((err) => pushLog(String(err)));
});

$<HTMLButtonElement>("#btn-expand").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const focused = screenPane.classList.toggle("is-focus");
  button.title = focused ? "Shrink the screen" : "Expand the screen";
});

controlBtn.addEventListener("click", () => {
  screen.control = !screen.control;
  if (screen.rfb) {
    screen.rfb.viewOnly = !screen.control;
    if (screen.control) screen.rfb.focus();
  }
  paintScreen();
});

composer.addEventListener("submit", (e) => {
  e.preventDefault();

  // In a room, stop whoever is talking in it. `activeBot` is whichever bot's
  // chat you last had open, which in a channel is very likely not one of the
  // people speaking — so the button turned into a stop button and then either
  // did nothing or cancelled a turn in another window entirely.
  const room = activeChannel();
  if (room) {
    const talking = [...inflight].filter(([, p]) => p.channelId === room.id);
    if (talking.length) {
      hushed.add(room.id);
      for (const [botId] of talking) cancelTurn(botId);
      return;
    }
  } else {
    const bot = activeBot();
    if (bot && inflight.has(bot.id)) {
      cancelTurn(bot.id);
      return;
    }
  }

  if (!input.value.trim()) return;
  send(input.value);
});

input.addEventListener("input", autoGrow);


/* --------------------------------------------------------- mentioning them */
/* Typing "@" in a room offers the people in it. The name has to match exactly
   for the message to reach anybody, and expecting someone to remember and
   spell "Research and Writing" is how a feature that works becomes a feature
   nobody uses. */

const mentionsEl = $<HTMLDivElement>("#mentions");

/** Something you can put after an "@": one of the room's members, or the room
 *  itself. Both are a name and a line about what picking it does, so the list
 *  does not need to know which kind it is holding. */
interface Mention {
  name: string;
  hint: string;
  bot?: Bot;
  /** A shortcut rather than a name: written with a leading "/" and, in a room,
   *  preceded by the bot it belongs to — a command is a job somebody does, so
   *  saying it without saying whose is talking to the room. */
  command?: boolean;
}

let mentionHits: Mention[] = [];
let mentionPick = 0;

/** The "@…" being typed at the caret, if there is one.
 *
 *  Spaces are allowed in the query because names have spaces in them. That
 *  would run away over a whole sentence, so it is bounded twice: a couple of
 *  dozen characters, and — in `paintMentions` — the fact that nothing matching
 *  closes the list. Type "@" mid-sentence and you get the list; carry on
 *  typing prose and it goes away by itself. */
function mentionQuery(): { at: number; query: string } | null {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // It has to start a word — an email address is not a mention.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 24 || query.includes("\n")) return null;
  return { at, query };
}

/** The "/…" being typed, if the message starts with one.
 *
 *  Only at the very beginning. A slash anywhere else is a path, a date or a
 *  fraction, and offering a menu of commands in the middle of "src/main.ts" is
 *  the kind of help that has to be dismissed. Discord draws the same line for
 *  the same reason. */
function commandQuery(): { at: number; query: string } | null {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  if (!before.startsWith("/")) return null;
  const typed = before.slice(1);
  // A space ends it: past that you are writing the message, not the name.
  if (/\s/.test(typed) || typed.length > 24) return null;
  return { at: 0, query: typed };
}

/** Every shortcut on offer where you are typing, and whose it is. */
function commandsHere(): Mention[] {
  const room = activeChannel();
  const here = room ? membersOf(room) : [activeBot()].filter((b): b is Bot => Boolean(b));
  return here.flatMap((bot) =>
    (bot.commands ?? []).map((one) => ({
      name: one.name,
      // Whose, in a room. In a chat there is only one answer and saying it
      // every line is noise.
      hint: room ? `${bot.name} — ${one.what}` : one.what,
      bot,
      command: true,
    })),
  );
}

function closeMentions(): void {
  mentionsEl.hidden = true;
  mentionHits = [];
  mentionPick = 0;
}

function paintMentions(): void {
  const room = activeChannel();

  // A slash at the start of the line is a shortcut, and it works in a chat as
  // well as a room — unlike "@", which needs somebody else to be there.
  const slash = commandQuery();
  if (slash) {
    const q = slash.query.toLowerCase();
    const all = commandsHere();
    const starts = all.filter((one) => one.name.startsWith(q));
    const rest = all.filter((one) => !starts.includes(one) && q && one.name.includes(q));
    mentionHits = [...starts, ...rest];
    if (!mentionHits.length) return closeMentions();
    mentionPick = Math.min(mentionPick, mentionHits.length - 1);
    paintMentionList();
    return;
  }

  const found = room ? mentionQuery() : null;
  if (!room || !found) return closeMentions();

  const q = found.query.toLowerCase();
  const here = membersOf(room);
  const offered: Mention[] = here.map((bot) => ({
    name: bot.name,
    hint: bot.role ? bot.role.split("\n")[0].slice(0, 60) : "",
    bot,
  }));

  // The room itself, last: it is the loudest thing in the list and putting it
  // first would make it the thing you hit by reflex. Only where there is a
  // room to call — in a one-bot channel it is a longer way to say its name.
  if (here.length > 1) {
    offered.push({
      name: "everyone",
      hint: `Bring in all ${here.length} — ${here.map((b) => b.name).join(", ")}`,
    });
  }

  // What you have typed first, then anything else containing it: someone who
  // types "writ" means Research and Writing, and a list that refuses to find
  // it is worse than no list.
  const starts = offered.filter((m) => m.name.toLowerCase().startsWith(q));
  const rest = offered.filter(
    (m) => !starts.includes(m) && q.length > 0 && m.name.toLowerCase().includes(q),
  );
  mentionHits = [...starts, ...rest];
  if (!mentionHits.length) return closeMentions();

  mentionPick = Math.min(mentionPick, mentionHits.length - 1);
  paintMentionList();
}

/** Draw whatever is on offer — names or shortcuts, which look the same because
 *  they are the same gesture: type a character, pick from a list, carry on. */
function paintMentionList(): void {
  mentionsEl.innerHTML = mentionHits
    .map(
      (m, i) =>
        `<button type="button" class="mention${i === mentionPick ? " is-on" : ""}` +
        `${m.bot ? "" : " mention--all"}" data-pick="${i}">` +
        (m.bot ? faceHtml(m.bot, "sm") : `<span class="mention__all">${icon("people")}</span>`) +
        `<span class="mention__name">${m.command ? "/" : ""}${escapeHtml(m.name)}</span>` +
        (m.hint ? `<span class="mention__role">${escapeHtml(m.hint)}</span>` : "") +
        `</button>`,
    )
    .join("");
  mentionsEl.hidden = false;
  mentionsEl.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
}

function acceptMention(pick: Mention): void {
  if (pick.command) return acceptCommand(pick);
  const found = mentionQuery();
  if (!found) return closeMentions();
  const caret = input.selectionStart ?? input.value.length;
  const head = input.value.slice(0, found.at);
  const tail = input.value.slice(caret);
  // The trailing space is the point: the next thing you type is the message,
  // not more of the name.
  const written = `@${pick.name} `;
  input.value = head + written + tail;
  const pos = head.length + written.length;
  input.setSelectionRange(pos, pos);
  closeMentions();
  autoGrow();
  input.focus();
}

/** Writing a shortcut into the message.
 *
 *  In a room it is preceded by the bot it belongs to. A command is a job
 *  somebody does, and "/log" said into a room of five is a message addressed
 *  to nobody — the mention is what routes it, exactly as it would be if you
 *  had typed the whole request out.
 *
 *  Nothing is sent. The name is the beginning of a message, not the whole of
 *  one: most commands take a few words after them, and the ones that do not
 *  cost a press of Enter. */
function acceptCommand(pick: Mention): void {
  const found = commandQuery();
  if (!found) return closeMentions();
  const caret = input.selectionStart ?? input.value.length;
  const tail = input.value.slice(caret);
  const whose = activeChannel() && pick.bot ? `@${pick.bot.name} ` : "";
  const written = `${whose}/${pick.name} `;
  input.value = written + tail;
  input.setSelectionRange(written.length, written.length);
  closeMentions();
  autoGrow();
  input.focus();
}

// mousedown rather than click, with the default prevented: the composer keeps
// focus, so the caret is still where the name has to go.
mentionsEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
  if (pick) acceptMention(mentionHits[Number(pick.dataset.pick)]);
});

input.addEventListener("input", paintMentions);
// Moving the caret changes what is being typed at, and so does clicking into
// the middle of a line.
input.addEventListener("click", paintMentions);
input.addEventListener("keyup", (e) => {
  if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") paintMentions();
});
input.addEventListener("blur", closeMentions);

input.addEventListener("keydown", (e) => {
  // The list owns these keys while it is open. Enter especially: it means
  // "that one", and sending the message with a half-typed name in it is the
  // one thing this is here to prevent.
  if (!mentionsEl.hidden && mentionHits.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      mentionPick = (mentionPick + step + mentionHits.length) % mentionHits.length;
      paintMentions();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptMention(mentionHits[mentionPick]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMentions();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});

$<HTMLButtonElement>("#btn-routines").addEventListener("click", () => {
  // The clock in a bot's header is that bot's own calendar, even if you arrived
  // at the shared one from the account menu and then clicked a bot.
  const back = routinesOpen && !calEveryone;
  calEveryone = false;
  showRoutines(!back);
});

$<HTMLButtonElement>("#btn-settings").addEventListener("click", () => {
  const room = activeChannel();
  if (room) return openChannelSheet(room);
  const bot = activeBot();
  if (bot) openSheet(bot);
});

$<HTMLButtonElement>("#btn-monitor").addEventListener("click", () => {
  if (screenPane.hidden) void openScreen();
  else closeScreen();
});
$<HTMLButtonElement>("#btn-new").addEventListener("click", (event) => {
  // One plus, two things it could make. A menu rather than a second icon in a
  // two-icon header: "new" is one intention, and which kind is the question it
  // is already asking.
  openMenu(
    event.currentTarget as HTMLElement,
    `<button type="button" class="menu-item" data-new="bot">${icon("plus")}New bot</button>` +
      `<button type="button" class="menu-item" data-new="channel">${icon("hash")}New channel</button>` +
      `<button type="button" class="menu-item" data-new="category">${icon("chev")}New category</button>`,
  );
});

menu.addEventListener("click", (event) => {
  const pick = (event.target as HTMLElement).closest<HTMLElement>("[data-new]");
  if (!pick) return;
  closeMenu();
  if (pick.dataset.new === "channel") openChannelSheet(null);
  else if (pick.dataset.new === "category") newCategory();
  else openSheet();
});

$<HTMLButtonElement>("#btn-account").addEventListener("click", (event) => {
  openMenu(
    event.currentTarget as HTMLElement,
      `<button type="button" class="menu-item" data-app="calendar">${icon("clock")}` +
      `<span class="menu-item__body"><span class="menu-item__name">Calendar</span></span></button>` +
      `<button type="button" class="menu-item" data-app="settings">${icon("gear")}` +
      `<span class="menu-item__body"><span class="menu-item__name">Settings</span></span></button>` +
      `<button type="button" class="menu-item" data-app="tour">${icon("eye")}` +
      `<span>Show me around</span></button>` +
      `<button type="button" class="menu-item" data-app="setup">${icon("hand")}` +
      `<span class="menu-item__body"><span class="menu-item__name">Setup</span></span></button>` +
      `<button type="button" class="menu-item" data-app="about">${icon("cube")}` +
      `<span class="menu-item__body"><span class="menu-item__name">About</span></span></button>`,
    "menu--account",
  );
});

$<HTMLButtonElement>("#btn-call").addEventListener("click", () => {
  const room = activeChannel();
  if (room) return void startGroupCall(room);
  const bot = activeBot();
  if (bot) void startCall(bot);
});

$<HTMLButtonElement>("#call-end").addEventListener("click", endCall);

// Held, not toggled. A press-to-start-press-to-stop button leaves a microphone
// live in a room you have walked out of; holding one cannot.
const talkBtn = $<HTMLButtonElement>("#call-talk");
talkBtn.addEventListener("mousedown", startListening);
talkBtn.addEventListener("mouseup", stopListening);
talkBtn.addEventListener("mouseleave", () => {
  if (call?.listening) stopListening();
});

// Space does the same, because reaching for a button to say one sentence is
// the thing that stops people using it.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || !call || callEl.hidden || e.repeat) return;
  const typing = document.activeElement;
  if (typing instanceof HTMLInputElement || typing instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  startListening();
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && call?.listening) stopListening();
});



$<HTMLButtonElement>("#btn-plugins").addEventListener("click", () => void openPlugins());

$<HTMLButtonElement>("#btn-rail").addEventListener("click", toggleRail);

// In rail mode the search box is just an icon; clicking it opens the sidebar.
$<HTMLDivElement>(".field").addEventListener("click", () => {
  if (!appEl.classList.contains("is-rail")) return;
  state.railed = false;
  save();
  relayout();
  searchEl.focus();
});

searchEl.addEventListener("input", renderRoster);

botsEl.addEventListener("click", (e) => {
  const room = (e.target as HTMLElement).closest<HTMLElement>("[data-channel]");
  if (room) return openChannel(room.dataset.channel!);
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-bot]");
  if (row) openBot(row.dataset.bot!);
});

botsEl.addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-bot]");
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.bot!;
  openMenu(
    row,
    `<button type="button" class="menu-item" data-settings="${id}">${icon("sidebar")}Bot settings</button>` +
      `<button type="button" class="menu-item" data-rebuild="${id}">${icon("power")}Rebuild desktop</button>` +
      `<button type="button" class="menu-item" data-clear="${id}">${icon("refresh")}Clear thread</button>` +
      `<button type="button" class="menu-item" data-remove="${id}">${icon("trash")}Delete bot</button>`,
  );
});

// The guide's lessons, which sit in the thread. This was briefly wired to the
// account menu's listener, where it was a handler for a click that could never
// arrive there.
thread.addEventListener("click", (e) => {
  const lesson = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-lesson]");
  if (!lesson) return;
  const found = LESSONS.find((l) => l.id === lesson.dataset.lesson);
  if (found) startTour(found.stops);
});

thread.addEventListener("click", (e) => {
  const open = (e.target as HTMLElement).closest<HTMLElement>("[data-open-thread]");
  if (open?.dataset.openThread) openChannel(open.dataset.openThread);
});

/** Clicking a face opens the bot behind it.
 *
 *  Anywhere a face appears in a conversation: the one at the head of a run, and
 *  the ones peeking out of a room's header. Not the roster, where a row already
 *  means "open this bot" and a face inside it would mean something else.
 */
function openCard(face: HTMLElement): boolean {
  const bot = state.bots.find((b) => b.id === face.dataset.bot);
  if (!bot) return false;
  openMenu(face, cardHtml(bot), "menu--card");
  return true;
}

thread.addEventListener("click", (e) => {
  const face = (e.target as HTMLElement).closest<HTMLElement>(".face[data-bot]");
  if (face) openCard(face);
});

$<HTMLElement>("#topbar-id").addEventListener("click", (e) => {
  const face = (e.target as HTMLElement).closest<HTMLElement>(".face[data-bot]");
  if (face) openCard(face);
});

/** Pressing one of a bot's answers, from wherever it was pressed.
 *
 *  It is sent as though you had typed it, because that is what it is: the
 *  words are the bot's suggestion of what you would have written, and the bot
 *  reading its own suggestion back needs no protocol to understand it.
 *
 *  Where matters, because the desk can answer a question in a conversation
 *  that is not open — so this goes there first rather than assuming the answer
 *  belongs wherever you happen to be looking. */
function answerAsk(
  at: { botId?: string; channelId?: string; messageId?: string },
  answer: string,
): void {
  const room = at.channelId ? channels().find((c) => c.id === at.channelId) : undefined;
  const bot = at.botId ? state.bots.find((b) => b.id === at.botId) : undefined;
  const msg = (room ? room.messages : (bot?.messages ?? [])).find((m) => m.id === at.messageId);
  if (!msg?.ask || msg.ask.answered) return;
  // Whatever was pressed has to be one of the answers offered: a desk drawn a
  // few seconds ago must not be able to put words in your mouth.
  if (!msg.ask.options.includes(answer)) return;

  if (!claudeReady) {
    toast("Claude Code CLI not found — install it to talk to your bots");
    return;
  }

  // Marked before sending: the reply that comes back re-renders everything,
  // and a row still offering its buttons underneath invites a second press.
  msg.ask.answered = answer;
  save();

  // Sent where the question was, without going there. Answering from the desk
  // is meant to clear the list, and a jump into the conversation after each
  // press means walking back for the next one — the list is the place you are,
  // and the item leaving it is the whole of what you asked for.
  if (room) {
    postToChannel(room, answer);
  } else if (bot && !inflight.has(bot.id)) {
    const said: Message = { id: uid(), from: "me", text: answer, at: Date.now() };
    bot.messages.push(said);
    save();
    void respond(bot, answer);
  }
  redrawConversation();
  renderRoster();
  if (deskOpen) renderDesk();
}

thread.addEventListener("click", (e) => {
  const pick = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-ask]");
  if (!pick?.dataset.answer) return;
  const room = activeChannel();
  answerAsk(
    room
      ? { channelId: room.id, messageId: pick.dataset.ask }
      : { botId: activeBot()?.id, messageId: pick.dataset.ask },
    pick.dataset.answer,
  );
});

thread.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  if (target.closest(".code__copy")) {
    const code = target.closest(".code")?.querySelector("code");
    if (code) copy(code.textContent ?? "");
    return;
  }

  const more = target.closest<HTMLButtonElement>(".more-btn");
  if (more) {
    const bubble = more.closest(".bubble")!;
    const open = bubble.classList.toggle("is-open");
    bubble.classList.toggle("is-clamped", !open);
    more.innerHTML = `${open ? "Show less" : "Show more"} ${icon("chev")}`;
    return;
  }

  const btn = target.closest<HTMLButtonElement>("[data-act]");
  if (!btn) return;
  const turn = btn.closest<HTMLElement>("[data-msg]")!;
  const found = messageAt(turn.dataset.msg ?? "");
  if (!found) return;
  const { msg } = found;

  switch (btn.dataset.act) {
    case "copy":
      copy(msg.text);
      break;
    case "retry":
      // Only in a bot's own thread: rerunning one turn in a room would have to
      // decide what happens to everything said after it.
      if (!found.room) retry(msg.id);
      else toast("Ask again in the channel instead");
      break;
    case "reply":
      input.value = `${msg.text
        .split("\n")
        .slice(0, 2)
        .map((l) => `> ${l}`)
        .join("\n")}\n\n`;
      autoGrow();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      break;
    case "react":
      openMenu(
        btn,
        ["👍", "❤️", "😂", "🎉", "🤔"]
          .map((e2) => `<button type="button" data-emoji="${e2}" data-for="${msg.id}">${e2}</button>`)
          .join(""),
        "menu--emoji",
      );
      break;
    case "more":
      openMenu(
        btn,
        `<button type="button" class="menu-item" data-copy="${msg.id}">${icon("copy")}Copy text</button>` +
          `<button type="button" class="menu-item" data-pin="${msg.id}">${icon("pin")}` +
          `${msg.pinned ? "Unpin" : "Pin"} message</button>` +
          (found.room
            ? `<button type="button" class="menu-item" data-thread="${msg.id}">${icon("reply")}` +
              `Start a thread</button>`
            : "") +
          `<button type="button" class="menu-item" data-del="${msg.id}">${icon("trash")}Delete message</button>`,
      );
      break;
  }
});

menu.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  const app = target.closest<HTMLButtonElement>("[data-app]")?.dataset.app;
  if (app) {
    closeMenu();
    if (app === "calendar") openCalendar();
    else if (app === "settings") void openAppSettings();
    else if (app === "tour") startTour();
    else if (app === "setup") void openSetup(appSettings().onboarded ? "answers" : "welcome");
    else void openAbout();
    return;
  }


  const bot = activeBot();

  const emoji = target.closest<HTMLButtonElement>("[data-emoji]");
  if (emoji && bot) {
    const msg = bot.messages.find((m) => m.id === emoji.dataset.for);
    if (msg) {
      msg.reaction = msg.reaction === emoji.dataset.emoji ? undefined : emoji.dataset.emoji;
      // It notices. Only when one is put on rather than taken off, and only on
      // something it said — a reaction on your own message is you talking to
      // yourself.
      if (msg.reaction && msg.from === "bot") setMood(bot.id, "nod");
      save();
      renderThread();
    }
  }

  // The two ways out of a profile card: into the conversation, or into the
  // settings the card is a read-only view of.
  const card = target.closest<HTMLButtonElement>("[data-card-open], [data-card-settings]");
  if (card) {
    const wanted = card.dataset.cardOpen ?? card.dataset.cardSettings ?? "";
    closeMenu();
    if (card.dataset.cardSettings) openSheet(state.bots.find((b) => b.id === wanted) ?? null);
    else openBot(wanted);
    return;
  }

  const copyItem = target.closest<HTMLButtonElement>("[data-copy]");
  if (copyItem) {
    const found = messageAt(copyItem.dataset.copy ?? "");
    if (found) copy(found.msg.text);
  }

  const pin = target.closest<HTMLButtonElement>("[data-pin]");
  if (pin) {
    const found = messageAt(pin.dataset.pin ?? "");
    if (found) {
      found.msg.pinned = !found.msg.pinned;
      save();
      redrawConversation();
      toast(found.msg.pinned ? "Pinned" : "Unpinned");
    }
  }

  const startThread = target.closest<HTMLButtonElement>("[data-thread]");
  if (startThread) {
    const found = messageAt(startThread.dataset.thread ?? "");
    if (found?.room) openThreadFrom(found.room, found.msg);
  }

  const del = target.closest<HTMLButtonElement>("[data-del]");
  if (del) {
    const found = messageAt(del.dataset.del ?? "");
    if (found?.room) found.room.messages = found.room.messages.filter((m) => m.id !== found.msg.id);
    else if (found?.bot) found.bot.messages = found.bot.messages.filter((m) => m.id !== found.msg.id);
    save();
    renderRoster();
    redrawConversation();
  }

  const clear = target.closest<HTMLButtonElement>("[data-clear]");
  if (clear) {
    const target2 = state.bots.find((b) => b.id === clear.dataset.clear);
    if (target2) {
      if (inflight.has(target2.id)) cancelTurn(target2.id);
      target2.messages = [];
      // A fresh session for an engine that keeps its own conversation, and the
      // transcript dropped for one that does not. Both, because a bot may have
      // changed engines since: clearing has to mean cleared either way.
      target2.sessionId = newSessionId();
      target2.started = false;
      void invoke("clear_thread", { botId: target2.id }).catch(() => {});
      save();
      renderRoster();
      renderThread();
    }
  }

  const settings = target.closest<HTMLButtonElement>("[data-settings]");
  if (settings) {
    const subject = state.bots.find((b) => b.id === settings.dataset.settings);
    if (subject) {
      closeMenu();
      openSheet(subject);
      return;
    }
  }

  const rebuild = target.closest<HTMLButtonElement>("[data-rebuild]");
  if (rebuild) {
    const subject = state.bots.find((b) => b.id === rebuild.dataset.rebuild);
    if (subject) {
      closeMenu();
      toast(`Rebuilding ${subject.name}'s desktop — its files are kept`);
      void invoke("sandbox_rebuild", {
        botId: subject.id,
        brand: {
          name: subject.name,
          color: subject.color,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          locale: navigator.language ?? "",
          network: subject.network,
          github: (subject.plugins ?? []).includes("github"),
          ...machineBrand(subject),
        },
      }).catch((err) => toast(String(err)));
      return;
    }
  }

  const remove = target.closest<HTMLButtonElement>("[data-remove]");
  if (remove) deleteBot(remove.dataset.remove!);

  closeMenu();
});

sheet.addEventListener("submit", (e) => {
  e.preventDefault();
  saveSheet();
});

for (const control of [appModel, appScreen, appIdle, appRoutines, appAwake]) {
  control.addEventListener("change", saveAppSettings);
}

// Switching it on is when the machine asks — which is the whole reason it
// starts off. A refusal turns the switch back rather than leaving it on and
// silently doing nothing, which is the way a setting loses your trust.
appNotify.addEventListener("change", async () => {
  if (appNotify.checked && !(await isPermissionGranted().catch(() => false))) {
    const answer = await requestPermission().catch(() => "denied");
    if (answer !== "granted") {
      appNotify.checked = false;
      toast("macOS is not letting botcage send notifications");
    }
  }
  saveAppSettings();
  // One, now, so you know what they look like and that they arrive. This is
  // the only one that fires while you are looking at the app, because it is
  // the only one that is about the setting rather than about a bot.
  if (appNotify.checked) {
    sendNotification({
      title: "botcage will tell you",
      body: "When a bot says your name or a turn fails, and you are elsewhere.",
    });
  }
});

// A name is typed rather than picked, so it saves as it is typed — a change
// event on a text field only fires when focus leaves it, and a settings panel
// closed with a click somewhere else would have dropped the last edit.
$<HTMLInputElement>("#app-name").addEventListener("input", saveAppSettings);

$<HTMLButtonElement>("#about-close").addEventListener("click", () => {
  aboutWrap.hidden = true;
});
$<HTMLButtonElement>("#about-repo").addEventListener("click", () => {
  void openUrl("https://github.com/hackyguru/botcage");
});
aboutWrap.addEventListener("mousedown", (e) => {
  if (e.target === aboutWrap) aboutWrap.hidden = true;
});

$<HTMLButtonElement>("#app-settings-close").addEventListener("click", () => {
  appWrap.hidden = true;
});
$<HTMLButtonElement>("#app-settings-done").addEventListener("click", () => {
  appWrap.hidden = true;
});
appWrap.addEventListener("mousedown", (e) => {
  if (e.target === appWrap) appWrap.hidden = true;
});

$<HTMLButtonElement>("#app-open-folder").addEventListener("click", () => {
  void invoke<string>("bots_dir").then((dir) => openPath(dir)).catch((err) => toast(String(err)));
});

// System-level switches: apply immediately, and reflect what actually happened
// rather than what was clicked.
appLid.addEventListener("change", () => {
  const wanted = appLid.checked;
  void invoke("set_lid_awake", { on: wanted })
    .then(() => toast(wanted ? "The lid can stay closed now" : "Lid-close sleep restored"))
    .catch((err) => {
      appLid.checked = !wanted;
      toast(String(err) === "cancelled" ? "Cancelled" : String(err));
    });
});

appLogin.addEventListener("change", () => {
  const wanted = appLogin.checked;
  void invoke("set_login_launch", { on: wanted })
    .then(() => toast(wanted ? "botcage will start at login" : "botcage won't start at login"))
    .catch((err) => {
      appLogin.checked = !wanted;
      toast(String(err));
    });
});

$<HTMLButtonElement>("#app-stop-all").addEventListener("click", () => {
  for (const bot of state.bots.filter((b) => b.computer)) {
    void invoke("sandbox_stop", { botId: bot.id }).catch(() => {});
  }
  toast("Stopping desktops");
});

$<HTMLButtonElement>("#app-rebuild-image").addEventListener("click", () => {
  toast("Rebuilding the sandbox image — this takes a few minutes");
  void invoke("rebuild_image").catch((err) => toast(String(err)));
});

/* ----------------------------------------------------------- the editor */

/** Which routine is being edited, or null while one is being made. */
let editingRoutine: string | null = null;

/** What the form currently describes, as a routine — used for the preview line
 *  before anything is saved. */
function draftRoutine(): Routine {
  return {
    id: editingRoutine ?? "",
    name: routineName.value.trim(),
    instruction: routineInstruction.value.trim(),
    every: routineEvery.value as Routine["every"],
    at: routineAt.value || "09:00",
    minutes: Number(routineInterval.value) || 15,
    day: Number(routineDay.value),
    date: routineDate.value,
    // Empty means the bot's own chat, which is not the same as "no channel
    // chosen yet" — but it is stored the same way, because a routine pointed
    // at nowhere and a routine pointed at its own thread do the same thing.
    channel: $<HTMLSelectElement>("#routine-where").value || undefined,
    format: ($<HTMLSelectElement>("#routine-format").value || undefined) as Routine["format"],
    active: routineActive.checked,
  };
}

/** Only the fields this kind of schedule needs. A weekly routine has no date, a
 *  one-off has no weekday, and asking for both would make the shorter answer
 *  look incomplete. */
function paintRoutineForm(): void {
  const every = routineEvery.value;
  $<HTMLLabelElement>("#routine-day-row").hidden = every !== "week";
  $<HTMLLabelElement>("#routine-date-row").hidden = every !== "once";
  $<HTMLLabelElement>("#routine-at-row").hidden = every === "minutes";
  $<HTMLLabelElement>("#routine-interval-row").hidden = every !== "minutes";

  const next = whenNext(draftRoutine());
  $<HTMLParagraphElement>("#routine-next").textContent = next ? `Next run ${next}` : "";
}

/** Open the editor: on an existing routine, or empty on a slot that was
 *  clicked, which carries the day and hour that were pointed at. */
function openRoutine(routine: Routine | null, seed?: { day: number; hour: number; date: string }): void {
  editingRoutine = routine?.id ?? null;

  // Whose calendar this lands on. On one bot's own that is never in question;
  // on everybody's it is the first thing the form has to answer, so it is the
  // first row rather than something to discover after saving to the wrong bot.
  const owner = routine ? ownerOf(routine.id)?.bot : null;
  const picker = $<HTMLSelectElement>("#routine-bot");
  $<HTMLLabelElement>("#routine-bot-row").hidden = !calEveryone;
  picker.innerHTML = state.bots
    .map((b) => `<option value="${b.id}">${escapeHtml(b.name)}</option>`)
    .join("");
  picker.value = owner?.id ?? activeBot()?.id ?? state.bots[0]?.id ?? "";

  routineName.value = routine?.name ?? "";
  routineInstruction.value = routine?.instruction ?? "";
  // A slot that was clicked means that day at that hour — the reading anyone
  // makes of clicking Tuesday at three.
  routineEvery.value = routine?.every ?? (seed ? "week" : "day");
  routineAt.value = routine?.at ?? (seed ? `${pad2(seed.hour)}:00` : "09:00");
  routineDay.value = String(routine?.day ?? seed?.day ?? 1);
  routineDate.value = routine?.date ?? seed?.date ?? isoDate(new Date());
  routineInterval.value = String(routine?.minutes ?? 15);
  routineActive.checked = routine?.active ?? true;

  // Work you did not put here says so. Without it, a bot quietly filling a
  // colleague's week is indistinguishable from the colleague's own plans.
  const by = $<HTMLParagraphElement>("#routine-by");
  by.hidden = !routine?.by;
  by.textContent = routine?.by ? `Added by ${routine.by}. Yours to keep, pause or delete.` : "";

  paintRoutineWhere(picker.value, routine?.channel);
  $<HTMLSelectElement>("#routine-format").value = routine?.format ?? "";
  paintRoutineFormat();
  $<HTMLSelectElement>("#routine-format").value = routine?.format ?? "";
  paintRoutineFormat();

  $<HTMLHeadingElement>("#routine-title").textContent = routine ? "Routine" : "New routine";
  $<HTMLButtonElement>("#routine-save").textContent = routine ? "Save" : "Add routine";
  // Only something that exists can be run, deleted, or paused.
  $<HTMLButtonElement>("#routine-run").hidden = !routine;
  $<HTMLButtonElement>("#routine-delete").hidden = !routine;
  $<HTMLLabelElement>("#routine-active-row").hidden = !routine;

  paintRoutineForm();
  routineWrap.hidden = false;
  routineName.focus();
}

/** Whether this routine is one bot doing a thing, or a room taking turns.
 *
 *  Only offered when it reports into a channel: a stand-up in a bot's own chat
 *  is a bot talking to itself, which is not a meeting. */
function paintRoutineFormat(): void {
  const where = $<HTMLSelectElement>("#routine-where").value;
  const room = channels().find((c) => c.id === where);
  const picker = $<HTMLSelectElement>("#routine-format");

  // A review is one bot reading its own week back, which it can do anywhere. A
  // stand-up needs a room to go round, so that option is only offered where
  // there is one — and taken away from a routine that had it and then lost the
  // room, which would otherwise sit there meaning nothing.
  const standupOption = picker.querySelector<HTMLOptionElement>('option[value="standup"]');
  if (standupOption) standupOption.hidden = !room;
  if (!room && picker.value === "standup") picker.value = "";

  // Always shown now: two of the three formats work in a private chat.
  $<HTMLLabelElement>("#routine-format-row").hidden = false;

  const hint = $<HTMLSpanElement>("#routine-format-hint");
  if (picker.value === "standup" && room) {
    hint.textContent = `All ${membersOf(room).length} take a turn, one at a time, each handed what actually ran.`;
  } else if (picker.value === "review") {
    hint.textContent =
      "It is handed its own week from botcage's records — what ran, what failed, what is next — and reports on it.";
  } else {
    hint.textContent = "One bot does the thing and reports back.";
  }
}

$<HTMLSelectElement>("#routine-format").addEventListener("change", paintRoutineFormat);
$<HTMLSelectElement>("#routine-where").addEventListener("change", paintRoutineFormat);

/** Where a routine reports: its own bot's chat, or a room that bot is in.
 *
 *  Only rooms it is a member of — a routine pointed at a channel the bot had
 *  since been taken out of would come due every morning and go nowhere. */
function paintRoutineWhere(botId: string, chosen?: string): void {
  const whose = state.bots.find((b) => b.id === (botId || activeBot()?.id));
  const rooms = whose ? channels().filter((c) => c.members.includes(whose.id)) : [];
  const where = $<HTMLSelectElement>("#routine-where");
  $<HTMLLabelElement>("#routine-where-row").hidden = !rooms.length;
  where.innerHTML =
    `<option value="">${escapeHtml(whose?.name ?? "The bot")}&rsquo;s own chat</option>` +
    rooms.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join("");
  where.value = chosen && rooms.some((c) => c.id === chosen) ? chosen : "";
}

// Whose routine it is decides which rooms it could report into. Only that row
// is repainted: reopening the sheet would throw away everything else typed.
$<HTMLSelectElement>("#routine-bot").addEventListener("change", (e) => {
  paintRoutineWhere((e.target as HTMLSelectElement).value);
});

routineEvery.addEventListener("change", paintRoutineForm);
routineAt.addEventListener("change", paintRoutineForm);
routineDay.addEventListener("change", paintRoutineForm);
routineDate.addEventListener("change", paintRoutineForm);
routineInterval.addEventListener("change", paintRoutineForm);

$<HTMLButtonElement>("#routine-add").addEventListener("click", () => openRoutine(null));
$<HTMLButtonElement>("#routine-close").addEventListener("click", () => {
  routineWrap.hidden = true;
});
routineWrap.addEventListener("mousedown", (e) => {
  if (e.target === routineWrap) routineWrap.hidden = true;
});

$<HTMLButtonElement>("#cal-prev").addEventListener("click", () => {
  calAt = stepSpan(calAt, calSpan, -1);
  renderRoutines();
});
$<HTMLButtonElement>("#cal-next").addEventListener("click", () => {
  calAt = stepSpan(calAt, calSpan, 1);
  renderRoutines();
});
$<HTMLButtonElement>("#cal-today").addEventListener("click", () => {
  calAt = spanStart(Date.now(), calSpan);
  renderRoutines();
  paintCalScroll();
});

$<HTMLDivElement>("#cal-spans").addEventListener("click", (e) => {
  const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-span]");
  if (pick) setCalSpan(pick.dataset.span as CalSpan);
});

$<HTMLElement>("#desk").addEventListener("click", (e) => {
  // An answer pressed on the list itself. The whole point of the desk is what
  // will not move until you do something, and the ones that can be finished
  // without going anywhere should be finished here.
  const answer = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-desk-answer]");
  if (answer?.dataset.answer) {
    const item = desk[Number(answer.dataset.deskAnswer)];
    if (item) answerAsk(item.at, answer.dataset.answer);
    return;
  }

  const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-desk-at]");
  if (!pick) return;
  const item = desk[Number(pick.dataset.deskAt)];
  if (!item) return;
  // Going somewhere is leaving here — which openBot and openChannel now do on
  // their own, from wherever they were called.
  if (item.at.channelId) openChannel(item.at.channelId);
  else if (item.at.botId) openBot(item.at.botId);
  else void openAppSettings();
  if (item.at.messageId) gotoMessage(item.at.messageId);
});

$<HTMLElement>("#routines").addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  const edit = target.closest<HTMLElement>("[data-edit]");
  if (edit) {
    const found = ownerOf(edit.dataset.edit ?? "");
    if (found) openRoutine(found.routine);
    return;
  }

  // A day with more on it than its cell can hold. Opening that day is the
  // answer, since that is the view able to show them all.
  const open = target.closest<HTMLElement>("[data-open]");
  if (open) {
    calAt = spanStart(fromIso(open.dataset.open ?? ""), "day");
    setCalSpan("day");
    return;
  }

  if (!calBots().length) return;

  // An hour on the grid, or a whole day in a month — which has no hour to read
  // off it, so it opens at nine like a working day.
  const slot = target.closest<HTMLElement>(".cal__slot, .cal__cell");
  if (slot) {
    const day = fromIso(slot.dataset.day ?? "");
    openRoutine(null, {
      day: day.getDay(),
      hour: Number(slot.dataset.hour ?? 9),
      date: isoDate(day),
    });
  }
});

routineForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const draft = draftRoutine();
  // A stand-up and a review write their own prompt out of the record, so they
  // need a name and nothing else. Asking for an instruction there was asking
  // for something the format then ignored.
  const writesItsOwn = draft.format === "standup" || draft.format === "review";
  if (!draft.name || (!draft.instruction && !writesItsOwn)) {
    toast(
      writesItsOwn ? "A routine needs a name" : "A routine needs a name and an instruction",
    );
    (draft.name ? routineInstruction : routineName).focus();
    return;
  }

  const was = editingRoutine ? ownerOf(editingRoutine) : null;
  // Where it is going: what the picker says on the shared calendar, and the bot
  // whose calendar you are looking at everywhere else.
  const picked = calEveryone ? $<HTMLSelectElement>("#routine-bot").value : "";
  const bot = state.bots.find((b) => b.id === picked) ?? was?.bot ?? activeBot();
  if (!bot) return;

  bot.routines = bot.routines ?? [];
  const existing = was?.bot.id === bot.id ? was.routine : null;
  if (existing) {
    Object.assign(existing, draft, { id: existing.id, lastRunAt: existing.lastRunAt });
    // Re-timed from now, so an edited schedule cannot fire the moment it is
    // saved because its old time had already passed.
    existing.lastRunAt = Date.now();
  } else {
    // Either new, or handed to a different bot on the shared week — in which
    // case it leaves the one that had it rather than being in two places.
    if (was) was.bot.routines = (was.bot.routines ?? []).filter((r) => r.id !== was.routine.id);
    bot.routines.push({
      ...draft,
      id: was?.routine.id ?? uid(),
      by: was?.routine.by,
      active: was?.routine.active ?? true,
      lastRunAt: Date.now(),
    });
    if (was) toast(`Moved "${draft.name}" to ${bot.name}`);
  }

  routineWrap.hidden = true;
  save();
  renderRoutines();
  renderThread();
});

$<HTMLButtonElement>("#routine-run").addEventListener("click", () => {
  const found = editingRoutine ? ownerOf(editingRoutine) : null;
  if (!found) return;
  routineWrap.hidden = true;
  showRoutines(false);
  // Running it means watching it, so the bot doing the work is opened.
  if (found.bot.id !== state.activeId || state.activeChannel) openBot(found.bot.id);
  runRoutine(found.bot, found.routine);
});

$<HTMLButtonElement>("#routine-delete").addEventListener("click", () => {
  const found = editingRoutine ? ownerOf(editingRoutine) : null;
  if (!found) return;
  found.bot.routines = (found.bot.routines ?? []).filter((r) => r.id !== editingRoutine);
  routineWrap.hidden = true;
  save();
  renderRoutines();
  renderThread();
  toast(`Deleted ${found.routine.name}`);
});

$<HTMLInputElement>("#sheet-hours-on").addEventListener("change", (e) => {
  $<HTMLDivElement>("#sheet-hours-when").hidden = !(e.target as HTMLInputElement).checked;
});

$<HTMLDivElement>("#sheet-hours-days").addEventListener("click", (e) => {
  const day = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
  if (day) day.classList.toggle("is-on");
});

$<HTMLDivElement>("#sheet-hires-row").addEventListener("click", (e) => {
  const pick = (e.target as HTMLElement).closest<HTMLElement>("[data-hire]");
  if (!pick) return;
  const hire = HIRES.find((h) => h.name === pick.dataset.hire);
  if (!hire) return;

  // The name is filled only if you have not written one, or if it is another
  // template's — so picking a second one to compare the wording does not throw
  // away the name you chose, and does not leave you with an Engineer called
  // Researcher either.
  const typed = sheetName.value.trim();
  if (!typed || HIRES.some((h) => h.name === typed)) sheetName.value = hire.name;
  sheetRole.value = hire.role;
  draftColor = hire.colour;
  renderSheetPreview();

  for (const el of document.querySelectorAll(".hire.is-on")) el.classList.remove("is-on");
  pick.classList.add("is-on");
  sheetName.focus();
});

swatches.addEventListener("click", (e) => {
  const swatch = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
  if (!swatch) return;
  draftColor = swatch.dataset.color!;
  renderSheetPreview();
});

$<HTMLButtonElement>("#sheet-close").addEventListener("click", () => {
  showSheet(false);
});

document.addEventListener("mousedown", (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu();
});

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "n") {
    e.preventDefault();
    openSheet();
  } else if (meta && e.key.toLowerCase() === "b") {
    e.preventDefault();
    toggleRail();
  } else if (meta && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  } else if (meta && e.key.toLowerCase() === "f") {
    // The two searches answer different questions and now have the key each
    // one is looked for under: K for which conversation, F for which line in
    // the one you are reading.
    e.preventDefault();
    findBox.focus();
    findBox.select();
  } else if (e.key === "Escape") {
    if (call) endCall();
    else if (!tourWrap().hidden) endTour();
    // Before the settings sheet it opens over, or Escape would close the sheet
    // underneath and leave this standing on its own.
    else if (!restoreWrap.hidden) closeRestore();
    else if (!modelsWrap.hidden) modelsWrap.hidden = true;
    else if (!channelWrap.hidden) channelWrap.hidden = true;
    else if (!routineWrap.hidden) routineWrap.hidden = true;
    else if (!setupWrap.hidden) closeSetup();
    else if (!aboutWrap.hidden) aboutWrap.hidden = true;
    else if (!appWrap.hidden) appWrap.hidden = true;
    else if (teach.arming) cancelArming();
    else if (teach.on) void stopTeaching();
    else if (!menu.hidden) closeMenu();
    else if (!sheetWrap.hidden) showSheet(false);
    // Not a panel you are trapped in, so it goes last — after everything that
    // is covering something else.
    else if (!found.hidden) closeFind();
    else if (!screenPane.hidden) closeScreen();
  }
});

window.addEventListener("resize", closeMenu);

/* ----------------------------------------------------------------- onboarding */
/* botcage needs a signed-in Claude Code CLI to answer at all, and optionally an
   engine for bots given a computer. Both used to be a toast and a paragraph in
   the release notes; this walks through them, does the work where it can, and
   never claims a step is done without looking. */

interface ClaudeState {
  path: string | null;
  version: string | null;
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  trouble: string | null;
}

const SETUP_STEPS = ["welcome", "answers", "engine", "voice", "done"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

const setupWrap = $<HTMLDivElement>("#setup");
const setupRail = $<HTMLDivElement>("#setup-rail");
const setupNext = $<HTMLButtonElement>("#setup-next");
const setupBack = $<HTMLButtonElement>("#setup-back");
const setupSkip = $<HTMLButtonElement>("#setup-skip");

let setupAt: SetupStep = "welcome";
let claudeState: ClaudeState | null = null;
let claudeBusy = "";
let setupLog: string[] = [];
/** Set while a terminal is open for sign-in, so the sheet can wait for it. */
let signInWatch: number | null = null;
/** Waiting on a sign-in happening elsewhere is not the same as working: the
 *  terminal may have been closed, so this waits without trapping anyone. */
let signInWaiting = false;

setupRail.innerHTML = SETUP_STEPS.map(() => `<span class="setup__seg"></span>`).join("");

void listen<string>("claude-setup", (event) => {
  setupLog = [...setupLog, event.payload].slice(-40);
  paintSetup();
});

/* ------------------------------------------------------------- setup music */

const music = new Music();
const setupMute = $<HTMLButtonElement>("#setup-mute");

function paintMute(): void {
  const off = Boolean(appSettings().hush);
  setupMute.querySelector("use")?.setAttribute("href", off ? "#i-hush" : "#i-sound");
  setupMute.title = off ? "Play music" : "Stop the music";
  setupMute.setAttribute("aria-label", setupMute.title);
  setupMute.classList.toggle("is-off", off);
}

setupMute.addEventListener("click", () => {
  const off = !appSettings().hush;
  state.app = { ...appSettings(), hush: off };
  save();
  paintMute();
  if (off) music.stop();
  else void music.start();
});

async function openSetup(at: SetupStep = "welcome"): Promise<void> {
  setupAt = at;
  $<HTMLInputElement>("#setup-name").value = appSettings().name ?? "";
  // Start on whatever this app is already set up to use, so reopening setup
  // shows the arrangement someone made rather than the one botcage prefers.
  const chosen = appSettings().engine ?? DEFAULT_ENGINE;
  setupRoute =
    chosen === DEFAULT_ENGINE
      ? "claude-code"
      : appSettings().provider === "ollama"
        ? "ollama"
        : "hosted";
  ollamaModels = null;
  setupPick = null;
  $<HTMLDivElement>("#setup-picks")
    .querySelectorAll<HTMLInputElement>("input")
    .forEach((radio) => {
      radio.checked = radio.value === setupRoute;
    });
  setupLog = [];
  setupWrap.hidden = false;
  setupShown = null;
  paintMute();
  if (!appSettings().hush) void music.start();
  paintSetup();
  await Promise.all([refreshClaude(), refreshEngine()]);
  paintSetup();
}

function closeSetup(): void {
  setupWrap.hidden = true;
  music.stop();
  stopSignInWatch();
  // Shown once. Someone who skipped a step can reopen it from the account menu,
  // and a missing CLI still warns on its own.
  const first = !appSettings().onboarded;
  if (first) {
    state.app = { ...appSettings(), onboarded: true };
    save();
  }
  // Setup arranges what botcage needs; the tour says what the app is. They are
  // different jobs, so they are different screens, one after the other.
  if (first && !appSettings().toured) window.setTimeout(startTour, 260);
}

/* --------------------------------------------------------------------- tour */

/** One thing worth pointing at, and why it is there. */
interface Stop {
  /** What to ring. Missing from the page means the stop is skipped rather than
   *  the tour breaking — the composer is absent while a screen pane is open,
   *  and a build may drop a button entirely. */
  target: string;
  title: string;
  body: string;
  /** Put the app where this stop can be seen: open the sheet, switch to a tab,
   *  show the calendar. A lesson about scheduling is useless pointing at a
   *  clock icon and describing what would happen if you pressed it.
   *
   *  Run before the target is measured, and again on Back, so stepping through
   *  a lesson in either direction arrives at the same screen. */
  open?: () => void;
}

const TOUR: Stop[] = [
  {
    target: "#bots",
    title: "Your bots",
    body: "Each one is a separate conversation with its own memory, its own folder on this machine, and its own idea of what it is for. They do not share anything unless you say so.",
  },
  {
    target: "#btn-new",
    title: "Make one per job",
    body: "A bot is cheap. Give each real job its own — the one that reviews code should not be the one that plans your week, because they remember different things.",
  },
  {
    target: "#dock",
    title: "Just talk to it",
    body: "Say what you want in plain words. A bot answers here, and remembers this conversation the next time you open the app.",
  },
  {
    target: "#btn-routines",
    title: "Standing work",
    body: "A bot can hold instructions on a schedule: every morning, every hour, or once next Tuesday. This opens its week as a calendar — click any slot to add one.",
  },
  {
    target: "#btn-plugins",
    title: "Its connections",
    body: "GitHub, Gmail, Calendar, Notion and the rest. You connect an account once and choose which bots may reach it — the credential stays in your keychain, never in a bot.",
  },
  {
    target: "#btn-settings",
    title: "What it is, and what answers it",
    body: "A bot's name, its job description, and which model replies for it — Claude Code, the Gemini CLI, or any of thousands on models.dev. Different bots can use different ones.",
  },
  {
    target: "#btn-monitor",
    title: "Its own computer",
    body: "Give a bot a private Linux desktop in a container, with a browser and a terminal. You can watch it work and take the mouse back whenever you like.",
  },
  {
    target: "#btn-account",
    title: "Everything else",
    body: "Settings for this machine, and the Phone panel — pair a phone by scanning a square, and reach these bots from anywhere without opening a port.",
  },
];

/** What botcage can teach, each one a walk through the thing itself rather than
 *  a description of it. Reached from the guide's thread. */
interface Lesson {
  id: string;
  title: string;
  stops: Stop[];
}

const LESSONS: Lesson[] = [
  {
    id: "new-bot",
    title: "Make a bot",
    stops: [
      {
        target: "#btn-new",
        title: "One bot per job",
        body: "This makes one. A bot is cheap, and two jobs in one bot means one memory holding both.",
        open: () => {
          showSheet(false);
        },
      },
      {
        target: "#sheet-name",
        title: "Give it a name",
        body: "You will be talking to it by name, so pick one you would use out loud.",
        open: () => openSheet(null),
      },
      {
        target: "#sheet-role",
        title: "Say what it is responsible for",
        body: "The work it owns, how you want it approached, anything it must always or never do. This goes into every conversation with it, so it is worth being specific.",
        open: () => openSheet(null),
      },
      {
        target: "#sheet-engine",
        title: "Choose what answers it",
        body: "Claude Code, the Gemini CLI, or any of thousands of hosted models. Different bots can use different ones — and you can change this later without losing the conversation.",
        open: () => openSheet(null),
      },
      {
        target: "#sheet-submit",
        title: "That is the whole thing",
        body: "Fill those in and press this. The bot appears in the list with its own memory and its own folder on this machine.",
        open: () => openSheet(null),
      },
    ],
  },
  {
    id: "routines",
    title: "Put work on the calendar",
    stops: [
      {
        target: "#btn-routines",
        title: "The clock",
        body: "Every bot has a week of its own behind this, in the top bar.",
        open: () => showRoutines(false),
      },
      {
        target: "#cal-cols",
        title: "Click a slot",
        body: "That day, that hour. It opens a routine already filled in with when you clicked — you supply the name and the instruction.",
        open: () => showRoutines(true),
      },
      {
        target: "#routine-add",
        title: "Or start from the schedule",
        body: "Once, every week, every day, every weekday, every hour, or every few minutes. A one-off switches itself off after it runs.",
        open: () => showRoutines(true),
      },
      {
        target: "#cal-often",
        title: "The fast ones live up here",
        body: "Anything repeating faster than an hour would be a stripe through all seven days, so it sits in a band above the grid instead.",
        open: () => showRoutines(true),
      },
    ],
  },
  {
    id: "computer",
    title: "Give a bot a computer",
    stops: [
      {
        target: "#btn-settings",
        title: "Start here",
        body: "Everything about the bot you are looking at lives behind this: its name, what it is for, what answers it, and whether it has a computer.",
        // Closing it again matters on the way back: the gear is underneath the
        // sheet, and a ring around something covered by a modal points at
        // nothing.
        open: () => {
          showSheet(false);
        },
      },
      {
        target: '#sheet-wrap [data-tab="computer"]',
        title: "The Computer tab",
        body: "Off by default. Nothing is downloaded and no container exists until you switch it on here.",
        open: () => {
          openSheet(activeBot());
          showSheetTab("computer");
        },
      },
      {
        target: "#sheet-computer",
        title: "Its own machine",
        body: "A Linux desktop in a container: a browser, a terminal, a file manager. Nobody else's files are on it, and nothing it does there touches yours.",
        open: () => {
          openSheet(activeBot());
          showSheetTab("computer");
        },
      },
      {
        target: "#sheet-network",
        title: "What it may reach",
        body: "The internet and your home network, the internet only, or nothing at all. Baked in when the container is built.",
        open: () => {
          openSheet(activeBot());
          showSheetTab("computer");
        },
      },
      {
        target: "#btn-monitor",
        title: "Watch it work",
        body: "This opens the screen. You can take the mouse back at any point, and hand it over again when you are done.",
        open: () => {
          showSheet(false);
        },
      },
    ],
  },
  {
    id: "phone",
    title: "Reach your bots from your phone",
    stops: [
      {
        target: "#btn-account",
        title: "Settings live here",
        body: "This machine's own settings, rather than one bot's — the account menu at the bottom of the list, then Settings.",
        open: () => {
          appWrap.hidden = true;
        },
      },
      {
        target: '#app-settings [data-tab="phone"]',
        title: "The Phone tab",
        body: "Everything about reaching this machine from a phone is on this one panel.",
        open: () => {
          void openAppSettings();
          showSettingsTab("phone");
        },
      },
      {
        target: "#app-remote",
        title: "Switch on phone access",
        body: "The laptop opens no port. Your phone reaches it directly over an encrypted connection, at home or on mobile data.",
        open: () => {
          void openAppSettings();
          showSettingsTab("phone");
        },
      },
      {
        target: "#app-remote-qr",
        title: "Scan this with the app",
        body: "The square carries this machine's identity and a six-character code that lasts five minutes and works once.",
        open: () => {
          void openAppSettings();
          showSettingsTab("phone");
        },
      },
      {
        target: "#app-remote-list",
        title: "What you have paired",
        body: "Every phone that has been let in, and a way to revoke any of them. The key each one holds is bound to that phone and refused from anywhere else.",
        open: () => {
          void openAppSettings();
          showSettingsTab("phone");
        },
      },
    ],
  },
  {
    id: "engine",
    title: "Choose what answers it",
    stops: [
      {
        target: "#btn-settings",
        title: "Nothing here ships a model",
        body: "botcage drives something else, and which something is a property of each bot rather than of the app. It lives in the bot's own settings.",
        open: () => {
          showSheet(false);
        },
      },
      {
        target: "#sheet-engine",
        title: "Answered by",
        body: "Claude Code, the Gemini CLI, or any hosted model. Different bots can use different ones, and changing this does not lose the conversation — botcage keeps the thread and hands it to whatever answers next.",
        open: () => {
          openSheet(activeBot());
          showSheetTab("general");
        },
      },
      {
        target: "#sheet-model-row",
        title: "And which model",
        body: "Two or three for a CLI. For a hosted one it is a search over every model on models.dev — 5,559 of them, with what each costs and whether it can use tools — plus Ollama on this machine, which needs no key and costs nothing.",
        open: () => {
          openSheet(activeBot());
          showSheetTab("general");
        },
      },
      {
        target: "#bots",
        title: "One roster, several engines",
        body: "A bot on your Claude subscription can sit beside one on a local model that costs nothing, and a third on something you are only trying out. They do not know about each other.",
        open: () => {
          showSheet(false);
        },
      },
    ],
  },
  {
    id: "teach",
    title: "Show it how, once",
    stops: [
      {
        target: "#btn-monitor",
        title: "It has to be watching",
        body: "Teaching happens on a bot's own computer, so this is where it starts. The bot needs one, and it needs to be switched on.",
        open: () => {
          showSheet(false);
        },
      },
      {
        target: "#screen-pane",
        title: "Its screen",
        body: "A Linux desktop nobody else uses. You can watch what the bot does on it, and you can reach in.",
        open: () => void openScreen(),
      },
      {
        target: "#btn-control",
        title: "Take the mouse",
        body: "The bot stops driving and you do. This is how you show it something rather than describe it.",
        open: () => void openScreen(),
      },
      {
        target: "#btn-teach",
        title: "Record what you do",
        body: "Name the task, press record, do it once, press stop. botcage keeps every click, every key and a picture of each step — as a demonstration, not a video.",
        open: () => void openScreen(),
      },
      {
        target: "#dock",
        title: "Then just ask for it",
        body: "Ask the bot to do that task by name and it replays what you did, adapting as it goes. Put it on the calendar and it does it every morning without being asked.",
      },
    ],
  },
  {
    id: "plugins",
    title: "Connect it to your accounts",
    stops: [
      {
        target: "#btn-plugins",
        title: "A bot's connections",
        body: "Everything this bot may reach beyond its own folder, in the top bar beside its settings.",
        open: () => {
          pluginsWrap.hidden = true;
        },
      },
      {
        target: "#plugins-search",
        title: "Find one",
        body: "botcage runs its own connections rather than claude.ai's, so an account you connect here works whatever model answers the bot.",
        open: () => void openPlugins(),
      },
      {
        target: "#plugins-body",
        title: "Connect once, choose per bot",
        body: "You sign in to an account once and the credential stays in your keychain. Which bots may use it is a separate decision, made here.",
        open: () => void openPlugins(),
      },
    ],
  },
];

let tourAt = 0;
/** The tour being given. The tour of the app itself when nobody asked for a
 *  particular lesson. */
let tourStops: Stop[] = TOUR;
const tourWrap = () => $<HTMLDivElement>("#tour");

function startTour(stops: Stop[] = TOUR): void {
  tourAt = 0;
  tourStops = stops;
  tourWrap().hidden = false;
  paintTour();
}

function endTour(): void {
  tourWrap().hidden = true;
  if (!appSettings().toured) {
    state.app = { ...appSettings(), toured: true };
    save();
  }
}

/** Is this stop's target actually on screen?
 *
 *  Present in the document is not the same as visible: the teach button exists
 *  whenever the app does but is hidden until a bot's desktop is running, and a
 *  ring around something with no rectangle is a ring around the top-left
 *  corner of the window. */
function onScreen(target: string): boolean {
  const found = document.querySelector<HTMLElement>(target);
  if (!found) return false;
  const box = found.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** Move to the next stop that is actually on screen. */
function tourGo(by: number): void {
  for (let at = tourAt + by; at >= 0 && at < tourStops.length; at += by) {
    tourStops[at].open?.();
    if (onScreen(tourStops[at].target)) {
      tourAt = at;
      paintTour();
      return;
    }
  }
  endTour();
}

function paintTour(): void {
  const stop = tourStops[tourAt];
  stop.open?.();
  if (!onScreen(stop.target)) return tourGo(1);
  const target = document.querySelector(stop.target)!;

  // A margin around the target, so the ring frames it rather than tracing it.
  const pad = 6;
  const box = target.getBoundingClientRect();
  const top = Math.max(0, box.top - pad);
  const left = Math.max(0, box.left - pad);
  const right = Math.min(window.innerWidth, box.right + pad);
  const bottom = Math.min(window.innerHeight, box.bottom + pad);

  const pane = (edge: string, style: Partial<CSSStyleDeclaration>) =>
    Object.assign($<HTMLDivElement>(`.tour__pane[data-edge="${edge}"]`).style, style);
  const px = (n: number) => `${n}px`;

  pane("top", { top: "0", left: "0", right: "0", height: px(top) });
  pane("bottom", { top: px(bottom), left: "0", right: "0", bottom: "0", height: "auto" });
  pane("left", { top: px(top), left: "0", width: px(left), height: px(bottom - top) });
  pane("right", { top: px(top), left: px(right), right: "0", width: "auto", height: px(bottom - top) });

  Object.assign($<HTMLDivElement>("#tour-ring").style, {
    top: px(top),
    left: px(left),
    width: px(right - left),
    height: px(bottom - top),
  });

  $<HTMLSpanElement>("#tour-count").textContent = `${tourAt + 1} of ${tourStops.length}`;
  $<HTMLHeadingElement>("#tour-title").textContent = stop.title;
  $<HTMLParagraphElement>("#tour-body").textContent = stop.body;
  $<HTMLButtonElement>("#tour-back").hidden = tourAt === 0;
  $<HTMLButtonElement>("#tour-next").textContent =
    tourAt === tourStops.length - 1 ? "Done" : "Next";

  // Beside the target if there is room, otherwise under it, and never off the
  // edge of the window.
  const card = $<HTMLDivElement>("#tour-card");
  const size = card.getBoundingClientRect();
  const gap = 14;
  let cardLeft = right + gap;
  if (cardLeft + size.width > window.innerWidth - 12) cardLeft = left - size.width - gap;
  if (cardLeft < 12) cardLeft = Math.min(left, window.innerWidth - size.width - 12);
  let cardTop = top;
  if (cardTop + size.height > window.innerHeight - 12) {
    cardTop = Math.max(12, window.innerHeight - size.height - 12);
  }
  Object.assign(card.style, { left: px(Math.max(12, cardLeft)), top: px(cardTop) });
}

$<HTMLButtonElement>("#tour-next").addEventListener("click", () => {
  if (tourAt === tourStops.length - 1) return endTour();
  tourGo(1);
});
$<HTMLButtonElement>("#tour-back").addEventListener("click", () => tourGo(-1));
$<HTMLButtonElement>("#tour-skip").addEventListener("click", endTour);
window.addEventListener("resize", () => {
  if (!tourWrap().hidden) paintTour();
});

async function refreshClaude(): Promise<void> {
  claudeState = await invoke<ClaudeState>("claude_state").catch(() => null);
  claudeReady = Boolean(claudeState?.path && claudeState.signedIn);
}

async function refreshEngine(): Promise<void> {
  engine = await invoke<EngineStatus>("engine_status").catch(() => null);
}

/** Is this step's work done? Used for the button label and for skipping past
 *  steps that need nothing. */
/** Which way of answering setup is currently offering to arrange. */
let setupRoute: "claude-code" | "ollama" | "hosted" = "claude-code";
/** What the hosted route has been pointed at, if anything. */
let setupPick: Listing | null = null;
/** How many models Ollama has pulled — null until asked. */
let ollamaModels: number | null = null;

function stepSatisfied(step: SetupStep): boolean {
  if (step === "answers") {
    // Whatever route is showing has to actually work. A bot cannot be answered
    // by a plan.
    if (setupRoute === "claude-code") return Boolean(claudeState?.path && claudeState.signedIn);
    if (setupRoute === "ollama") return (ollamaModels ?? 0) > 0;
    return setupPick !== null;
  }
  if (step === "engine") return Boolean(engine?.installed) || engine?.supported === false;
  // Voice is never a reason to be stuck: a bot you can type at is the whole
  // app, and this step is an offer rather than a requirement.
  return true;
}

/** Is there any way at all to answer a bot? Used at launch to decide whether
 *  setup needs reopening — which used to mean "is Claude Code signed in", and
 *  would now drag someone who chose Ollama back through a step they settled. */
function somethingCanAnswer(): boolean {
  const settings = appSettings();
  if ((settings.engine ?? DEFAULT_ENGINE) === DEFAULT_ENGINE) return claudeReady;
  return Boolean(settings.model);
}

/** Which step is on screen, as opposed to which one is current. They differ
 *  only while one is sliding off. */
let setupShown: SetupStep | null = null;
let setupWay: "on" | "back" = "on";

/** Move the carousel to a step.
 *
 *  paintSetup runs on every log line and every poll, so this does nothing at
 *  all unless the step actually changed — otherwise the panel would restart its
 *  animation every time the installer said something.
 *
 *  Both steps are on screen while it moves: the one leaving is taken out of the
 *  flow so the one arriving can occupy the same place, and put back afterwards.
 *  Without that they stack and the sheet lurches. */
function showStep(to: SetupStep): void {
  const all = [...setupWrap.querySelectorAll<HTMLElement>(".setup__step")];
  const next = all.find((s) => s.dataset.step === to);
  if (!next) return;

  if (setupShown === to) {
    for (const s of all) if (s !== next && !s.classList.contains("is-leaving")) s.hidden = true;
    next.hidden = false;
    return;
  }

  const from = all.find((s) => s.dataset.step === setupShown);
  setupShown = to;

  for (const s of all) {
    if (s !== next && s !== from) s.hidden = true;
  }

  next.hidden = false;
  next.classList.remove("is-leaving", "is-on", "is-back");
  // Reading offsetWidth between removing and adding is what makes the browser
  // start the animation again rather than treating it as never having stopped.
  void next.offsetWidth;
  next.classList.add(setupWay === "back" ? "is-back" : "is-on");

  if (!from || from === next) return;
  from.classList.remove("is-on", "is-back");
  from.classList.add("is-leaving", setupWay === "back" ? "is-back" : "is-on");
  const done = (): void => {
    from.classList.remove("is-leaving", "is-on", "is-back");
    from.hidden = true;
  };
  from.addEventListener("animationend", done, { once: true });
  // A belt for the case the animation never runs — reduced motion, a hidden
  // window — where animationend does not fire and the old step would stay.
  window.setTimeout(done, 400);
}

function paintSetup(): void {
  const index = SETUP_STEPS.indexOf(setupAt);
  setupRail.querySelectorAll<HTMLElement>(".setup__seg").forEach((seg, at) => {
    seg.dataset.on = String(at <= index);
  });
  showStep(setupAt);

  const busy = installing || (Boolean(claudeBusy) && !signInWaiting);
  setupBack.hidden = index === 0 || busy;
  setupSkip.hidden = true;
  setupNext.disabled = busy;
  setupNext.textContent = "Continue";

  if (setupAt === "welcome") setupNext.textContent = "Get started";
  if (setupAt === "answers") paintAnswersStep();
  if (setupAt === "engine") paintEngineStep();
  if (setupAt === "voice") void paintVoiceStep();
  if (setupAt === "done") paintDoneStep();
}

/** The onboarding step that offers a voice.
 *
 *  Offered rather than done, and skippable: it is a few hundred megabytes for
 *  something a lot of people will never use, and a first run that spends that
 *  without asking is a first run that feels like it took a liberty. Say no and
 *  the first call fetches it instead. */
async function paintVoiceStep(): Promise<void> {
  const check = $<HTMLDivElement>("#setup-voice-check");
  const text = $<HTMLSpanElement>("#setup-voice-text");
  const dot = $<HTMLSpanElement>("#setup-voice-check .setup__dot");
  const fine = $<HTMLParagraphElement>("#setup-voice-fine");

  if (voiceStep) {
    dot.dataset.state = "wait";
    text.textContent = voiceStep;
    fine.hidden = true;
    setupSkip.hidden = true;
    setupNext.disabled = true;
    return;
  }

  const [ears, mouth] = await Promise.all([
    invoke<boolean>("hearing_ready").catch(() => false),
    invoke<boolean>("speech_ready").catch(() => false),
  ]);
  check.hidden = false;

  if (ears && mouth) {
    dot.dataset.state = "ok";
    text.textContent = "Ready — you can call your bots.";
    fine.hidden = true;
    setupNext.textContent = "Continue";
    setupNext.disabled = false;
    setupSkip.hidden = true;
    return;
  }

  dot.dataset.state = "wait";
  text.textContent = "Not set up yet.";
  fine.hidden = false;
  fine.textContent =
    "About 400 MB: a speech recogniser so it can hear you, and two dozen recorded voices so it " +
    "does not answer like a satnav. Nothing you say or it says leaves this machine, and Settings " +
    "can remove the voices later.";
  setupNext.textContent = "Set up voice";
  setupNext.disabled = false;
  // Skipping is a real answer here, so it is offered rather than implied.
  setupSkip.hidden = false;
}

/** Fetch both halves, reporting progress on the step. */
async function installVoice(): Promise<void> {
  voiceStep = "Starting…";
  paintSetup();
  try {
    if (!(await invoke<boolean>("hearing_ready").catch(() => false))) {
      await invoke("hearing_install");
    }
    if (!(await invoke<boolean>("speech_ready").catch(() => false))) {
      await invoke("speech_install");
    }
    voiceNames = [];
    await knownVoices();
  } catch (err) {
    toast(String(err));
  }
  voiceStep = "";
  paintSetup();
}

/** The step that decides what answers a bot, and arranges whichever was
 *  chosen. Three routes share one screen because they are one decision, and
 *  showing three separate steps would imply all three were needed. */
function paintAnswersStep(): void {
  const claudeCheck = $<HTMLDivElement>("#setup-claude-check");
  const text = $<HTMLSpanElement>("#setup-claude-text");
  const dot = $<HTMLSpanElement>("#setup-claude-check .setup__dot");
  const log = $<HTMLPreElement>("#setup-claude-log");
  const fine = $<HTMLParagraphElement>("#setup-claude-fine");

  claudeCheck.hidden = false;
  if (setupRoute === "claude-code") {
    paintClaudeStep();
    return;
  }

  log.hidden = true;
  fine.hidden = true;

  if (setupRoute === "ollama") {
    if (ollamaModels === null) {
      dot.dataset.state = "wait";
      text.textContent = "Looking for Ollama…";
      void invoke<Listing[]>("catalogue_search", {
        query: "",
        toolsOnly: false,
        provider: "ollama",
        limit: 60,
      })
        .then((models) => {
          ollamaModels = models.length;
          if (models.length && !setupPick) setupPick = models[0];
          paintSetup();
        })
        .catch(() => {
          ollamaModels = 0;
          paintSetup();
        });
      return;
    }
    if (!ollamaModels) {
      dot.dataset.state = "missing";
      text.textContent = "Ollama isn't running, or has nothing pulled.";
      fine.hidden = false;
      fine.textContent =
        "Install it from ollama.com, then run `ollama pull llama3`. Nothing leaves this machine, and there is nothing to pay for.";
      setupNext.textContent = "Look again";
      setupSkip.hidden = false;
      return;
    }
    dot.dataset.state = "ok";
    text.textContent = `${setupPick?.id ?? "a local model"} — ready, on this machine.`;
    return;
  }

  // Hosted.
  if (!setupPick) {
    dot.dataset.state = "missing";
    text.textContent = "No model chosen yet.";
    setupNext.textContent = "Choose a model";
    setupSkip.hidden = false;
    return;
  }
  dot.dataset.state = "ok";
  text.textContent = `${setupPick.name} — from ${setupPick.providerName}.`;
}

function paintClaudeStep(): void {
  const dot = $<HTMLSpanElement>("#setup-claude-check .setup__dot");
  const text = $<HTMLSpanElement>("#setup-claude-text");
  const log = $<HTMLPreElement>("#setup-claude-log");
  const fine = $<HTMLParagraphElement>("#setup-claude-fine");

  log.hidden = setupLog.length === 0;
  log.textContent = setupLog.join("\n");
  log.scrollTop = log.scrollHeight;

  if (claudeBusy) {
    dot.dataset.state = "busy";
    text.textContent = claudeBusy;
    fine.hidden = true;
    if (signInWaiting) {
      // The sign-in is finished in a browser, and botcage only finds out by
      // asking. It asks every couple of seconds anyway; this is for the person
      // who would rather not wait for the next one.
      setupNext.textContent = "Check again";
      setupSkip.hidden = false;
    }
    return;
  }

  const version = claudeState?.version?.split(" ")[0] ?? "";
  if (!claudeState?.path) {
    dot.dataset.state = "missing";
    text.textContent = "Not installed — about 220 MB.";
    fine.hidden = false;
    setupNext.textContent = "Install Claude Code";
    setupSkip.hidden = false;
    return;
  }
  fine.hidden = true;
  if (!claudeState.signedIn) {
    dot.dataset.state = "missing";
    text.textContent = claudeState.trouble
      ? `Claude Code ${version} — ${claudeState.trouble}.`
      : `Claude Code ${version} is installed, but not signed in.`;
    setupNext.textContent = "Sign in";
    setupSkip.hidden = false;
    return;
  }
  dot.dataset.state = "ok";
  const who = claudeState.email ?? "signed in";
  text.textContent = claudeState.plan
    ? `Claude Code ${version} · ${who} · ${claudeState.plan}`
    : `Claude Code ${version} · ${who}`;
}

function paintEngineStep(): void {
  const dot = $<HTMLSpanElement>("#setup-engine-check .setup__dot");
  const text = $<HTMLSpanElement>("#setup-engine-text");
  const fine = $<HTMLParagraphElement>("#setup-engine-fine");
  fine.hidden = true;

  if (installing) {
    dot.dataset.state = "busy";
    text.textContent = engineStep || "Setting up…";
    return;
  }
  if (engine?.supported === false) {
    dot.dataset.state = "missing";
    text.textContent = "botcage has no engine for this platform yet.";
    return;
  }
  if (engine?.installed) {
    dot.dataset.state = "ok";
    text.textContent = "Ready — bots can be given a computer.";
    return;
  }
  dot.dataset.state = "missing";
  text.textContent = `Not set up — about ${engine?.downloadMb ?? 0} MB to download.`;
  fine.hidden = false;
  fine.textContent =
    "The desktop image is built the first time a bot switches its computer on, which takes a few more minutes.";
  setupNext.textContent = "Set it up";
  setupSkip.hidden = false;
}

function paintDoneStep(): void {
  const blurb = $<HTMLParagraphElement>("#setup-done-blurb");
  if (stepSatisfied("answers")) {
    blurb.textContent = "Everything botcage needs is in place.";
  } else {
    blurb.textContent =
      "Nothing can answer a bot yet. Reopen this from the account menu when you're ready, or change what answers in any bot's settings.";
  }
  setupNext.textContent = "Start using botcage";
}

/** Keep what was chosen, so the first bot is made with it rather than with
 *  whatever the app happened to default to before anyone was asked. */
function rememberRoute(): void {
  const settings = appSettings();
  if (setupRoute === "claude-code") {
    state.app = { ...settings, engine: DEFAULT_ENGINE, provider: undefined, model: settings.model };
  } else if (setupPick) {
    state.app = {
      ...settings,
      engine: "openai-compatible",
      provider: setupPick.provider,
      model: setupPick.id,
    };
  }

  // The bots a fresh install starts with were made before anyone was asked
  // this, and were therefore all pointed at Claude Code. Any of them nobody has
  // spoken to yet should use what was just chosen — otherwise someone who picks
  // Ollama gets five bots that fail on their first message, which is a poor
  // reward for having answered the question. A bot with a conversation keeps
  // whatever has been answering it.
  const chosen = appSettings();
  for (const bot of state.bots) {
    if (bot.messages.length || bot.started) continue;
    bot.engine = chosen.engine ?? DEFAULT_ENGINE;
    bot.provider = chosen.provider;
    bot.model = chosen.model;
  }

  save();
  renderRoster();
}

function goTo(step: SetupStep): void {
  // Which way the carousel is travelling, so a step arrives from the side you
  // are going towards and leaves towards the side you came from.
  setupWay =
    SETUP_STEPS.indexOf(step) < SETUP_STEPS.indexOf(setupAt) ? "back" : "on";
  setupAt = step;
  setupLog = [];
  paintSetup();
}

/** The primary button does whatever the step still needs, and only moves on
 *  once there is nothing left to do. */
async function setupAdvance(): Promise<void> {
  if (setupAt === "welcome") {
    const called = $<HTMLInputElement>("#setup-name").value.trim();
    if (called) {
      state.app = { ...appSettings(), name: called };
      save();
      paintAccount();
    }
    return goTo("answers");
  }
  if (setupAt === "done") return closeSetup();

  if (setupAt === "answers") {
    if (stepSatisfied("answers")) {
      rememberRoute();
      return goTo("engine");
    }

    if (setupRoute === "ollama") {
      // Ask again: someone who just installed Ollama in another window should
      // not have to restart botcage to be believed.
      ollamaModels = null;
      paintSetup();
      return;
    }

    if (setupRoute === "hosted") {
      await openModels((model) => {
        setupPick = model;
        paintSetup();
      });
      return;
    }

    if (signInWaiting) {
      await refreshClaude();
      if (claudeState?.signedIn) stopSignInWatch();
      paintSetup();
      return;
    }
    if (!claudeState?.path) return installClaude();
    return startSignIn();
  }

  if (setupAt === "engine") {
    if (stepSatisfied("engine")) return goTo("voice");
    try {
      await installEngine();
      toast("Engine ready");
    } catch (err) {
      toast(String(err));
    }
    paintSetup();
    return;
  }

  if (setupAt === "voice") {
    const [ears, mouth] = await Promise.all([
      invoke<boolean>("hearing_ready").catch(() => false),
      invoke<boolean>("speech_ready").catch(() => false),
    ]);
    if (ears && mouth) return goTo("done");
    await installVoice();
  }
}

async function installClaude(): Promise<void> {
  claudeBusy = "Installing…";
  setupLog = [];
  paintSetup();
  try {
    await invoke<string>("install_claude");
    await refreshClaude();
    claudeBusy = "";
    paintSetup();
    // Installed but signed out is the normal outcome, and the step now asks for
    // exactly that rather than looking finished. Only say "installed" if the
    // binary is actually there, whatever the installer reported.
    if (claudeState?.path && !claudeState.signedIn) toast("Claude Code installed — sign in next");
  } catch (err) {
    claudeBusy = "";
    setupLog = [...setupLog, String(err)];
    paintSetup();
    toast(String(err));
  }
}

/** Hand off to a terminal, then watch for the account to appear. Polling is the
 *  honest mechanism here: the sign-in happens in another process and a browser,
 *  and neither reports back to us. */
async function startSignIn(): Promise<void> {
  try {
    await invoke("claude_sign_in");
  } catch (err) {
    toast(String(err));
    return;
  }
  claudeBusy = "Waiting for you to finish signing in…";
  signInWaiting = true;
  paintSetup();

  stopSignInWatch();
  const until = Date.now() + 10 * 60 * 1000;
  signInWatch = window.setInterval(() => {
    void refreshClaude().then(() => {
      if (claudeState?.signedIn) {
        stopSignInWatch();
        paintSetup();
        toast("Signed in");
      } else if (Date.now() > until) {
        stopSignInWatch();
        paintSetup();
      }
    });
  }, 2000);
}

function stopSignInWatch(): void {
  if (signInWatch !== null) window.clearInterval(signInWatch);
  signInWatch = null;
  signInWaiting = false;
  claudeBusy = "";
}

setupNext.addEventListener("click", () => void setupAdvance());
setupBack.addEventListener("click", () => {
  const index = SETUP_STEPS.indexOf(setupAt);
  if (index > 0) goTo(SETUP_STEPS[index - 1]);
});
setupSkip.addEventListener("click", () => {
  stopSignInWatch();
  const index = SETUP_STEPS.indexOf(setupAt);
  goTo(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]);
});

/* ------------------------------------------------------- phone access settings */

interface RemoteStatus {
  running: boolean;
  port: number;
  code: string | null;
  codeExpiresIn: number;
  devices: PairedDevice[];
}

interface PairedDevice {
  id: string;
  name: string;
  /** "ios" or "android" — absent for devices paired before this was recorded. */
  platform: string | null;
}

/** This machine's peer-to-peer identity — the address a phone pairs with, which
 *  keeps working when the laptop changes network. */
let peerId: string | null = null;

const appRemote = $<HTMLInputElement>("#app-remote");
const remoteQr = $<HTMLCanvasElement>("#app-remote-qr");
const remoteWhere = $<HTMLSpanElement>("#app-remote-where");
/* --------------------------------------------------------- push to a phone */

/** Say where this stands: set up and for which app, or what is missing.
 *
 *  The key is the one thing botcage cannot do for you — Apple issues it once,
 *  to the person with the account — so the row says so plainly rather than
 *  offering a switch that would do nothing. */
async function paintPush(): Promise<void> {
  const says = $<HTMLSpanElement>("#app-push-says");
  const forget = $<HTMLButtonElement>("#app-push-forget");
  const state = await invoke<{ ready: boolean; keyId?: string; topic?: string }>("push_state").catch(
    () => ({ ready: false }) as { ready: boolean; keyId?: string; topic?: string },
  );
  forget.hidden = !state.ready;
  says.textContent = state.ready
    ? `Key ${state.keyId} · sending to ${state.topic}. Your laptop talks to Apple directly; nothing else is in between.`
    : "Needs an APNs key from your Apple developer account — Keys, then a key with Apple Push Notifications on. The .p8 downloads once.";
}

const remotePairing = $<HTMLDivElement>("#app-remote-pairing");
// The caption belongs to the card and goes with it: a heading over nothing is
// worse than no heading.
const remotePairingCap = $<HTMLParagraphElement>("#app-remote-pairing-cap");
const remoteCode = $<HTMLSpanElement>("#app-remote-code");
const remoteHint = $<HTMLSpanElement>("#app-remote-hint");
const remoteDevices = $<HTMLSpanElement>("#app-remote-devices");
const remoteKey = $<HTMLSpanElement>("#app-remote-key");
const remoteNewCode = $<HTMLButtonElement>("#app-remote-new-code");
const remoteList = $<HTMLDivElement>("#app-remote-list");
// Not `number`: the QR encoder's types pull in Node's, where a timer is an
// object rather than a handle.
let codeTimer: ReturnType<typeof setInterval> | null = null;

function paintRemote(status: RemoteStatus): void {
  appRemote.checked = status.running;
  remotePairing.hidden = !status.running;
  remotePairingCap.hidden = !status.running;

  // There is one way in and it is the same everywhere, so this says what the
  // connection is rather than listing addresses that no longer mean anything.
  if (!status.running) {
    remoteWhere.textContent = "Off.";
  } else if (peerId) {
    remoteWhere.textContent =
      "Anywhere — encrypted end to end, and nothing is open on your network.";
  } else {
    remoteWhere.textContent = "Starting the connection…";
  }

  // Sixty-four characters in groups of eight: still long, but a person can
  // hold one group in their head at a time, which is the difference between
  // typeable and not.
  remoteKey.textContent = peerId
    ? (peerId.match(/.{1,8}/g) ?? [peerId]).join(" ")
    : "starting…";

  remoteDevices.textContent = status.devices.length
    ? `${status.devices.length} device${status.devices.length === 1 ? "" : "s"} can reach this machine.`
    : "None yet.";
  remoteList.replaceChildren(...status.devices.map(deviceRow));

  // A code is only worth showing while someone is looking at it: it lasts five
  // minutes and is spent on first use. So the square appears when there is one
  // and asks for a new one when there is not — rather than leaving the panel
  // empty with the switch on, which is what happened after a restart restored
  // phone access, and again five minutes after every pairing.
  if (status.code) {
    remoteCode.textContent = status.code;
    remoteCode.hidden = false;
    remoteNewCode.hidden = true;
    const minutes = Math.max(1, Math.round(status.codeExpiresIn / 60));
    remoteHint.textContent = `Expires in ${minutes} min, and works once.`;
    void paintPairingCode(status.code);
  } else {
    remoteCode.hidden = true;
    remoteQr.hidden = true;
    remoteNewCode.hidden = false;
    remoteHint.textContent = "Pair another device whenever you like.";
  }
}

/** Draw the address and the code as one square, so pairing is a single scan
 *  rather than a 187-character paste. Both halves have to be there: the address
 *  says which machine, the code proves you are standing in front of it. */
/** One paired phone. The platform comes from the device itself; for anything
 *  paired before that was recorded, the name usually still gives it away. */
function deviceRow(device: PairedDevice): HTMLElement {
  const kind =
    device.platform ??
    (/iphone|ipad|ios/i.test(device.name) ? "ios" : /android|pixel|galaxy/i.test(device.name) ? "android" : null);

  const row = document.createElement("div");
  row.className = "device";
  row.innerHTML =
    `<svg><use href="#i-${kind === "android" ? "android" : "ios"}" /></svg>` +
    `<span class="device__name"></span>` +
    `<span class="device__kind">${kind === "android" ? "Android" : kind === "ios" ? "iPhone" : ""}</span>` +
    `<button type="button" class="device__forget" title="Forget this device">${icon("x")}</button>`;
  // Set as text, never as markup: the name is whatever the phone called itself.
  row.querySelector(".device__name")!.textContent = device.name;

  // One device at a time: a phone you lost should not cost you the others.
  row.querySelector(".device__forget")!.addEventListener("click", async () => {
    await invoke("remote_forget_device", { id: device.id }).catch((err) => toast(String(err)));
    await refreshRemote();
    toast(`${device.name} can no longer reach this machine`);
  });
  return row;
}

async function paintPairingCode(code: string): Promise<void> {
  const address = await invoke<string | null>("p2p_address").catch(() => null);
  if (!address) {
    remoteQr.hidden = true;
    return;
  }
  try {
    await QRCode.toCanvas(remoteQr, JSON.stringify({ peer: address, code }), {
      // Drawn at twice the size it is shown at. The payload needs a 63-module
      // grid, which at 220 physical pixels is three and a half pixels per
      // module — fine to look at, and too fine for a camera on a Retina screen.
      width: 440,
      margin: 1,
      // Black on white regardless of the app's theme: a camera reads contrast,
      // not design.
      color: { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    // toCanvas writes its own inline width and height, which beat the
    // stylesheet — so a square drawn at 440 for sharpness is also *displayed*
    // at 440 and bursts a 380px sheet. Set the display size back afterwards.
    remoteQr.style.width = "220px";
    remoteQr.style.height = "220px";
    remoteQr.hidden = false;
  } catch {
    // A QR that will not draw is not worth an error — the code and the copy
    // button below it do the same job.
    remoteQr.hidden = true;
  }
}

async function refreshRemote(): Promise<void> {
  const [status, id] = await Promise.all([
    invoke<RemoteStatus>("remote_status").catch(() => null),
    invoke<string | null>("p2p_id").catch(() => null),
  ]);
  peerId = id;
  if (status) paintRemote(status);
}

/** Bring up the local server and the peer endpoint. Used by the switch and at
 *  launch, so the two cannot drift apart. */
async function startRemote(): Promise<void> {
  await invoke("remote_start");
  // Failing this is not fatal — the local server is still there — but a phone
  // away from the house has no other way in, so it is worth saying.
  peerId = await invoke<string>("p2p_start").catch((err) => {
    toast(`Phone access is on, but not reachable yet: ${err}`);
    return null;
  });
}

appRemote.addEventListener("change", async () => {
  try {
    if (appRemote.checked) {
      await startRemote();
      // A fresh code every time it is switched on: one that was read out and
      // then abandoned should not still work later.
      await invoke<string>("remote_pairing_code");
    } else {
      await invoke("remote_stop");
    }
    state.app = { ...appSettings(), remoteOn: appRemote.checked };
    save();
  } catch (err) {
    appRemote.checked = false;
    toast(String(err));
  }
  await refreshRemote();
});

/** Make sure there is something to scan when someone is looking at this panel.
 *
 *  A code lasts five minutes and is spent on first use, so one that exists only
 *  because the tab is open costs nothing — and a pairing screen that asks you
 *  to press a button before it will pair is a step that exists for the
 *  program's benefit rather than the person's. */
async function ensurePairingCode(): Promise<void> {
  const status = await invoke<RemoteStatus>("remote_status").catch(() => null);
  if (!status?.running || status.code) return;
  await invoke<string>("remote_pairing_code").catch(() => null);
  await refreshRemote();
}

// Opening the Phone tab is the moment someone means to pair. Opening settings
// on General is not, so nothing is minted until the panel is actually shown.
$<HTMLElement>("#app-settings")
  .querySelectorAll<HTMLButtonElement>('.tab[data-tab="phone"]')
  .forEach((tab) => tab.addEventListener("click", () => void ensurePairingCode()));

remoteNewCode.addEventListener("click", async () => {
  await invoke<string>("remote_pairing_code").catch((err) => toast(String(err)));
  await refreshRemote();
});

$<HTMLButtonElement>("#app-remote-copy").addEventListener("click", async () => {
  // The full address, not just the key: it saves the phone a lookup on its
  // first connection, and the key inside it is what keeps working afterwards.
  const address = await invoke<string | null>("p2p_address").catch(() => null);
  if (!address) {
    toast("The connection isn't up yet — try again in a moment");
    return;
  }
  await copy(address);
});

$<HTMLButtonElement>("#app-push-pick").addEventListener("click", async () => {
  const keyId = $<HTMLInputElement>("#app-push-key-id").value.trim();
  const team = $<HTMLInputElement>("#app-push-team").value.trim();
  if (!keyId || !team) {
    toast("The key id and team id are on the page Apple gave you the key from");
    return;
  }
  // The same lazy import the folder pickers use: the dialog plugin is a
  // hundred kilobytes nobody needs until they open a picker.
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    title: "The .p8 Apple gave you",
    filters: [{ name: "APNs key", extensions: ["p8"] }],
    multiple: false,
    directory: false,
  }).catch(() => null);
  if (typeof picked !== "string") return;
  try {
    // The phone's own identifier, which is what Apple calls the topic.
    await invoke("push_setup", { path: picked, keyId, teamId: team, topic: "com.botcage.phone" });
    toast("Key saved — your phone will be told the next time something happens");
  } catch (err) {
    toast(String(err));
  }
  void paintPush();
});

$<HTMLButtonElement>("#app-push-forget").addEventListener("click", async () => {
  await invoke("push_forget").catch(() => {});
  toast("Key forgotten and deleted");
  void paintPush();
});

$<HTMLButtonElement>("#app-remote-forget").addEventListener("click", async () => {
  await invoke("remote_forget_devices").catch(() => {});
  await refreshRemote();
  toast("Paired devices forgotten");
});

/* --------------------------------------------------------------- phone client */
/* A paired phone drives this window rather than talking to a second copy of the
   app. Rust holds the socket and forwards each request here; every answer below
   goes through the same functions the desktop UI uses, so the two cannot drift
   apart and nothing is implemented twice. */

interface RemoteRequest {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

/** What a phone needs to draw the whole app. Deliberately not the raw store:
 *  session ids and internal flags are of no use to a client and no business of
 *  the network. */
function remoteSnapshot(): Record<string, unknown> {
  return {
    activeId: state.activeId,
    // The name resolved rather than the field: with nothing set, the laptop
    // falls back to the login name, and the phone has no way of knowing what
    // that is. Sending the empty field left the phone calling you "You" and,
    // worse, unable to tell when a bot had said your name.
    settings: { ...appSettings(), name: userName() },
    claudeReady,
    // What could answer for a bot, so the phone offers the same choice as the
    // laptop rather than a list of its own that drifts.
    engines: engineChoices,
    // The same reason: the manners are derived from a hash the phone has no
    // business reimplementing, and a list of its own would go stale the day
    // one is added.
    manners: MANNERS.map((m) => ({ key: m.key, name: m.name })),
    // What is blocked on you. Worked out here because the answer depends on
    // things the phone does not have — which engines this machine can run —
    // and because a second implementation would disagree with the first about
    // what counts, which is the one thing a list like this cannot afford.
    desk: onYourDesk(),
    bots: state.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      color: bot.color,
      shape: bot.shape,
      // What it looks like, so the phone can draw the same creature rather
      // than a coloured circle. Only the overrides travel: the rest is derived
      // from the id, which the phone already has.
      face: bot.face,
      engine: bot.engine ?? DEFAULT_ENGINE,
      provider: bot.provider,
      model: bot.model,
      computer: bot.computer,
      network: bot.network,
      plugins: bot.plugins ?? [],
      routines: bot.routines ?? [],
      // How it writes, when it works, and what it has cost. The phone shows
      // all three and can change the first two; the tab is a fact and is
      // read-only wherever it is shown.
      manner: bot.manner,
      hours: bot.hours,
      spend: bot.spend,
      busy: inflight.has(bot.id),
      // What it says it can do, so the phone can offer the same "/" list.
      commands: bot.commands,
      messages: bot.messages,
      seenAt: bot.seenAt,
      // the phone renders the same mark on its own side
    })),
    // Rooms and the threads hanging off them, so a phone sees the same app
    // rather than an older one. Members by id: the phone already has the bots.
    channels: channels().map((ch) => ({
      id: ch.id,
      name: ch.name,
      purpose: ch.purpose,
      members: ch.members,
      messages: ch.messages,
      seenAt: ch.seenAt,
      muted: ch.muted,
      from: ch.from,
      busy: membersOf(ch).some((b) => inflight.get(b.id)?.channelId === ch.id),
    })),
  };
}

/** Send as a bot, from the phone. Routed through respond() so the desktop shows
 *  the same conversation as it happens, rather than the two diverging until a
 *  reload. */
function remoteSend(botId: string, text: string): Record<string, unknown> {
  const bot = state.bots.find((b) => b.id === botId);
  if (!bot) throw new Error("no such bot");
  if (inflight.has(bot.id)) throw new Error("this bot is already working on something");

  // Whatever answers for *this* bot, which is not necessarily Claude Code —
  // and the reason it cannot answer is worth carrying to the phone, since the
  // fix is on the laptop and the person holding the phone may not be near it.
  const answering = engineChoices.find((info) => info.key === (bot.engine ?? DEFAULT_ENGINE));
  if (answering && !answering.ready.usable) {
    throw new Error(`${answering.name} is ${answering.ready.missing ?? "not available"} on the desktop`);
  }
  if (!answering && !claudeReady) {
    throw new Error("Claude Code isn't installed or signed in on the desktop");
  }

  const clean = text.trim();
  if (!clean) throw new Error("nothing to send");

  const msg: Message = { id: uid(), from: "me", text: clean, at: Date.now(), fromPhone: true };
  bot.messages.push(msg);
  if (bot.id === state.activeId) {
    if (bot.messages.length === 1) thread.innerHTML = "";
    thread.append(turnEl(msg, undefined, bot.messages[bot.messages.length - 2]));
    arrived();
  }
  save();
  renderRoster();
  void respond(bot, clean);
  return { id: msg.id };
}

const REMOTE_ACTIONS: Record<string, (payload: Record<string, unknown>) => unknown> = {
  state: () => remoteSnapshot(),

  send: (p) => remoteSend(String(p.botId ?? ""), String(p.text ?? "")),

  /** Say something in a room, from the phone. Routed exactly as it is on the
   *  laptop — the same mentions, the same hop budget, the same everything —
   *  because it is the same function. */
  "channel/send": (p) => {
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    if (!room) throw new Error("no such channel");
    const text = String(p.text ?? "").trim();
    if (!text) throw new Error("nothing to say");

    // Opened first so the message lands on screen here too, and so what the
    // phone said is marked read rather than coming back as an unread badge.
    openChannel(room.id);
    postToChannel(room, text);
    return { ok: true };
  },

  /** Open a new room from the phone.
   *
   *  Members are chosen here rather than added afterwards because a room with
   *  nobody in it cannot be talked to, and the laptop's own form works the
   *  same way. Ids that name no bot are dropped instead of refused: a phone
   *  holding a snapshot from before a firing should still be able to make the
   *  room it was going to make. */
  "channel/create": (p) => {
    const name = handle(String(p.name ?? ""));
    if (!name) throw new Error("that name has nothing in it");
    const taken = channels().some((c) => !c.from && c.name === name);
    if (taken) throw new Error(`there is already a #${name}`);

    const wanted = Array.isArray(p.members) ? p.members.map(String) : [];
    const made: Channel = {
      id: uid(),
      name,
      purpose: String(p.purpose ?? "").trim(),
      members: wanted.filter((id) => state.bots.some((b) => b.id === id)),
      messages: [],
      seats: {},
    };
    channels().push(made);
    openChannel(made.id);
    save();
    renderRoster();
    return { id: made.id };
  },

  /** Rename a room, say what it is for, or change who is in it.
   *
   *  Only what the laptop's own form offers, and only fields that were sent:
   *  a phone editing the name should not silently empty the purpose it never
   *  showed. */
  "channel/update": (p) => {
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    if (!room) throw new Error("no such channel");

    if (typeof p.name === "string") {
      const name = handle(p.name);
      if (!name) throw new Error("that name has nothing in it");
      const taken = channels().some((c) => !c.from && c.name === name && c.id !== room.id);
      if (taken) throw new Error(`there is already a #${name}`);
      room.name = name;
    }
    if (typeof p.purpose === "string") room.purpose = p.purpose.trim();
    if (typeof p.muted === "boolean") {
      if (p.muted) room.muted = true;
      else delete room.muted;
    }
    if (Array.isArray(p.members)) {
      room.members = p.members.map(String).filter((id) => state.bots.some((b) => b.id === id));
    }

    save();
    renderRoster();
    renderChannel();
    return { ok: true };
  },

  /** Close a room for good, from the phone. Its threads go with it, by the
   *  same route the laptop's own button takes. */
  "channel/delete": (p) => {
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    if (!room) throw new Error("no such channel");
    const went = removeChannel(room);
    save();
    renderRoster();
    renderThread();
    return { went };
  },

  /** Press one of a bot's answers, from the phone.
   *
   *  The same two things the laptop's own button does, in the same order: mark
   *  which was chosen so the row stops offering the others, then send it as
   *  though it had been typed. It goes through the ordinary send, so a bot
   *  needs no notion of where an answer came from. */
  "message/answer": (p) => {
    const messageId = String(p.messageId ?? "");
    const answer = String(p.answer ?? "").trim();
    if (!answer) throw new Error("nothing chosen");

    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    const bot = state.bots.find((b) => b.id === String(p.botId ?? ""));
    const msg = (room ? room.messages : (bot?.messages ?? [])).find((m) => m.id === messageId);
    if (!msg?.ask) throw new Error("that message is not asking anything");
    if (!msg.ask.options.includes(answer)) throw new Error("that is not one of the answers");
    if (msg.ask.answered) throw new Error("that has been answered already");

    // The same door the laptop's own buttons use, so there is one account of
    // what pressing an answer does.
    answerAsk({ botId: bot?.id, channelId: room?.id, messageId }, answer);
    return { ok: true };
  },

  /** Mark a room read, because reading it on the phone is reading it. */
  "channel/seen": (p) => {
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    if (!room) throw new Error("no such channel");
    room.seenAt = Date.now();
    save();
    renderRoster();
    return { ok: true };
  },

  /** Pin or unpin, from either side. */
  "message/pin": (p) => {
    const wanted = String(p.messageId ?? "");
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    const msg = room
      ? room.messages.find((m) => m.id === wanted)
      : state.bots.find((b) => b.id === String(p.botId ?? ""))?.messages.find((m) => m.id === wanted);
    if (!msg) throw new Error("no such message");
    msg.pinned = typeof p.pinned === "boolean" ? p.pinned : !msg.pinned;
    save();
    redrawConversation();
    return { pinned: Boolean(msg.pinned) };
  },

  /** Pull a message aside into a thread, from the phone. */
  "thread/start": (p) => {
    const room = channels().find((c) => c.id === String(p.channelId ?? ""));
    const msg = room?.messages.find((m) => m.id === String(p.messageId ?? ""));
    if (!room || !msg) throw new Error("no such message");
    const already = channels().find((c) => c.from?.messageId === msg.id);
    if (already) return { id: already.id };
    openThreadFrom(room, msg);
    return { id: channels().find((c) => c.from?.messageId === msg.id)?.id ?? "" };
  },

  cancel: (p) => {
    cancelTurn(String(p.botId ?? ""));
    return {};
  },

  open: (p) => {
    openBot(String(p.botId ?? ""));
    return {};
  },

  "bot/create": (p) => {
    const bot: Bot = {
      id: uid(),
      name: String(p.name ?? "New bot").slice(0, 40) || "New bot",
      role: String(p.role ?? ""),
      color: COLORS[state.bots.length % COLORS.length],
      shape: SHAPES[state.bots.length % SHAPES.length],
      messages: [],
      sessionId: crypto.randomUUID(),
      started: false,
      computer: false,
      network: "full",
      engine: appSettings().engine ?? engineChoices.find((info) => info.ready.usable)?.key ?? DEFAULT_ENGINE,
      provider: appSettings().provider,
      model: appSettings().model,
      plugins: [],
      routines: [],
    };
    state.bots.push(bot);
    state.activeId = bot.id;
    save();
    renderRoster();
    renderThread();
    return { id: bot.id };
  },

  "bot/update": (p) => {
    const bot = state.bots.find((b) => b.id === String(p.botId ?? ""));
    if (!bot) throw new Error("no such bot");
    // Only the fields a phone has any business setting.
    if (typeof p.name === "string") bot.name = p.name.slice(0, 40);
    if (typeof p.role === "string") bot.role = p.role;
    if (typeof p.model === "string") bot.model = p.model;
    // Only an engine this desktop actually has: a phone from a newer build must
    // not leave a bot pointed at something that cannot answer it.
    if (typeof p.engine === "string" && engineChoices.some((info) => info.key === p.engine)) {
      if (p.engine !== (bot.engine ?? DEFAULT_ENGINE)) {
        // Same reasoning as the sheet: the session id belonged to the old
        // engine, and the transcript botcage keeps carries the thread over.
        bot.engine = p.engine;
        bot.sessionId = newSessionId();
        bot.started = false;
      }
    }
    if (p.network === "full" || p.network === "no-lan" || p.network === "offline") {
      bot.network = p.network;
    }
    if (typeof p.computer === "boolean") bot.computer = p.computer;
    if (Array.isArray(p.plugins)) bot.plugins = p.plugins.map(String);
    // How it writes. Empty means back to the one its id chose, which is not
    // the same as "plain" and has to stay tellable apart.
    if (typeof p.manner === "string") {
      bot.manner = MANNERS.some((m) => m.key === p.manner) ? p.manner : undefined;
    }
    // When it works. Null is a shift removed; anything else is checked here
    // rather than trusted, because a phone from a newer build must not be able
    // to write a shape this one cannot read.
    if (p.hours === null) bot.hours = undefined;
    else if (p.hours && typeof p.hours === "object") {
      const shift = p.hours as { from?: unknown; to?: unknown; days?: unknown };
      const days = Array.isArray(shift.days)
        ? shift.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      if (typeof shift.from === "string" && typeof shift.to === "string" && days.length) {
        bot.hours = { from: tidyClock(shift.from), to: tidyClock(shift.to), days };
      }
    }
    save();
    renderRoster();
    return {};
  },

  /** Where Apple should deliver to this phone. Sent on every launch, so this
   *  replaces rather than accumulates: a token that has moved on is a phone
   *  the laptop only thinks it told. */
  "phone/push": (p) => {
    const token = String(p.token ?? "");
    if (!/^[0-9a-f]{32,200}$/i.test(token)) throw new Error("that is not a device token");
    const phones = (state.phones ?? []).filter((one) => one.token !== token);
    phones.push({
      token,
      sandbox: Boolean(p.sandbox),
      name: String(p.name ?? "a phone").slice(0, 60),
      at: Date.now(),
    });
    // Two phones is a person with two phones; twenty is a list nobody pruned.
    state.phones = phones.slice(-8);
    save();
    return {};
  },

  "bot/delete": (p) => {
    deleteBot(String(p.botId ?? ""));
    return {};
  },

  "routine/save": (p) => {
    const bot = state.bots.find((b) => b.id === String(p.botId ?? ""));
    if (!bot) throw new Error("no such bot");
    const routine = p.routine as Routine | undefined;
    if (!routine?.instruction) throw new Error("a routine needs something to do");
    bot.routines = bot.routines ?? [];
    const existing = bot.routines.findIndex((r) => r.id === routine.id);
    if (existing >= 0) bot.routines[existing] = routine;
    else bot.routines.push({ ...routine, id: routine.id || uid() });
    save();
    renderRoutines();
    return {};
  },

  "routine/delete": (p) => {
    const bot = state.bots.find((b) => b.id === String(p.botId ?? ""));
    if (!bot) throw new Error("no such bot");
    bot.routines = (bot.routines ?? []).filter((r) => r.id !== String(p.routineId ?? ""));
    save();
    renderRoutines();
    return {};
  },

  "desktop/start": (p) => {
    const bot = state.bots.find((b) => b.id === String(p.botId ?? ""));
    if (!bot) throw new Error("no such bot");
    if (!bot.computer) throw new Error("this bot has no computer");
    void invoke("sandbox_start", { botId: bot.id, brand: machineBrand(bot) });
    return {};
  },

  "desktop/stop": (p) => {
    void invoke("sandbox_stop", { botId: String(p.botId ?? "") });
    return {};
  },

  plugins: () => loadPlugins().then((list) => ({ plugins: list })),
};

void listen<RemoteRequest>("remote-request", async (event) => {
  const { id, kind, payload } = event.payload;
  const action = REMOTE_ACTIONS[kind];
  if (!action) {
    void invoke("remote_reply", { id, ok: false, payload: `botcage has no "${kind}" action` });
    return;
  }
  try {
    const result = await action(payload ?? {});
    void invoke("remote_reply", { id, ok: true, payload: result ?? {} });
  } catch (err) {
    void invoke("remote_reply", { id, ok: false, payload: String(err) });
  }
});

/* --------------------------------------------------------------------- boot */

load();
setPaneWidth(state.screenWidth ?? SCREEN_PANE.initial);
setPaneHeight(state.screenHeight ?? SCREEN_ROW.initial);
relayout();
renderRoster();
// Reopen whatever was on screen last. A room you were reading is as much
// "where you were" as a bot you were talking to.
if (activeChannel()) {
  paintTopbarFor(null);
  renderChannel();
} else {
  paintTopbarFor(activeBot());
  renderThread();
}
if (state.screenOpen) void openScreen();
// Settles every bot's voice on the first run after this exists, so nothing
// about a bot is still being calculated by the time you look at it.
void knownVoices();
autoGrow();
input.focus();

// Routines are checked here rather than in Rust: the state they read lives in
// the webview, and nothing can fire while the app is closed anyway.
window.setInterval(tickRoutines, 30_000);

// The same clock and the same caveat for backups. Checked rarely, because the
// gap being watched is a day at its shortest and a backup that runs while a bot
// is answering would only make the archive a moment older.
window.setInterval(() => {
  if (backupDue() && !inflight.size) void backupNow(true);
}, 5 * 60_000);

// A desktop you are watching should not be reaped for idleness.
window.setInterval(() => {
  if (screen.connected && screen.botId) void invoke("sandbox_keepalive", { botId: screen.botId });
}, 60_000);

void listen<BotEvent>("bot-event", (event) => handleBotEvent(event.payload));
void listen<SandboxEvent>("sandbox-event", (event) => handleSandboxEvent(event.payload));
paintAccount();

verifyCatalogue();

// What can answer for a bot, so the first sheet opened already offers the
// choice rather than showing one option and correcting itself.
void loadEngineChoices();

void invoke("set_idle_limit", { minutes: appSettings().idleMinutes }).catch(() => {});
// Re-assert on launch: the assertion belongs to the process that took it.
if (appSettings().awake) void invoke("set_awake", { on: true }).catch(() => {});

// First run walks through setup. Afterwards it only reappears when the thing
// bots actually depend on is missing, and opens at that step rather than at the
// welcome screen someone has already read.
// A phone paired at the kitchen table is no use if the laptop stops answering
// the moment botcage restarts, so phone access comes back by itself. No pairing
// code is shown — that stays a deliberate act.
if (appSettings().remoteOn) {
  void startRemote().catch((err) => toast(`Phone access could not start: ${err}`));
}

void refreshClaude().then(() => {
  // Reopened only when nothing at all can answer a bot. Someone who chose
  // Ollama or a hosted key should not be dragged back through a Claude Code
  // step they deliberately walked past.
  if (!appSettings().onboarded) void openSetup("welcome");
  else if (!somethingCanAnswer()) void openSetup("answers");
});
