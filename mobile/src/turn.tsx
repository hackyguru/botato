/**
 * One line of a conversation, drawn the way the laptop draws it.
 *
 * Flat: everybody down the left, no bubbles, and a face, a name and a time at
 * the head of a run of messages from one person — nothing at all on the lines
 * that continue it. That is the whole of what makes a flat list readable
 * instead of a wall, and it matters more on a phone than on a laptop, where
 * every repeated avatar costs a line of a screen that is mostly not there.
 *
 * Here rather than in each screen so a room and a bot's own chat cannot drift
 * apart: they are the same conversation seen twice.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { T } from "./theme";
import type { Message } from "./types";

/** Messages closer together than this, from the same person, are one run. */
const SAME_BREATH = 5 * 60 * 1000;

/** Whether this message opens a run rather than continuing one. */
export function startsRun(msg: Message, prev?: Message): boolean {
  if (!prev) return true;
  // A marker between two messages breaks the run: something happened in
  // between, even if nobody said it.
  if (prev.kind === "routine" || prev.kind === "teach") return true;
  if (prev.from !== msg.from) return true;
  if (msg.from === "bot" && prev.by !== msg.by) return true;
  // The phone mark lives on the head of a run, so a change of device starts
  // one rather than letting one mark speak for messages it does not describe.
  if (!!prev.fromPhone !== !!msg.fromPhone) return true;
  return msg.at - prev.at > SAME_BREATH;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** You, drawn as the laptop draws you when it has no picture. */
export function Initial({ name }: { name: string }) {
  return (
    <View style={s.initial}>
      <Text style={s.initialText}>{(name.trim()[0] ?? "?").toUpperCase()}</Text>
    </View>
  );
}

export function Turn({
  head,
  face,
  name,
  at,
  fromPhone,
  ping,
  onHold,
  children,
}: {
  head: boolean;
  face: React.ReactNode;
  name: string;
  at: number;
  fromPhone?: boolean;
  /** A bot said your name here. */
  ping?: boolean;
  /** Held down. The laptop shows a row of buttons when the pointer crosses a
   *  message, which a phone has no way to do — holding is where those buttons
   *  went. */
  onHold?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      style={[s.turn, head && s.turnHead, ping ? s.turnPing : null]}
      onLongPress={onHold}
      // Long enough not to fire while scrolling past, short enough to feel
      // like a press rather than a wait.
      delayLongPress={320}
      disabled={!onHold}
      accessibilityRole={onHold ? "button" : undefined}
      accessibilityHint={onHold ? "Hold for what can be done with this message" : undefined}
    >
      {/* Empty on a continuation, and exactly as wide, so the text under a run
          stays in one column. */}
      <View style={s.gutter}>{head ? face : null}</View>
      <View style={s.main}>
        {head ? (
          <View style={s.who}>
            <Text style={s.name} numberOfLines={1}>
              {name}
            </Text>
            <Text style={s.when}>{clock(at)}</Text>
            {fromPhone ? <View style={s.phone} /> : null}
          </View>
        ) : null}
        {children}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  turn: { flexDirection: "row", gap: 9, alignItems: "flex-start", width: "100%" },
  /* The only place with air above it: a gap where the speaker changes, and
     nowhere else. */
  turnHead: { marginTop: 14 },
  /* The one message in a busy room you cannot afford to scroll past, marked
     the way the laptop marks it: a bar down the left and the faintest wash.
     The negative margin pays for the bar and the padding, so a row that
     becomes a ping does not shift sideways from the ones above it. */
  turnPing: {
    marginLeft: -8,
    paddingLeft: 6,
    borderLeftWidth: 2,
    borderLeftColor: "#f0b232",
    backgroundColor: "rgba(240,178,50,0.055)",
  },
  gutter: { width: 28, alignItems: "center", paddingTop: 1 },
  main: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 7, marginBottom: 1 },
  name: { color: T.text, fontSize: 14, fontWeight: "600", flexShrink: 1 },
  when: { color: T.text3, fontSize: 10.5 },
  /* The same mark the laptop puts on a message sent from a phone, drawn rather
     than set in a glyph: the phone symbol is not in every system font. */
  phone: {
    width: 7,
    height: 11,
    borderWidth: 1,
    borderColor: T.text3,
    borderRadius: 2,
  },
  initial: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: T.field,
    alignItems: "center",
    justifyContent: "center",
  },
  initialText: { color: T.text, fontSize: 12, fontWeight: "600" },
});
