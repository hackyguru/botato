/**
 * The palette, the spacing and the type.
 *
 * Written by scripts/tokens.py from design/tokens.json — the same source the
 * laptop's stylesheet is written from, so the two screens cannot drift apart
 * a colour at a time the way they were doing. Edit the source, run the script.
 */

export const T = {
  bg: "#000000",
  panel: "#17171a",
  field: "#1c1c1e",
  bubbleBot: "#1c1c1e",
  bubbleMe: "#3a3a3c",
  raised: "#3a3a3c",
  fill1: "rgba(255,255,255,0.035)",
  fill2: "rgba(255,255,255,0.06)",
  fill3: "rgba(255,255,255,0.11)",
  line: "rgba(255,255,255,0.09)",
  text: "#f2f2f2",
  text2: "#8e8e93",
  text3: "#636366",
  onAccent: "#ffffff",
  link: "#4a9dff",
  blue: "#0a84ff",
  green: "#30d158",
  amber: "#f0b232",
  red: "#ff453a",
  mono: "Menlo",
};

/** Gaps, by name. */
export const S = {
  hair: 2,
  tight: 4,
  snug: 8,
  row: 12,
  gutterPhone: 16,
  gutter: 20,
  loose: 24,
};

/** Corners. */
export const R = {
  pill: 999,
  chip: 8,
  control: 10,
  card: 12,
  surface: 16,
  sheet: 18,
};

/** Sizes. A screen that needs an eighth has a problem the type cannot fix. */
export const F = {
  caption: 11,
  hint: 12.5,
  small: 13.5,
  body: 15,
  titleSm: 16,
  title: 19,
  display: 26,
};

/** What a bot can be. Not a scale — these are people, not levels. */
export const COLORS = ["#0a84ff", "#8e8e93", "#e0393e", "#ff5a00", "#ffb020", "#30d158", "#bf5af2"];
