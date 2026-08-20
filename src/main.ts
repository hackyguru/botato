/**
 * botcage — desktop bot roster + threads, modelled on the Grok bot app UI.
 *
 * Each bot is a Claude Code session: turns run through the local `claude` CLI
 * (see src-tauri/src/lib.rs), authenticated by the user's own login.
 */

import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  error?: string;
  kind?: "teach" | "routine";
  meta?: { steps: number; frames: number; slug: string; name?: string };
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
  /** Which of that engine's models. Named in the engine's own vocabulary, so
   *  "opus", "gemini-2.5-pro" and "anthropic/claude-sonnet-4" all live here. */
  model: string;
  routines?: Routine[];
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
  activeId: string | null;
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
  /** Setup has been walked through once. Reopenable from the account menu. */
  onboarded: boolean;
  /** The tour has been given once. Also reopenable from the account menu. */
  toured?: boolean;
  /** Phone access was switched on. Restored at launch: a paired phone away from
   *  the house cannot ask anyone to flip a switch on the laptop. */
  remoteOn: boolean;
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

const state: Persisted = { bots: [], activeId: null, app: { ...DEFAULT_APP } };

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
const composer = $<HTMLFormElement>("#composer");
const input = $<HTMLTextAreaElement>("#input");
const sendBtn = $<HTMLButtonElement>("#btn-send");
const sendIcon = $<SVGUseElement>("#send-icon");
const menu = $<HTMLDivElement>("#menu");
const sheetWrap = $<HTMLDivElement>("#sheet-wrap");
const sheet = $<HTMLFormElement>("#sheet");
const sheetName = $<HTMLInputElement>("#sheet-name");
const sheetRole = $<HTMLTextAreaElement>("#sheet-role");
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

/** Bots with a turn in flight, keyed by bot id. */
const inflight = new Map<string, { message: Message; sawText: boolean; note: string }>();

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
  sleep: {},
  // Events: they play and hand the face back to whatever the bot is doing.
  wave: { hold: 1300 },
  happy: { hold: 1800 },
  sad: { hold: 1800 },
  shrug: { hold: 1700 },
  alert: { hold: 1500 },
  dizzy: { hold: 1600 },
  peek: { hold: 900 },
  listen: { hold: 1400 },
  stretch: { hold: 1500 },
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
 *  mood change should not cost a repaint of any of them. */
function paintMoods(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".face[data-bot]")) {
    const botId = el.dataset.bot!;
    el.dataset.mood = moods.get(botId) ?? restingMood(botId);
  }
}

