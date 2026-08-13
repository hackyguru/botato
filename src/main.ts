/**
 * botcage — desktop bot roster + threads, modelled on the Grok bot app UI.
 *
 * Each bot is a Claude Code session: turns run through the local `claude` CLI
 * (see src-tauri/src/lib.rs), authenticated by the user's own login.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import RFB from "@novnc/novnc";

type Shape = "circle" | "squircle" | "drop";

interface Message {
  id: string;
  from: "me" | "bot";
  /** What the model receives. For a teach turn this is the instructions, which
      the thread renders as a badge rather than showing verbatim. */
  text: string;
  at: number;
  reaction?: string;
  error?: string;
  kind?: "teach";
  meta?: { steps: number; frames: number; slug: string; name?: string };
}

interface Bot {
  id: string;
  name: string;
  role: string;
  color: string;
  shape: Shape;
  messages: Message[];
  /** Claude Code session UUID — stable for the bot's whole lifetime. */
  sessionId: string;
  /** True once a session exists on disk, so later turns can `--resume`. */
  started: boolean;
}

type SandboxState = "stopped" | "building" | "starting" | "running" | "error" | "no-docker";

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

/** Claude model alias every bot runs on. "sonnet" is cheaper on quota. */
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
}

const state: Persisted = { bots: [], activeId: null };

const SCREEN_PANE = { min: 300, max: 900, initial: 460 };
const SCREEN_ROW = { min: 200, max: 700, initial: 320 };

/** The chat needs at least this much width; below it, the desktop stacks under. */
const MIN_CHAT_WIDTH = 480;
/** Below this, the sidebar collapses to a rail whether you asked for it or not. */
const RAIL_AT = 720;

/* ----------------------------------------------------------------- elements */

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

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
const sheetRole = $<HTMLInputElement>("#sheet-role");
const sheetPreview = $<HTMLDivElement>("#sheet-preview");
const swatches = $<HTMLDivElement>("#swatches");
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
const controlBtn = $<HTMLButtonElement>("#btn-control");
const controlLabel = $<HTMLSpanElement>("#btn-control-label");

/** Bots with a turn in flight, keyed by bot id. */
const inflight = new Map<string, { message: Message; sawText: boolean; note: string }>();

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

/** Inline markdown: links, `code`, **bold**, *italic*. */
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
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

function faceHtml(bot: Bot, size: "sm" | "md" | "lg" = "md"): string {
  const cls = size === "md" ? "" : ` face--${size}`;
  return (
    `<span class="face face--${bot.shape}${cls}" style="background:${bot.color}">` +
    `<i></i><i></i></span>`
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
    messages: [],
  });

  state.bots = [
    make("Engineer", "Ships and reviews code", "#0a84ff", "circle"),
    make("Doctor", "Health and training", "#8e8e93", "drop"),
    make("Chief of Staff", "Keeps the week on rails", "#e0393e", "squircle"),
    make("Ops", "Infra and on-call", "#ff5a00", "drop"),
    make("Research & Writing", "Drafts and digs", "#ffb020", "squircle"),
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
      sessionId: bot.sessionId || newSessionId(),
      started: Boolean(bot.started),
    }));
    state.activeId = data.activeId ?? state.bots[0].id;
    state.screenOpen = Boolean(data.screenOpen);
    state.screenWidth = data.screenWidth;
    state.screenHeight = data.screenHeight;
    state.railed = Boolean(data.railed);
  } catch {
    seed();
  }
}

/* --------------------------------------------------------------- bot roster */

const activeBot = () => state.bots.find((b) => b.id === state.activeId) ?? null;

const lastOf = (bot: Bot): Message | undefined => bot.messages[bot.messages.length - 1];

function preview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
      const busy = inflight.has(bot.id);
      const sub = busy
        ? "Typing…"
        : last?.kind === "teach"
          ? "Learned from demonstration"
          : last
            ? preview(last.text)
            : bot.role;
      return (
        `<button class="bot-row${bot.id === state.activeId ? " is-active" : ""}" data-bot="${bot.id}">` +
        faceHtml(bot) +
        `<span class="bot-row__body">` +
        `<span class="bot-row__top"><span class="bot-row__name">${escapeHtml(bot.name)}</span>` +
        `<span class="bot-row__time">${last ? clock(last.at) : ""}</span></span>` +
        `<span class="bot-row__last">${escapeHtml(sub)}</span>` +
        `</span></button>`
      );
    })
    .join("");
}

/* ------------------------------------------------------------------- thread */

const CLAMP_AT = 420;

