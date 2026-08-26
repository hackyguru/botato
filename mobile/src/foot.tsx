/**
 * The bar across the bottom of the drawer.
 *
 * Who you are, and the two things that are about you rather than about any bot:
 * what has happened while you were away, and this phone's own settings. Discord
 * keeps the same bar in the same corner, and it is the right corner for it — the
 * list above is a list of other people, and you are not one of the entries.
 *
 * Floating rather than docked: a shade above the pane, inset on three sides,
 * with the list scrolling underneath it. A bar welded to the bottom edge would
 * be a fourth surface stacked on three, and the phone's own home indicator is
 * already sitting in that strip.
 *
 * The bell is drawn rather than set in a glyph, for the reason the gear next
 * door was replaced: on iOS a bell is an emoji however it is coaxed, and an
 * emoji beside a typographic mark looks like something that fell in from
 * another application.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { T } from "./theme";

function Bell({ lit }: { lit: boolean }) {
  const ink = lit ? T.text : T.text3;
  return (
    <View style={s.bell}>
      <View style={[s.bellBody, { borderColor: ink }]} />
      <View style={[s.bellRim, { backgroundColor: ink }]} />
      <View style={[s.bellClapper, { backgroundColor: ink }]} />
    </View>
  );
}

export default function Foot({
  called,
  unread,
  mentions,
  onNews,
  onSettings,
}: {
  /** What you are called, from the laptop's settings. */
  called: string;
  /** Conversations with something new in them. */
  unread: number;
  /** Times a bot said your name in them. */
  mentions: number;
  /** Go to whatever is waiting. Absent when nothing is. */
  onNews?: () => void;
  onSettings: () => void;
}) {
  const name = called.trim() || "You";
  const waiting = unread > 0;

  return (
    <View style={s.bar}>
      <View style={s.face}>
        <Text style={s.faceText}>{(name[0] ?? "?").toUpperCase()}</Text>
      </View>
      <Text style={s.name} numberOfLines={1}>
        {name}
      </Text>

      <Pressable
        style={s.act}
        onPress={waiting ? onNews : undefined}
        disabled={!waiting}
        hitSlop={6}
      >
        <Bell lit={waiting} />
        {/* A count when a bot addressed you by name, a dot when a room merely
            carried on — the same two marks the rows above use, because they
            mean the same two things here. */}
        {mentions ? (
          <View style={s.badge}>
            <Text style={s.badgeText}>{mentions > 9 ? "9+" : mentions}</Text>
          </View>
        ) : waiting ? (
          <View style={s.dot} />
        ) : null}
      </Pressable>

      <Pressable style={s.act} onPress={onSettings} hitSlop={6}>
        {/* The glyph this app already uses for settings, in both the places it
            has them. */}
        <Text style={s.gear}>⋯</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    position: "absolute",
    right: 10,
    bottom: 12,
    left: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 54,
    paddingLeft: 8,
    paddingRight: 4,
    backgroundColor: T.field,
    borderRadius: 18,
    // Enough to lift it off the pane without drawing a border, which at this
    // size would read as a box rather than as something in front.
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  face: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.bubbleMe,
  },
  faceText: { color: T.text, fontSize: 15, fontWeight: "600" },
  name: { flex: 1, minWidth: 0, color: T.text, fontSize: 15, fontWeight: "600" },
  act: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  gear: { color: T.text2, fontSize: 22, lineHeight: 24 },

  /* A bell in a 20-point box: a dome with a rim under it and the clapper below
     that. Outlined rather than filled, so it sits at the same weight as the
     mark beside it. */
  bell: { width: 20, height: 20 },
  bellBody: {
    position: "absolute",
    top: 2,
    left: 3,
    width: 14,
    height: 12,
    borderWidth: 1.8,
    borderTopLeftRadius: 7,
    borderTopRightRadius: 7,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  bellRim: { position: "absolute", top: 13.5, left: 0.5, width: 19, height: 1.8, borderRadius: 1 },
  bellClapper: {
    position: "absolute",
    top: 16,
    left: 7.5,
    width: 5,
    height: 3.4,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
  },

  badge: {
    position: "absolute",
    top: 4,
    right: 3,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: T.red,
    // A ring in the bar's own colour, so a badge over the bell's outline still
    // reads as a badge and not as part of the drawing.
    borderWidth: 2,
    borderColor: T.field,
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  dot: {
    position: "absolute",
    top: 6,
    right: 7,
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: T.text2,
    borderWidth: 2,
    borderColor: T.field,
  },
});
