/**
 * botcage's mark, on a phone.
 *
 * The same bot's head the laptop draws in the corner of its sidebar and the
 * same one the app icon is cut from: an antenna, two ears, and a face. Drawn
 * from the SVG's own numbers — a 24-unit box, scaled — so the two cannot drift
 * apart. If the mark in index.html changes, the fractions here change with it.
 *
 * Views rather than a picture, for the reason `face.tsx` uses them: there is no
 * SVG in this app and an asset would be a second copy of the mark that nobody
 * remembers to regenerate. This one takes a colour and any size.
 *
 * The laptop punches the eyes and the mouth out of a single fill so whatever is
 * behind the mark shows through them. There is no masking here, so the face is
 * painted in the colour of what it sits on — which looks the same, as long as
 * that is what it actually sits on. Hence `behind`.
 */

import React from "react";
import { View } from "react-native";

import { T } from "./theme";

export default function Brand({
  size = 26,
  color = T.blue,
  behind = T.bg,
}: {
  size?: number;
  /** One colour: the mark is a single fill. */
  color?: string;
  /** What is behind it, painted into the face where the laptop has holes. */
  behind?: string;
}) {
  // Every number below is in the SVG's 24-unit box.
  const u = size / 24;

  return (
    <View style={{ width: size, height: size }}>
      {/* The antenna, which is what makes the silhouette recognisable at the
          size a rail draws it. */}
      <View
        style={{
          position: "absolute",
          left: 11.6 * u,
          top: 3.3 * u,
          width: 0.8 * u,
          height: 3.8 * u,
          borderRadius: 0.4 * u,
          backgroundColor: color,
        }}
      />
      <View
        style={{
          position: "absolute",
          left: 10.85 * u,
          top: 2.15 * u,
          width: 2.3 * u,
          height: 2.3 * u,
          borderRadius: 1.15 * u,
          backgroundColor: color,
        }}
      />

      {/* Ears: level with the eyes, and small. Ones that widen the outline turn
          a head into a television. */}
      {[3.7, 18.8].map((x) => (
        <View
          key={x}
          style={{
            position: "absolute",
            left: x * u,
            top: 11 * u,
            width: 1.5 * u,
            height: 3.9 * u,
            borderRadius: 0.75 * u,
            backgroundColor: color,
          }}
        />
      ))}

      <View
        style={{
          position: "absolute",
          left: 4.5 * u,
          top: 5.9 * u,
          width: 15 * u,
          height: 15 * u,
          borderRadius: 4.5 * u,
          backgroundColor: color,
        }}
      />

      {[9.4, 14.6].map((x) => (
        <View
          key={x}
          style={{
            position: "absolute",
            left: (x - 1.4) * u,
            top: 11.1 * u,
            width: 2.8 * u,
            height: 2.8 * u,
            borderRadius: 1.4 * u,
            backgroundColor: behind,
          }}
        />
      ))}

      {/* The smile is a stroke, not a filled crescent — a filled one reads as a
          mouth open in surprise at this size. A bottom border with two round
          corners is the arc, the same way a bot's mouth is drawn. */}
      <View
        style={{
          position: "absolute",
          left: 9.3 * u,
          top: 15.3 * u,
          width: 5.4 * u,
          height: 1.9 * u,
          borderBottomWidth: 1.1 * u,
          borderColor: behind,
          borderBottomLeftRadius: 1.9 * u,
          borderBottomRightRadius: 1.9 * u,
        }}
      />
    </View>
  );
}
