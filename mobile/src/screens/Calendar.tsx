/**
 * Every bot's standing work, on one calendar.
 *
 * The laptop draws this as a grid — a day, a week or a month of hours, with
 * blocks sitting where they run. None of that survives the trip to a phone: an
 * hour grid seven columns wide is unreadable at 402 points, and a month of
 * squares gives each day about a centimetre to say what happens in it.
 *
 * So it is an agenda, which is what every calendar collapses to on a phone and
 * what this data wants anyway. A routine is a moment rather than a span — it
 * has a time and no length — and a list of moments in order is the honest
 * drawing of that. Days with nothing in them are not printed: an agenda is a
 * list of what happens, not a list of days.
 *
 * It goes as far forward as you keep asking for, the way the laptop's does.
 * The dates all come out of arithmetic on today, so there is nothing to run
 * out of.
 *
 * Routines are made here too. They used to be the laptop's to write and the
 * phone's to read, which is a fine division until you are standing somewhere
 * remembering that the build wants checking every morning — the whole reason
 * this app exists is that the laptop is in the other room. The one thing this
 * form does not carry is where a routine reports; that stays the laptop's,
 * because picking a channel needs the room list and its members and this is a
 * form on a phone.
 */

import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import Face from "../face";
import { T } from "../theme";
import type { Bot, Routine } from "../types";

const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Monday first, the way a week is read. */
const WEEK_PICK = [1, 2, 3, 4, 5, 6, 0];
const KINDS: { key: Routine["every"]; label: string }[] = [
  { key: "once", label: "Once" },
  { key: "day", label: "Daily" },
  { key: "weekday", label: "Weekdays" },
  { key: "week", label: "Weekly" },
  { key: "hour", label: "Hourly" },
  { key: "minutes", label: "Minutes" },
];
const MONTH = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** Monday to Friday, as Date#getDay counts them. */
const WEEKDAY = [1, 2, 3, 4, 5];

/** How much is drawn before you ask for more. */
const RUN = 28;

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (day: Date) =>
  `${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}`;

/** Midnight, `on` days from today. Date arithmetic rather than milliseconds,
 *  so a clock change does not shift the list by an hour. */
function dayFromToday(on: number): Date {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + on);
  return day;
}

/** Does this routine land on that day?
 *
 *  False for the kinds that repeat faster than a line can show — those run
 *  through every day and are listed once, above the whole thing, rather than
 *  thirty times down it. The same rule the laptop's grid follows. */
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

/** Whatever was typed, as HH:MM.
 *
 *  A phone keyboard makes "9", "930" and "9:3" all likely, and a routine saved
 *  at "9" would never run. Digits are taken in order and the rest is dropped;
 *  anything out of range is pulled back into it. */
function tidyTime(typed: string): string {
  const digits = typed.replace(/\D/g, "").slice(0, 4);
  if (!digits) return "09:00";
  const hh = digits.length <= 2 ? Number(digits) : Number(digits.slice(0, digits.length - 2));
  const mm = digits.length <= 2 ? 0 : Number(digits.slice(-2));
  return `${pad2(Math.min(23, hh))}:${pad2(Math.min(59, mm))}`;
}

/** What a day is called at the top of its block. */
function dayTitle(day: Date, on: number): string {
  const date = `${DAY_NAME[day.getDay()]} ${day.getDate()} ${MONTH[day.getMonth()]}`;
  if (on === 0) return `Today · ${date}`;
  if (on === 1) return `Tomorrow · ${date}`;
  // The year only once it is not this one — a calendar that runs forever has
  // to say which August you have scrolled to.
  return day.getFullYear() === new Date().getFullYear()
    ? date
    : `${date} ${day.getFullYear()}`;
}