function faceHtml(bot: Bot, size: "sm" | "md" | "lg" = "md"): string {
  const cls = size === "md" ? "" : ` face--${size}`;
  const face = faceOf(bot);
  const mood = moods.get(bot.id) ?? restingMood(bot.id);
  // Every face carries every part, whatever its traits say — a mouth a bot does
  // not normally show is hidden rather than absent, so a mood can still open
  // one in surprise without the renderer knowing that mood exists.
  return (
    `<span class="face${cls}" data-bot="${bot.id}" data-mood="${mood}"` +
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

function save(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    /* storage unavailable — run in-memory */
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
    // A desktop is opt-in: a fresh install may not even have Docker.
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
    state.activeId = data.activeId ?? state.bots[0].id;
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

/* --------------------------------------------------------------- bot roster */

const activeBot = () => state.bots.find((b) => b.id === state.activeId) ?? null;

const lastOf = (bot: Bot): Message | undefined => bot.messages[bot.messages.length - 1];


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

  botsEl.innerHTML = hits
    .map((bot) => {
      const last = lastOf(bot);
      return (
        `<button class="bot-row${bot.id === state.activeId ? " is-active" : ""}" data-bot="${bot.id}">` +
        faceHtml(bot) +
        `<span class="bot-row__body">` +
        // Name and time, and nothing else. The second line used to carry the
        // last thing said, which is a chat app's habit rather than this app's
        // need: the bots are down the side, the conversation is in front of
        // you, and what a bot is doing this second is on its face — a thought
        // cloud says "typing" better than the word does.
        `<span class="bot-row__top"><span class="bot-row__name">${escapeHtml(bot.name)}</span>` +
        `<span class="bot-row__time">${last ? clock(last.at) : ""}</span></span>` +
        `</span></button>`
      );
    })
    .join("");
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

function bubbleHtml(msg: Message): string {
  const body = `<div class="md">${renderMd(msg.text)}</div>`;
  const clamp = msg.text.length > CLAMP_AT;
  const react = msg.reaction ? `<div class="reacts"><span class="react">${msg.reaction}</span></div>` : "";
  const phone = msg.fromPhone ? `<span class="from-phone" title="Sent from your phone">${icon("ios")}</span>` : "";
  return (
    `<div class="bubble${clamp ? " is-clamped" : ""}">` +
    `<div class="bubble__body">${body}</div>` +
    (clamp ? `<button type="button" class="more-btn">Show more ${icon("chev")}</button>` : "") +
    phone +
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

function turnEl(msg: Message): HTMLElement {
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

  wrap.className = `turn turn--${msg.from}`;
  wrap.innerHTML = msg.from === "me" ? actsHtml(msg) + bubbleHtml(msg) : bubbleHtml(msg) + actsHtml(msg);
  return wrap;
}

/** The live body element of a message, if that message is currently on screen. */
const bodyOf = (msgId: string) =>
  thread.querySelector<HTMLElement>(`[data-msg="${msgId}"] .bubble__body`);

function renderThread(): void {
  const bot = activeBot();
  if (!bot) {
    topbarId.innerHTML = "";
    thread.innerHTML = `<div class="empty"><h2>No bots yet</h2><p>Hit + to cage your first bot.</p></div>`;
    input.placeholder = "Message";
    return;
  }

  topbarId.innerHTML = `${faceHtml(bot, "sm")}<span>${escapeHtml(bot.name)}</span>`;
  input.placeholder = `Message ${bot.name}`;

  const live = (bot.routines ?? []).filter((r) => r.active).length;
  const routinesBtn = $<HTMLButtonElement>("#btn-routines");
  routinesBtn.title = live ? `${live} active routine${live === 1 ? "" : "s"}` : "Routines";
  $<HTMLSpanElement>("#btn-routines-count").textContent = live ? String(live) : "";

  if (!bot.messages.length) {
    // On a fresh install this is the whole app: one bot, nothing said yet. Say
    // where more come from, because a plus icon in a corner is not an answer to
    // "what now".
    const alone = state.bots.length === 1;
    thread.innerHTML =
      `<div class="empty">${faceHtml(bot, "lg")}<h2>${escapeHtml(bot.name)}</h2>` +
      (bot.guide ? "" : `<p>${escapeHtml(bot.role || "Say hello to get started.")}</p>`) +
      (alone && !bot.guide
        ? `<p class="empty__hint">Say hello. When you know what you want, ` +
          `make a bot for it with the <b>+</b> above the list — each one keeps ` +
          `its own memory, and can be answered by a different model.</p>`
        : "") +
      `</div>` +
      // Under the guide's own face rather than above it: this is what it is
      // offering, and a stack of cards over the top of an introduction reads
      // as though the introduction were an afterthought.
      (bot.guide ? lessonsHtml() : "");
  } else {
    thread.innerHTML = "";
    for (const msg of bot.messages) thread.append(turnEl(msg));
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

  syncSend();
  scrollToEnd();
}

function scrollToEnd(smooth = false): void {
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 180;

function waitingHtml(msgId: string, note: string): void {
  const body = bodyOf(msgId);
  if (!body) return;
  body.innerHTML = note
    ? `<p class="thinking"><span class="shimmer">${escapeHtml(note)}</span></p>`
    : `<div class="typing"><i></i><i></i><i></i></div>`;
}

/* ------------------------------------------------------------------ turns */

function systemPromptFor(bot: Bot): string {
  return [
    `You are "${bot.name}", one of several bots the user keeps in botcage, a desktop app where each bot is a persistent chat.`,
    // In the user's own words, whole. This used to be a one-line "what it does"
    // that read as a subtitle; it is now where someone describes a job, so it
    // is passed through rather than dressed up as a sentence.
    bot.role ? `What you are here to do, as the user described it:\n\n${bot.role}` : "",
    `You are talking in a chat window, so reply conversationally and keep it tight — a couple of short paragraphs unless depth is asked for. Markdown is rendered: bold, lists, and fenced code blocks all display properly.`,
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

const syncSend = () => setStreaming(inflight.has(state.activeId ?? ""));

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

async function respond(bot: Bot, prompt: string): Promise<void> {
  const message: Message = { id: uid(), from: "bot", text: "", at: Date.now() };
  bot.messages.push(message);
  inflight.set(bot.id, { message, sawText: false, note: "" });

  if (bot.id === state.activeId) {
    thread.append(turnEl(message));
    waitingHtml(message.id, "");
    scrollToEnd(true);
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
        systemPrompt: systemPromptFor(bot),
        model: bot.model || MODEL,
        botName: bot.name,
        botRole: bot.role,
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

function finish(botId: string, event: BotEvent): void {
  const pending = inflight.get(botId);
  const bot = state.bots.find((b) => b.id === botId);
  if (!pending || !bot) return;
  inflight.delete(botId);

  if (event.kind === "done") {
    const spend = event.detail as { costUsd?: number } | null;
    if (spend?.costUsd) {
      session.costUsd += spend.costUsd;
      session.turns += 1;
    }
    // The result field is authoritative; deltas can be shed under load.
    if (event.text && event.text.length > pending.message.text.length) {
      pending.message.text = event.text;
    }
    bot.started = true;
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
  if (botId === state.activeId) renderThread();
  else syncSend();

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
  if (from && !from.started) {
    from.started = true;
    save();
  }

  // What the bot's face does about it. Everything here is already in botcage's
  // vocabulary, so a mood costs a line rather than a new event.
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
        renderThread();
        toast(`${bot.name} changed how it looks`);
      })
      .catch(() => {});
  }

  if (event.kind === "done") setMood(event.botId, "happy");
  else if (event.kind === "error") setMood(event.botId, "sad");
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
  const live = event.botId === state.activeId;

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
  if (!live) return;

  const body = bodyOf(pending.message.id);
  if (!body) return;
  body.innerHTML = `<div class="md">${renderMd(pending.message.text)}</div>`;
  body.querySelector(".md")?.lastElementChild?.classList.add("caret");
  if (nearBottom()) scrollToEnd();
}

function send(text: string): void {
  const clean = text.trim();
  const bot = activeBot();
  if (!clean || !bot || inflight.has(bot.id)) return;
  if (!claudeReady) {
    toast("Claude Code CLI not found — install it to talk to your bots");
    return;
  }

  const wasEmpty = bot.messages.length === 0;
  const msg: Message = { id: uid(), from: "me", text: clean, at: Date.now() };
  bot.messages.push(msg);

  if (wasEmpty) thread.innerHTML = "";
  thread.append(turnEl(msg));

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

function renderSheetPreview(): void {
  const shape = SHAPES[state.bots.length % SHAPES.length];
  sheetPreview.innerHTML = `<span class="face face--${shape} face--lg" style="background:${draftColor}"><i></i><i></i></span>`;
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

/** Which week the calendar is showing. */
let calAt = weekStart(Date.now());

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
  const bot = activeBot();
  if (!bot) return;
  const routines = bot.routines ?? [];
  const now = new Date();
  const today = isoDate(now);

  const first = dayOfWeek(calAt, 0);
  const last = dayOfWeek(calAt, 6);
  const month = (day: Date) => day.toLocaleDateString(undefined, { month: "long" });
  $<HTMLSpanElement>("#cal-range").textContent =
    first.getMonth() === last.getMonth()
      ? `${first.getDate()}–${last.getDate()} ${month(first)}`
      : `${first.getDate()} ${month(first)} – ${last.getDate()} ${month(last)}`;

  const days = Array.from({ length: 7 }, (_, at) => dayOfWeek(calAt, at));

  $<HTMLDivElement>("#cal-days").innerHTML =
    `<div class="cal__day"></div>` +
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
  const often = routines.filter((r) => r.every === "hour" || r.every === "minutes");
  const band = $<HTMLDivElement>("#cal-often");
  band.hidden = often.length === 0 && routines.length > 0;
  band.innerHTML = routines.length
    ? often
        .map(
          (routine) =>
            `<button type="button" class="cal__chip${routine.active ? "" : " is-off"}" ` +
            `data-edit="${routine.id}"><i style="--tint:${bot.color}"></i>` +
            `<b>${escapeHtml(routine.name)}</b>` +
            `<span>${escapeHtml(describeRoutine(routine))}</span></button>`,
        )
        .join("")
    : `<div class="cal__empty">Nothing scheduled. Click any slot to give ` +
      `${escapeHtml(bot.name)} a standing instruction — routines run while botcage is open.</div>`;

  $<HTMLDivElement>("#cal-cols").innerHTML = days
    .map((day, column) => {
      const slots = Array.from(
        { length: 24 },
        (_, hour) => `<div class="cal__slot" data-col="${column}" data-hour="${hour}"></div>`,
      ).join("");

      const due = routines.filter((routine) => fallsOn(routine, day));

      // Two routines in the same hour would sit exactly on top of each other,
      // and the one underneath would be a routine nobody could see was there.
      // They share the width of the hour instead.
      //
      // And they never take all of it: an event that filled its hour would be
      // the only thing there to click, so that hour could never be given a
      // second routine — clicking it would open the first one, and saving would
      // edit it rather than add to it. The strip down the right stays empty and
      // clickable, which is what makes an hour able to hold two.
      const crowd = new Map<number, number>();
      for (const routine of due) {
        const hour = Number(routine.at.split(":")[0]) || 0;
        crowd.set(hour, (crowd.get(hour) ?? 0) + 1);
      }
      const placed = new Map<number, number>();

      const events = due
        .map((routine) => {
          const [hh, mm] = routine.at.split(":").map(Number);
          const hour = hh || 0;
          const of = crowd.get(hour) ?? 1;
          const lane = placed.get(hour) ?? 0;
          placed.set(hour, lane + 1);
          const top = (hour + (mm || 0) / 60) * HOUR_PX;
          // Stacked within the hour rather than side by side. A calendar
          // splits the width when two things overlap because both last an
          // hour; a routine is a moment, not a span, so splitting only makes
          // two unreadable slivers where the names should be.
          const slice = (HOUR_PX - 6) / of;
          const solo = of === 1;
          return (
            `<button type="button" class="cal__event${solo ? "" : " cal__event--tight"}` +
            `${routine.active ? "" : " is-off"}" data-edit="${routine.id}" ` +
            `style="top:${top + lane * slice}px;height:${slice - (solo ? 0 : 2)}px;` +
            `right:${FREE_PX}px;--tint:${bot.color}">` +
            `<b>${escapeHtml(routine.name)}</b>` +
            // The time only when there is room for it; when there is not, it is
            // the one thing already obvious from where the block is.
            (solo ? `<span>${routine.at}</span>` : "") +
            `</button>`
          );
        })
        .join("");

      const isToday = isoDate(day) === today;
      const line = isToday
        ? `<div class="cal__now" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>`
        : "";

      return `<div class="cal__col${isToday ? " is-today" : ""}">${slots}${events}${line}</div>`;
    })
    .join("");
}

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
  sheetComputer.checked = bot?.computer ?? false;
  sheetNetwork.value = bot?.network ?? "full";
  draftModel = {
    provider: bot?.provider ?? (bot ? undefined : appSettings().provider),
    model: bot?.model ?? (appSettings().engine ? appSettings().model : ""),
  };
  paintSheetEngines(bot);
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
  renderSheetPreview();
  // Only an existing bot can be deleted, and the confirm never carries over
  // from a previous visit to this sheet.
  sheetDelete.hidden = !bot;
  disarmDelete();
  showSheetTab("general");
  sheetWrap.hidden = false;
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
  sheetWrap.hidden = true;
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
    sheetWrap.hidden = true;
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
  state.bots.unshift(bot);
  state.activeId = bot.id;
  sheetWrap.hidden = true;
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

/* ------------------------------------------------------------ app settings */

const appWrap = $<HTMLDivElement>("#app-settings");
const appModel = $<HTMLSelectElement>("#app-model");
const appScreen = $<HTMLSelectElement>("#app-screen");
const appIdle = $<HTMLSelectElement>("#app-idle");
const appRoutines = $<HTMLInputElement>("#app-routines");
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

async function openAppSettings(): Promise<void> {
  showSettingsTab("general");
  const settings = appSettings();
  appModel.value = settings.model;
  appScreen.value = settings.screen;
  appIdle.value = String(settings.idleMinutes);
  appRoutines.checked = settings.routinesOn;
  appAwake.checked = settings.awake;
  appWrap.hidden = false;

  void refreshRemote();
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

function saveAppSettings(): void {
  state.app = {
    model: appModel.value,
    screen: appScreen.value,
    idleMinutes: Number(appIdle.value),
    routinesOn: appRoutines.checked,
    awake: appAwake.checked,
    onboarded: appSettings().onboarded,
    remoteOn: appSettings().remoteOn,
  };
  save();
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

/** The main pane shows either the conversation or this bot's week. */
function showRoutines(open: boolean): void {
  routinesOpen = open;
  $<HTMLElement>(".main").classList.toggle("is-routines", open);
  $<HTMLElement>("#routines").hidden = !open;
  $<HTMLButtonElement>("#btn-routines").classList.toggle("is-on", open);
  routineWrap.hidden = true;
  if (!open) {
    renderThread();
    return;
  }

  // Opening always lands on this week, wherever it was left.
  calAt = weekStart(Date.now());
  renderRoutines();
  // Start where the day is rather than at midnight, with enough above it to see
  // what has just been and gone.
  const body = $<HTMLDivElement>("#cal-body");
  body.scrollTop = Math.max(0, (new Date().getHours() - 2) * HOUR_PX);
}

/** Run a routine now, from the clock or from the Run now button. */
function runRoutine(bot: Bot, routine: Routine): void {
  if (inflight.has(bot.id)) {
    toast(`${bot.name} is busy — try again when it has finished`);
    return;
  }

  routine.lastRunAt = Date.now();
  // Something arrived that nobody typed, so the bot says so before it starts.
  setMood(bot.id, "alert");
  // A task, not a routine: it has now happened, and should not happen again.
  if (routine.every === "once") routine.active = false;
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
    thread.append(turnEl(note));
    scrollToEnd(true);
  }
  save();
  renderRoster();
  void respond(bot, routine.instruction);
}

/** Fire anything due. This runs while the app is open; there is no daemon. */
function tickRoutines(): void {
  if (!appSettings().routinesOn) return;
  const now = Date.now();

  for (const bot of state.bots) {
    if (inflight.has(bot.id)) continue;

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
  "no-docker":
    "A bot's computer runs in a Linux container, and this machine has no engine to run one. " +
    "On macOS, OrbStack or colima are the lightest; on Linux, install podman or docker.io from " +
    "your package manager. Everything else in botcage works without it.",
  "no-computer":
    "This bot doesn't have a computer. Turn on Own computer in its settings to give it one — routines below work either way.",
};

function pushLog(line: string): void {
  screen.log.push(line);
  paintScreen();
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

  screenMessage.textContent = engineStep || STATE_MESSAGE[screen.state];

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

async function openScreen(): Promise<void> {
  const bot = activeBot();
  if (!bot) return;


  screen.botId = bot.id;
  screen.log = [];
  screen.control = false;
  screen.state = "stopped";
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

  const docker = await invoke<{ path: string | null; version: string | null; error: string | null }>(
    "docker_info",
  );
  if (!docker.version) {
    // Ask whether botcage could supply one itself, so the pane can offer that
    // rather than only naming things to go and install.
    engine = await invoke<EngineStatus>("engine_status").catch(() => null);
    screen.state = "no-docker";
    if (docker.error) screen.log = [docker.error];
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

  const sidebar = railed ? 66 : 268;
  const chatWidth = appEl.clientWidth - sidebar - (state.screenWidth ?? SCREEN_PANE.initial);
  appEl.classList.toggle("is-stacked", !screenPane.hidden && chatWidth < MIN_CHAT_WIDTH);

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
  thread.append(turnEl(msg));
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
  void invoke("sandbox_start", {
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
  }).catch((err) => {
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
  const bot = activeBot();
  if (bot && inflight.has(bot.id)) {
    cancelTurn(bot.id);
    return;
  }
  if (!input.value.trim()) return;
  send(input.value);
});

input.addEventListener("input", autoGrow);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});

$<HTMLButtonElement>("#btn-routines").addEventListener("click", () => showRoutines(!routinesOpen));

$<HTMLButtonElement>("#btn-settings").addEventListener("click", () => {
  const bot = activeBot();
  if (bot) openSheet(bot);
});

$<HTMLButtonElement>("#btn-monitor").addEventListener("click", () => {
  if (screenPane.hidden) void openScreen();
  else closeScreen();
});
$<HTMLButtonElement>("#btn-new").addEventListener("click", () => openSheet());

$<HTMLButtonElement>("#btn-account").addEventListener("click", (event) => {
  openMenu(
    event.currentTarget as HTMLElement,
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
  const bot = activeBot();
  const msg = bot?.messages.find((m) => m.id === turn.dataset.msg);
  if (!bot || !msg) return;

  switch (btn.dataset.act) {
    case "copy":
      copy(msg.text);
      break;
    case "retry":
      retry(msg.id);
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
    if (app === "settings") void openAppSettings();
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
      save();
      renderThread();
    }
  }

  const copyItem = target.closest<HTMLButtonElement>("[data-copy]");
  if (copyItem && bot) {
    const msg = bot.messages.find((m) => m.id === copyItem.dataset.copy);
    if (msg) copy(msg.text);
  }

  const del = target.closest<HTMLButtonElement>("[data-del]");
  if (del && bot) {
    bot.messages = bot.messages.filter((m) => m.id !== del.dataset.del);
    save();
    renderRoster();
    renderThread();
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
  calAt = dayOfWeek(calAt, -7);
  renderRoutines();
});
$<HTMLButtonElement>("#cal-next").addEventListener("click", () => {
  calAt = dayOfWeek(calAt, 7);
  renderRoutines();
});
$<HTMLButtonElement>("#cal-today").addEventListener("click", () => {
  calAt = weekStart(Date.now());
  renderRoutines();
});

$<HTMLElement>("#routines").addEventListener("click", (e) => {
  const bot = activeBot();
  if (!bot) return;
  const target = e.target as HTMLElement;

  const edit = target.closest<HTMLElement>("[data-edit]");
  if (edit) {
    const routine = bot.routines?.find((r) => r.id === edit.dataset.edit);
    if (routine) openRoutine(routine);
    return;
  }

  const slot = target.closest<HTMLElement>(".cal__slot");
  if (slot) {
    const day = dayOfWeek(calAt, Number(slot.dataset.col));
    openRoutine(null, {
      day: day.getDay(),
      hour: Number(slot.dataset.hour),
      date: isoDate(day),
    });
  }
});

routineForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const bot = activeBot();
  if (!bot) return;

  const draft = draftRoutine();
  if (!draft.name || !draft.instruction) {
    toast("A routine needs a name and an instruction");
    (draft.name ? routineInstruction : routineName).focus();
    return;
  }

  bot.routines = bot.routines ?? [];
  const existing = bot.routines.find((r) => r.id === editingRoutine);
  if (existing) {
    Object.assign(existing, draft, { id: existing.id, lastRunAt: existing.lastRunAt });
    // Re-timed from now, so an edited schedule cannot fire the moment it is
    // saved because its old time had already passed.
    existing.lastRunAt = Date.now();
  } else {
    bot.routines.push({ ...draft, id: uid(), active: true, lastRunAt: Date.now() });
  }

  routineWrap.hidden = true;
  save();
  renderRoutines();
  renderThread();
});

$<HTMLButtonElement>("#routine-run").addEventListener("click", () => {
  const bot = activeBot();
  const routine = bot?.routines?.find((r) => r.id === editingRoutine);
  if (!bot || !routine) return;
  routineWrap.hidden = true;
  showRoutines(false);
  runRoutine(bot, routine);
});

$<HTMLButtonElement>("#routine-delete").addEventListener("click", () => {
  const bot = activeBot();
  if (!bot?.routines) return;
  const gone = bot.routines.find((r) => r.id === editingRoutine);
  bot.routines = bot.routines.filter((r) => r.id !== editingRoutine);
  routineWrap.hidden = true;
  save();
  renderRoutines();
  renderThread();
  if (gone) toast(`Deleted ${gone.name}`);
});

swatches.addEventListener("click", (e) => {
  const swatch = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-color]");
  if (!swatch) return;
  draftColor = swatch.dataset.color!;
  renderSheetPreview();
});

$<HTMLButtonElement>("#sheet-close").addEventListener("click", () => {
  sheetWrap.hidden = true;
});

sheetWrap.addEventListener("mousedown", (e) => {
  if (e.target === sheetWrap) sheetWrap.hidden = true;
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
  } else if (e.key === "Escape") {
    if (!tourWrap().hidden) endTour();
    else if (!modelsWrap.hidden) modelsWrap.hidden = true;
    else if (!routineWrap.hidden) routineWrap.hidden = true;
    else if (!setupWrap.hidden) closeSetup();
    else if (!aboutWrap.hidden) aboutWrap.hidden = true;
    else if (!appWrap.hidden) appWrap.hidden = true;
    else if (teach.arming) cancelArming();
    else if (teach.on) void stopTeaching();
    else if (!menu.hidden) closeMenu();
    else if (!sheetWrap.hidden) sheetWrap.hidden = true;
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

const SETUP_STEPS = ["welcome", "answers", "engine", "done"] as const;
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

async function openSetup(at: SetupStep = "welcome"): Promise<void> {
  setupAt = at;
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
  paintSetup();
  await Promise.all([refreshClaude(), refreshEngine()]);
  paintSetup();
}

function closeSetup(): void {
  setupWrap.hidden = true;
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
          sheetWrap.hidden = true;
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
          sheetWrap.hidden = true;
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
          sheetWrap.hidden = true;
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
          sheetWrap.hidden = true;
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
          sheetWrap.hidden = true;
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
          sheetWrap.hidden = true;
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

function paintSetup(): void {
  const index = SETUP_STEPS.indexOf(setupAt);
  setupRail.querySelectorAll<HTMLElement>(".setup__seg").forEach((seg, at) => {
    seg.dataset.on = String(at <= index);
  });
  setupWrap.querySelectorAll<HTMLElement>(".setup__step").forEach((section) => {
    section.hidden = section.dataset.step !== setupAt;
  });

  const busy = installing || (Boolean(claudeBusy) && !signInWaiting);
  setupBack.hidden = index === 0 || busy;
  setupSkip.hidden = true;
  setupNext.disabled = busy;
  setupNext.textContent = "Continue";

  if (setupAt === "welcome") setupNext.textContent = "Get started";
  if (setupAt === "answers") paintAnswersStep();
  if (setupAt === "engine") paintEngineStep();
  if (setupAt === "done") paintDoneStep();
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
  setupAt = step;
  setupLog = [];
  paintSetup();
}

/** The primary button does whatever the step still needs, and only moves on
 *  once there is nothing left to do. */
async function setupAdvance(): Promise<void> {
  if (setupAt === "welcome") return goTo("answers");
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
    if (stepSatisfied("engine")) return goTo("done");
    try {
      await installEngine();
      toast("Engine ready");
    } catch (err) {
      toast(String(err));
    }
    paintSetup();
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
const remotePairing = $<HTMLDivElement>("#app-remote-pairing");
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
    settings: appSettings(),
    claudeReady,
    // What could answer for a bot, so the phone offers the same choice as the
    // laptop rather than a list of its own that drifts.
    engines: engineChoices,
    bots: state.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      role: bot.role,
      color: bot.color,
      shape: bot.shape,
      engine: bot.engine ?? DEFAULT_ENGINE,
      provider: bot.provider,
      model: bot.model,
      computer: bot.computer,
      network: bot.network,
      plugins: bot.plugins ?? [],
      routines: bot.routines ?? [],
      busy: inflight.has(bot.id),
      messages: bot.messages,
      // the phone renders the same mark on its own side
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
    thread.append(turnEl(msg));
    scrollToEnd(true);
  }
  save();
  renderRoster();
  void respond(bot, clean);
  return { id: msg.id };
}

const REMOTE_ACTIONS: Record<string, (payload: Record<string, unknown>) => unknown> = {
  state: () => remoteSnapshot(),

  send: (p) => remoteSend(String(p.botId ?? ""), String(p.text ?? "")),

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
    save();
    renderRoster();
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
renderThread();
if (state.screenOpen) void openScreen();
autoGrow();
input.focus();

// Routines are checked here rather than in Rust: the state they read lives in
// the webview, and nothing can fire while the app is closed anyway.
window.setInterval(tickRoutines, 30_000);

// A desktop you are watching should not be reaped for idleness.
window.setInterval(() => {
  if (screen.connected && screen.botId) void invoke("sandbox_keepalive", { botId: screen.botId });
}, 60_000);

void listen<BotEvent>("bot-event", (event) => handleBotEvent(event.payload));
void listen<SandboxEvent>("sandbox-event", (event) => handleSandboxEvent(event.payload));
void invoke<string>("user_name")
  .then((name) => {
    if (!name) return;
    $<HTMLSpanElement>("#account-name").textContent = name;
    $<HTMLSpanElement>("#account-initial").textContent = name.slice(0, 1).toUpperCase();
  })
  .catch(() => {});

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
