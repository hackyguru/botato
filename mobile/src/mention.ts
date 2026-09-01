/**
 * Finishing an "@" as you type it.
 *
 * A mention is how a bot is summoned, so on the laptop it is the one piece of
 * typing the app helps with: an "@" opens a list of who is in the room and one
 * key finishes the name. The phone had none of that — the name had to be typed
 * exactly, on a keyboard, against autocorrect, and a name spelt slightly wrong
 * summons nobody and says nothing about why.
 *
 * The rules live here rather than in the view because they are the fiddly part
 * and the view is not the place to prove them right.
 */

/** Something that can follow an "@": a member of the room, or the room. */
export interface Offer {
  name: string;
  /** A line about what picking it does. Empty is fine — most bots have a role
   *  and some do not. */
  hint: string;
  /** Absent for "everyone", which is not a bot. */
  botId?: string;
  /** The bot's own colour, so the list looks like the message it will make. */
  tint?: string;
}

/** The "@…" being typed at the caret, if there is one.
 *
 *  Spaces are allowed in the query because names have spaces in them. That
 *  would otherwise run away over a whole sentence, so it is bounded twice: a
 *  couple of dozen characters here, and the fact that nothing matching closes
 *  the list. Type "@" mid-sentence and carry on typing prose and it goes away
 *  by itself. */
export function query(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // It has to start a word — an email address is not a mention.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const typed = before.slice(at + 1);
  if (typed.length > 24 || typed.includes("\n")) return null;
  return { at, query: typed };
}

/** Who is offered in a room, in the order the laptop offers them.
 *
 *  "everyone" comes last: it is the loudest thing in the list, and putting it
 *  first makes it the thing hit by reflex. Only where there is a room to call
 *  — in a one-bot channel it is a longer way of saying that bot's name. */
export function offers(
  members: { id: string; name: string; role?: string; color?: string }[],
): Offer[] {
  const out: Offer[] = members.map((bot) => ({
    name: bot.name,
    hint: bot.role ? bot.role.split("\n")[0].slice(0, 60) : "",
    botId: bot.id,
    tint: bot.color,
  }));
  if (members.length > 1) {
    out.push({
      name: "everyone",
      hint: `All ${members.length} — ${members.map((b) => b.name).join(", ")}`,
    });
  }
  return out;
}

/** What is worth showing for what has been typed.
 *
 *  What you have typed first, then anything else containing it: someone who
 *  types "writ" means Research and Writing, and a list that refuses to find it
 *  is worse than no list. */
export function matches(offered: Offer[], typed: string): Offer[] {
  const q = typed.toLowerCase();
  const starts = offered.filter((m) => m.name.toLowerCase().startsWith(q));
  const rest = offered.filter(
    (m) => !starts.includes(m) && q.length > 0 && m.name.toLowerCase().includes(q),
  );
  return [...starts, ...rest];
}

/** The "/…" being typed, if the message starts with one.
 *
 *  Only at the very beginning. A slash anywhere else is a path, a date or a
 *  fraction, and offering a menu in the middle of "src/main.ts" is the kind of
 *  help that has to be dismissed. */
export function slash(text: string, caret: number): string | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  if (!before.startsWith("/")) return null;
  const typed = before.slice(1);
  // A space ends it: past that you are writing the message, not the name.
  if (/\s/.test(typed) || typed.length > 24) return null;
  return typed;
}

/** A shortcut on offer, and whose it is. */
export interface Shortcut {
  name: string;
  what: string;
  botId: string;
  botName: string;
}

/** Everything on offer where you are typing. `inRoom` decides how it will be
 *  written: in a room a command is preceded by the bot it belongs to, because
 *  "/log" said into a room of five is addressed to nobody. */
export function shortcuts(
  members: { id: string; name: string; commands?: { name: string; what: string }[] }[],
): Shortcut[] {
  return members.flatMap((bot) =>
    (bot.commands ?? []).map((one) => ({
      name: one.name,
      what: one.what,
      botId: bot.id,
      botName: bot.name,
    })),
  );
}

/** Which shortcuts match what has been typed, prefixes first. */
export function matchingShortcuts(all: Shortcut[], typed: string): Shortcut[] {
  const q = typed.toLowerCase();
  const starts = all.filter((one) => one.name.startsWith(q));
  const rest = all.filter((one) => !starts.includes(one) && q.length > 0 && one.name.includes(q));
  return [...starts, ...rest];
}

/** Put a chosen name in, and say where the caret goes after it.
 *
 *  The trailing space is the point: the next thing typed is the message, not
 *  more of the name. */
export function accept(
  text: string,
  caret: number,
  at: number,
  name: string,
): { text: string; caret: number } {
  const head = text.slice(0, at);
  const tail = text.slice(Math.max(0, Math.min(caret, text.length)));
  const written = `@${name} `;
  return { text: head + written + tail, caret: head.length + written.length };
}