export default function Calendar({
  bots,
  onBack,
  onOpen,
  onSave,
}: {
  bots: Bot[];
  onBack: () => void;
  /** An existing routine belongs to a bot, and a bot's routines are edited in
   *  its own settings — so that is where tapping one goes. */
  onOpen: (bot: Bot) => void;
  /** A new one. The laptop gives it an id; an empty one means "this is new". */
  onSave: (botId: string, routine: Routine) => Promise<void>;
}) {
  const [days, setDays] = useState(RUN);

  const [adding, setAdding] = useState(false);
  const [who, setWho] = useState("");
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const [every, setEvery] = useState<Routine["every"]>("day");
  const [at, setAt] = useState("09:00");
  const [dow, setDow] = useState(1);
  const [date, setDate] = useState(isoDate(new Date()));
  const [mins, setMins] = useState("15");
  const [busy, setBusy] = useState(false);

  /** Open the form. From a day heading it is that day, and once — which is
   *  what tapping the 28th means. From the header it is a daily routine,
   *  because that is what most of them are. */
  function begin(day?: Date) {
    const on = day ?? new Date();
    setDate(isoDate(on));
    setDow(on.getDay());
    setEvery(day ? "once" : "day");
    setWho((was) => was || bots[0]?.id || "");
    setAdding(true);
  }

  async function add() {
    const bot = bots.find((b) => b.id === who);
    if (!bot || !what.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(bot.id, {
        id: "",
        name: name.trim() || "Routine",
        instruction: what.trim(),
        every,
        at: tidyTime(at),
        ...(every === "week" ? { day: dow } : {}),
        ...(every === "once" ? { date } : {}),
        ...(every === "minutes" ? { minutes: Math.max(1, Number(mins) || 15) } : {}),
        active: true,
      });
      setName("");
      setWhat("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  // One flat list, each item remembering whose it is.
  const all = useMemo(
    () => bots.flatMap((bot) => (bot.routines ?? []).map((routine) => ({ bot, routine }))),
    [bots],
  );

  const often = all.filter(
    ({ routine }) => routine.every === "hour" || routine.every === "minutes",
  );

  const agenda = useMemo(() => {
    const out: { day: Date; on: number; due: { bot: Bot; routine: Routine }[] }[] = [];
    for (let on = 0; on < days; on += 1) {
      const day = dayFromToday(on);
      const due = all
        .filter(({ routine }) => fallsOn(routine, day))
        .sort((one, two) => one.routine.at.localeCompare(two.routine.at));
      if (due.length) out.push({ day, on, due });
    }
    return out;
  }, [all, days]);

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <Pressable onPress={onBack} hitSlop={14}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Text style={s.title}>Calendar</Text>
        <View style={s.spacer} />
        {bots.length ? (
          <Pressable onPress={() => (adding ? setAdding(false) : begin())} hitSlop={12}>
            <Text style={s.plus}>{adding ? "×" : "+"}</Text>
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
        {adding ? (
          <View style={s.form}>
            {/* Whose it is comes first. On the laptop this question only turns
                up on the shared calendar; here every calendar is the shared
                one, so it is the first thing rather than something to discover
                after saving to the wrong bot. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.whoRow}>
              {bots.map((bot) => (
                <Pressable
                  key={bot.id}
                  style={[s.whoOne, bot.id === who ? s.whoHere : null]}
                  onPress={() => setWho(bot.id)}
                >
                  <Face bot={bot} size={30} still />
                  <Text style={s.whoName} numberOfLines={1}>
                    {bot.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              placeholder="Name, e.g. Build check"
              placeholderTextColor={T.text3}
            />
            <TextInput
              style={[s.input, s.tall]}
              value={what}
              onChangeText={setWhat}
              placeholder="What should it do?"
              placeholderTextColor={T.text3}
              multiline
            />

            <View style={s.chips}>
              {KINDS.map((kind) => (
                <Pressable
                  key={kind.key}
                  style={[s.chip, every === kind.key ? s.chipOn : null]}
                  onPress={() => setEvery(kind.key)}
                >
                  <Text style={[s.chipText, every === kind.key ? s.chipTextOn : null]}>
                    {kind.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {every === "week" ? (
              <View style={s.chips}>
                {WEEK_PICK.map((n) => (
                  <Pressable
                    key={n}
                    style={[s.chip, dow === n ? s.chipOn : null]}
                    onPress={() => setDow(n)}
                  >
                    <Text style={[s.chipText, dow === n ? s.chipTextOn : null]}>
                      {DAY_NAME[n]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <View style={s.whenRow}>
              {every === "minutes" ? (
                <>
                  <Text style={s.label}>Every</Text>
                  <TextInput
                    style={[s.input, s.small]}
                    value={mins}
                    onChangeText={setMins}
                    keyboardType="number-pad"
                    placeholderTextColor={T.text3}
                  />
                  <Text style={s.label}>minutes</Text>
                </>
              ) : (
                <>
                  <Text style={s.label}>{every === "hour" ? "At minute" : "At"}</Text>
                  <TextInput
                    style={[s.input, s.small]}
                    value={at}
                    onChangeText={setAt}
                    onBlur={() => setAt(tidyTime(at))}
                    keyboardType="numbers-and-punctuation"
                    placeholder="09:00"
                    placeholderTextColor={T.text3}
                  />
                </>
              )}
              {every === "once" ? (
                <TextInput
                  style={[s.input, s.date]}
                  value={date}
                  onChangeText={setDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={T.text3}
                  autoCorrect={false}
                />
              ) : null}
            </View>

            <Pressable
              style={[s.save, what.trim() && who ? null : s.saveOff]}
              onPress={add}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.saveText}>Add routine</Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {often.length ? (
          <>
            <Text style={s.group}>THROUGH THE DAY</Text>
            <View style={s.block}>
              {often.map(({ bot, routine }) => (
                <Pressable
                  key={routine.id}
                  style={[s.line, routine.active ? null : s.off]}
                  onPress={() => onOpen(bot)}
                >
                  <View style={[s.tint, { backgroundColor: bot.color }]} />
                  <Text style={s.what} numberOfLines={1}>
                    {routine.name}
                  </Text>
                  <Text style={s.when}>
                    {routine.every === "hour"
                      ? `hourly at :${routine.at.slice(-2)}`
                      : `every ${routine.minutes ?? 30} min`}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {agenda.map(({ day, on, due }) => (
          <View key={isoDate(day)}>
            <Pressable style={s.dayHead} onPress={() => begin(day)}>
              <Text style={[s.group, on === 0 ? s.today : null]}>
                {dayTitle(day, on).toUpperCase()}
              </Text>
              <Text style={s.dayAdd}>+</Text>
            </Pressable>
            <View style={s.block}>
              {due.map(({ bot, routine }) => (
                <Pressable
                  key={`${isoDate(day)}-${routine.id}`}
                  style={[s.entry, routine.active ? null : s.off]}
                  onPress={() => onOpen(bot)}
                >
                  <Text style={s.at}>{routine.at}</Text>
                  <Face bot={bot} size={26} still />
                  <View style={s.body}>
                    <Text style={s.what} numberOfLines={1}>
                      {routine.name}
                    </Text>
                    <Text style={s.who} numberOfLines={1}>
                      {bot.name}
                      {routine.active ? "" : " · paused"}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </View>
        ))}

        {all.length === 0 ? (
          <Text style={s.empty}>
            Nothing scheduled yet. Tap + to give a bot something to do.
          </Text>
        ) : (
          // Four more weeks, as many times as you like. Nothing here is bounded
          // — the dates are arithmetic on today — so this is only about how
          // much to draw at once.
          <Pressable style={s.more} onPress={() => setDays((was) => was + RUN)}>
            <Text style={s.moreText}>Show four more weeks</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.line,
  },
  back: { color: T.blue, fontSize: 30, lineHeight: 34 },
  title: { color: T.text, fontSize: 19, fontWeight: "600" },
  spacer: { flex: 1 },
  plus: { color: T.blue, fontSize: 26, lineHeight: 30, fontWeight: "400" },

  /* The form, on the same surface the days sit on. Above them rather than in a
     sheet of its own: what you are adding to is the thing behind it, and a
     phone that covers the calendar to ask about the calendar has hidden the
     answer to half its own questions. */
  form: { marginTop: 14, padding: 12, gap: 9, backgroundColor: T.field, borderRadius: 16 },
  whoRow: { flexGrow: 0 },
  whoOne: {
    alignItems: "center",
    gap: 4,
    width: 66,
    paddingVertical: 6,
    borderRadius: 12,
  },
  whoHere: { backgroundColor: "rgba(255,255,255,0.09)" },
  whoName: { maxWidth: 60, color: T.text2, fontSize: 11 },
  input: {
    minHeight: 40,
    paddingHorizontal: 11,
    paddingVertical: 9,
    letterSpacing: 0,
    color: T.text,
    fontSize: 15,
    backgroundColor: T.bg,
    borderRadius: 10,
  },
  tall: { minHeight: 72, textAlignVertical: "top" },
  small: { width: 88, textAlign: "center" },
  date: { flex: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    backgroundColor: T.bg,
    borderRadius: 999,
  },
  chipOn: { backgroundColor: T.blue },
  chipText: { color: T.text2, fontSize: 12.5, fontWeight: "500" },
  chipTextOn: { color: "#fff" },
  whenRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { color: T.text2, fontSize: 13.5 },
  save: {
    marginTop: 2,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.blue,
    borderRadius: 12,
  },
  saveOff: { opacity: 0.4 },
  saveText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  dayHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  dayAdd: { marginTop: 18, marginBottom: 5, marginRight: 6, color: T.text3, fontSize: 17 },

  list: { paddingHorizontal: 14, paddingBottom: 60 },
  group: {
    marginTop: 18,
    marginBottom: 5,
    marginLeft: 4,
    color: T.text3,
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  today: { color: T.blue },
  block: { backgroundColor: T.field, borderRadius: 14, overflow: "hidden" },

  entry: { flexDirection: "row", alignItems: "center", gap: 11, padding: 11 },
  /* Times line up down the left, which is the whole use of an agenda: the
     column of them is what you read, and the names are what you read next. */
  at: {
    width: 44,
    color: T.text2,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  body: { flex: 1, minWidth: 0 },
  what: { flex: 1, minWidth: 0, color: T.text, fontSize: 15, fontWeight: "600" },
  who: { marginTop: 1, color: T.text3, fontSize: 12.5 },
  off: { opacity: 0.45 },

  line: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 11, paddingVertical: 9 },
  tint: { width: 8, height: 8, borderRadius: 4 },
  when: { color: T.text3, fontSize: 12.5 },

  empty: { marginTop: 60, color: T.text3, fontSize: 14, textAlign: "center", lineHeight: 21 },
  more: { marginTop: 18, alignItems: "center", paddingVertical: 12 },
  moreText: { color: T.text2, fontSize: 13.5, fontWeight: "500" },
});