function bubbleHtml(msg: Message): string {
  const body = `<div class="md">${renderMd(msg.text)}</div>`;
  const clamp = msg.text.length > CLAMP_AT;
  const react = msg.reaction ? `<div class="reacts"><span class="react">${msg.reaction}</span></div>` : "";
  return (
    `<div class="bubble${clamp ? " is-clamped" : ""}">` +
    `<div class="bubble__body">${body}</div>` +
    (clamp ? `<button type="button" class="more-btn">Show more ${icon("chev")}</button>` : "") +
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

  if (!bot.messages.length) {
    thread.innerHTML =
      `<div class="empty">${faceHtml(bot, "lg")}<h2>${escapeHtml(bot.name)}</h2>` +
      `<p>${escapeHtml(bot.role || "Say hello to get started.")}</p></div>`;
  } else {
    thread.innerHTML = "";
    for (const msg of bot.messages) thread.append(turnEl(msg));
  }

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
    bot.role ? `Your remit: ${bot.role}.` : "",
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
        sessionId: bot.sessionId,
        resume: bot.started,
        prompt,
        systemPrompt: systemPromptFor(bot),
        model: MODEL,
        botName: bot.name,
        botRole: bot.role,
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
  if (event.kind === "rate-limit") {
    const info = event.detail;
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
    pending.note = `Using ${event.text ?? "a tool"}…`;
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

function openMenu(anchor: HTMLElement, html: string, extraClass = ""): void {
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

function openSheet(): void {
  draftColor = COLORS[state.bots.length % COLORS.length];
  sheetName.value = "";
  sheetRole.value = "";
  renderSheetPreview();
  sheetWrap.hidden = false;
  sheetName.focus();
}

function createBot(): void {
  const name = sheetName.value.trim();
  if (!name) {
    sheetName.focus();
    return;
  }
  const bot: Bot = {
    id: uid(),
    name,
    role: sheetRole.value.trim(),
    color: draftColor,
    shape: SHAPES[state.bots.length % SHAPES.length],
    sessionId: newSessionId(),
    started: false,
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

function openBot(id: string): void {
  state.activeId = id;
  save();
  renderRoster();
  renderThread();
  // The pane always shows the bot you're talking to.
  if (!screenPane.hidden && screen.botId !== id) void openScreen();
  input.focus();
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
  "no-docker": "No Docker",
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
    "Docker isn't available. Install Docker Desktop or OrbStack (macOS, Windows) or docker.io (Linux), start it, then try again.",
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

  const teachBtn = $<HTMLButtonElement>("#btn-teach");
  teachBtn.hidden = !live;
  teachBtn.classList.toggle("is-recording", teach.on);
  teachName.hidden = !live || !teach.arming;
  $<HTMLSpanElement>("#btn-teach-label").textContent = teach.on
    ? `Stop (${teachEvents.length} step${teachEvents.length === 1 ? "" : "s"})`
    : teach.arming
      ? "Start recording"
      : "Teach a task";
  $<HTMLButtonElement>("#btn-screen-power").hidden = screen.state !== "running";

  screenMessage.textContent = STATE_MESSAGE[screen.state];
  startBtn.hidden = !(screen.state === "stopped" || screen.state === "error");
  startBtn.textContent = screen.state === "error" ? "Try again" : "Start desktop";

  screenLog.hidden = screen.log.length === 0;
  screenLog.textContent = screen.log.slice(-40).join("\n");
  screenLog.scrollTop = screenLog.scrollHeight;

  controlLabel.textContent = screen.control ? "You have control" : "View only";
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

  const docker = await invoke<{ path: string | null; version: string | null; error: string | null }>(
    "docker_info",
  );
  if (!docker.version) {
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
  if (!input.value.trim()) {
    toast("Voice input coming soon");
    return;
  }
  send(input.value);
});

input.addEventListener("input", autoGrow);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});

$<HTMLButtonElement>("#btn-attach").addEventListener("click", () => toast("Attachments coming soon"));
$<HTMLButtonElement>("#btn-monitor").addEventListener("click", () => {
  if (screenPane.hidden) void openScreen();
  else closeScreen();
});
$<HTMLButtonElement>("#btn-plugins").addEventListener("click", () => toast("No plugins installed"));
$<HTMLButtonElement>("#btn-new").addEventListener("click", openSheet);

$<HTMLButtonElement>("#btn-account").addEventListener("click", async () => {
  const info = await invoke<{ path: string | null; version: string | null }>("claude_info");
  toast(info.path ? `Claude Code ${info.version ?? ""} · ${MODEL}` : "Claude Code CLI not found");
});

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
    `<button type="button" class="menu-item" data-clear="${id}">${icon("refresh")}Clear thread</button>` +
      `<button type="button" class="menu-item" data-remove="${id}">${icon("trash")}Delete bot</button>`,
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
      // A cleared thread starts a fresh Claude Code session.
      target2.sessionId = newSessionId();
      target2.started = false;
      save();
      renderRoster();
      renderThread();
    }
  }

  const remove = target.closest<HTMLButtonElement>("[data-remove]");
  if (remove) deleteBot(remove.dataset.remove!);

  closeMenu();
});

sheet.addEventListener("submit", (e) => {
  e.preventDefault();
  createBot();
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
    if (teach.arming) cancelArming();
    else if (teach.on) void stopTeaching();
    else if (!menu.hidden) closeMenu();
    else if (!sheetWrap.hidden) sheetWrap.hidden = true;
    else if (!screenPane.hidden) closeScreen();
  }
});

window.addEventListener("resize", closeMenu);

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

void listen<BotEvent>("bot-event", (event) => handleBotEvent(event.payload));
void listen<SandboxEvent>("sandbox-event", (event) => handleSandboxEvent(event.payload));

void invoke<{ path: string | null; version: string | null }>("claude_info").then((info) => {
  claudeReady = Boolean(info.path);
  if (!claudeReady) {
    toast("Claude Code CLI not found — bots can't reply until it's installed");
  }
});
