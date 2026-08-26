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

/** How full a bot's hands are, drawn as the laptop draws it.
 *
 *  A ring without an SVG, which this app does not have: two half-rings, each
 *  clipped to its side of the circle and swung round. A view with two adjacent
 *  borders coloured is exactly half a ring — the borders meet on the diagonals
 *  — so the right half is top-and-right turned 45°, and sweeping it is a
 *  rotation. Past halfway the left half starts its own sweep.
 *
 *  Coarse at fifteen points, which is the size it is drawn at, and the reading
 *  it carries is coarse too: nothing, a little, busy, full.
 */
export function Gauge({
  press,
  size = 15,
  thick = 3,
  color = T.blue,
}: {
  press: number;
  size?: number;
  thick?: number;
  color?: string;
}) {
  const deg = Math.max(0, Math.min(1, press)) * 360;
  const full = deg >= 359;

  const ring = {
    position: "absolute" as const,
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: thick,
  };

  const half = (side: "right" | "left") => {
    const swept = side === "right" ? Math.min(180, deg) : Math.max(0, deg - 180);
    if (swept <= 0) return null;
    return (
      <View
        style={{
          position: "absolute",
          top: 0,
          left: side === "right" ? size / 2 : 0,
          width: size / 2,
          height: size,
          overflow: "hidden",
        }}
      >
        <View
          style={[
            ring,
            {
              left: side === "right" ? -size / 2 : 0,
              borderColor: "transparent",
              ...(side === "right"
                ? { borderTopColor: color, borderRightColor: color }
                : { borderBottomColor: color, borderLeftColor: color }),
              transform: [{ rotate: `${swept - 135}deg` }],
            },
          ]}
        />
      </View>
    );
  };

  return (
    <View style={{ width: size, height: size }}>
      {/* The groove, drawn whether or not anything is in it: a gauge that
          appears only when it has something to say leaves the eye nothing to
          read the rest against. */}
      <View style={[ring, { borderColor: "rgba(255,255,255,0.13)" }]} />
      {full ? <View style={[ring, { borderColor: color }]} /> : null}
      {!full ? half("right") : null}
      {!full ? half("left") : null}
    </View>
  );
}
