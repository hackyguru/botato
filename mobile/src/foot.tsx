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
 * The calendar mark is drawn rather than set in a glyph — see `marks.tsx` for
 * why — and it is the same drawing the two conversation headers use, since it
 * opens the same screen scoped differently.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Cal } from "./marks";
import { T } from "./theme";

export default function Foot({
  called,
  onCalendar,
  onSettings,
}: {
  /** What you are called, from the laptop's settings. */
  called: string;
  /** Everyone's standing work, on one calendar. */
  onCalendar: () => void;
  onSettings: () => void;
}) {
  const name = called.trim() || "You";

  return (
    <View style={s.bar}>
      <View style={s.face}>
        <Text style={s.faceText}>{(name[0] ?? "?").toUpperCase()}</Text>
      </View>
      <Text style={s.name} numberOfLines={1}>
        {name}
      </Text>

      <Pressable style={s.act} onPress={onCalendar} hitSlop={6}>
        <Cal />
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
    // Clear of the home indicator, by the same allowance the composer makes
    // for it: a bar with its bottom corners behind that strip looks cut off
    // rather than inset.
    bottom: 30,
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


});
