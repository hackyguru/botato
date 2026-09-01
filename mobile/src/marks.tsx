/**
 * Small drawings that stand in for icons.
 *
 * There is no icon font here and no SVG, and the one glyph this app tried to
 * borrow from the system — a gear — turned out to be an emoji however it was
 * coaxed, which beside a typographic mark looks like something that fell in
 * from another application. So the marks that cannot be typed are drawn, the
 * same way a bot's face is: views, absolute positions, fractions of a box.
 */

import React from "react";
import { StyleSheet, View } from "react-native";

import { T } from "./theme";

/** A calendar: two rings, a pad, and its head filled in.
 *
 *  The rings are the whole of what separates it from a note at this size, so
 *  they are drawn even though they are two points wide. */
export function Cal({ size = 20, color = T.text3 }: { size?: number; color?: string }) {
  const u = size / 20;
  return (
    <View style={{ width: size, height: size }}>
      <View style={[s.ring, { left: 5.5 * u, width: 1.8 * u, height: 4 * u, borderRadius: u, backgroundColor: color }]} />
      <View style={[s.ring, { left: 12.7 * u, width: 1.8 * u, height: 4 * u, borderRadius: u, backgroundColor: color }]} />
      <View
        style={[
          s.pad,
          {
            top: 2.5 * u,
            left: u,
            width: 18 * u,
            height: 17 * u,
            borderWidth: 1.8 * u,
            borderRadius: 4 * u,
            borderColor: color,
          },
        ]}
      >
        <View style={{ height: 3.4 * u, backgroundColor: color }} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  ring: { position: "absolute", top: 0 },
  pad: { position: "absolute", overflow: "hidden" },
});
