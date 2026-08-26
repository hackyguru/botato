/**
 * A bot's face, on a phone.
 *
 * The same creature the laptop draws, from the same four traits and the same
 * hash of the same id — so a bot with heavy brows and an antenna is that bot on
 * both screens rather than two different pictures of one name. Only the
 * overrides travel over the wire; everything else is derived here, because a
 * deterministic function of an id costs nothing to run twice and a payload of
 * face descriptions would go stale the moment somebody changed one.
 *
 * Views and absolute positions rather than CSS: the desktop's parts are
 * fractions of a face-sized box, and those translate directly. What does not
 * translate is the mood layer — keyframes are not a thing here — so this draws
 * the resting face and blinks, and leaves the rest to the animation work.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, View, type ViewStyle } from "react-native";
import type { Bot } from "./types";

const HEADS = ["circle", "squircle", "drop", "bean", "egg", "shield"];
const EYES = ["dot", "wide", "sleepy", "ring", "tall", "wink"];
const BROWS = ["none", "flat", "angled", "raised", "thick", "quirk"];
const SMILES = ["soft", "wide", "curl", "flat", "open", "tiny"];
const MARKS = [
  "none",
  "antenna",
  "tuft",
  "cheeks",
  "band",
  "bolt",
  "cowboy",
  "cap",
  "bow",
  "halo",
];

const INK = "rgba(0,0,0,0.72)";
const HAT = "#b07d4a";
const HAT_DARK = "#7d5731";

/** The laptop's hash, to the digit. Two implementations of one function is a
 *  bot that looks different on the phone, which is worse than no face. */
function seedOf(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function faceOf(bot: Bot) {
  const seed = seedOf(bot.id);
  return {
    head: bot.face?.head ?? bot.shape ?? HEADS[seed % HEADS.length],
    eyes: bot.face?.eyes ?? EYES[(seed >> 3) % EYES.length],
    brow: bot.face?.brow ?? BROWS[(seed >> 6) % BROWS.length],
    smile: bot.face?.smile ?? SMILES[(seed >> 9) % SMILES.length],
    mark: bot.face?.mark ?? MARKS[(seed >> 12) % MARKS.length],
  };
}

/** The head, whose corners are the whole of its character. */
function headShape(head: string, u: number): ViewStyle {
  const half = u / 2;
  switch (head) {
    case "squircle":
      return { borderRadius: u * 0.3 };
    case "drop":
      return {
        borderTopLeftRadius: half,
        borderTopRightRadius: half,
        borderBottomRightRadius: half,
        borderBottomLeftRadius: u * 0.22,
      };
    case "bean":
      return {
        borderTopLeftRadius: u * 0.46,
        borderTopRightRadius: u * 0.54,
        borderBottomRightRadius: u * 0.4,
        borderBottomLeftRadius: u * 0.6,
      };
    case "egg":
      return {
        borderTopLeftRadius: half,
        borderTopRightRadius: half,
        borderBottomRightRadius: u * 0.44,
        borderBottomLeftRadius: u * 0.44,
      };
    case "shield":
      return {
        borderTopLeftRadius: u * 0.34,
        borderTopRightRadius: u * 0.34,
        borderBottomRightRadius: half,
        borderBottomLeftRadius: half,
      };
    default:
      return { borderRadius: half };
  }
}

function eyeShape(eyes: string, u: number, second: boolean): ViewStyle {
  const base: ViewStyle = { backgroundColor: INK };
  switch (eyes) {
    case "wide":
      return { ...base, width: u * 0.19, height: u * 0.19, borderRadius: u * 0.1 };
    case "sleepy":
      return { ...base, width: u * 0.17, height: u * 0.07, borderRadius: u * 0.04 };
    case "ring":
      return {
        width: u * 0.19,
        height: u * 0.19,
        borderRadius: u * 0.1,
        borderWidth: u * 0.05,
        borderColor: INK,
      };
    case "tall":
      return { ...base, width: u * 0.1, height: u * 0.26, borderRadius: u * 0.05 };
    case "wink":
      return second
        ? { ...base, width: u * 0.15, height: u * 0.055, borderRadius: u * 0.03 }
        : { ...base, width: u * 0.15, height: u * 0.19, borderRadius: u * 0.1 };
    default:
      return { ...base, width: u * 0.12, height: u * 0.18, borderRadius: u * 0.06 };
  }
}

/** The mouth is an expression, so at rest it only varies in how it smiles —
 *  never in whether it does. */
function smileShape(smile: string, u: number): ViewStyle {
  const curve: ViewStyle = {
    borderBottomWidth: u * 0.05,
    borderColor: INK,
    borderBottomLeftRadius: u * 0.18,
    borderBottomRightRadius: u * 0.18,
  };
  switch (smile) {
    case "wide":
      return { ...curve, width: u * 0.34, height: u * 0.1 };
    case "curl":
      return {
        ...curve,
        width: u * 0.22,
        height: u * 0.1,
        borderBottomRightRadius: u * 0.05,
        transform: [{ rotate: "-7deg" }],
      };
    case "flat":
      return { width: u * 0.2, height: u * 0.045, borderRadius: u * 0.03, backgroundColor: INK };
    case "open":
      return {
        width: u * 0.2,
        height: u * 0.13,
        backgroundColor: INK,
        borderTopLeftRadius: u * 0.06,
        borderTopRightRadius: u * 0.06,
        borderBottomLeftRadius: u * 0.14,
        borderBottomRightRadius: u * 0.14,
      };
    case "tiny":
      return { ...curve, width: u * 0.14, height: u * 0.08 };
    default:
      return { ...curve, width: u * 0.24, height: u * 0.1 };
  }
}

/** Anything that is not part of a face: worn, grown, or drawn by the bot. */
function Mark({ bot, u }: { bot: Bot; u: number }) {
  const mark = faceOf(bot).mark;

  if (mark === "custom" && bot.face?.parts?.length) {
    const paint: Record<string, string> = {
      skin: bot.color,
      ink: INK,
      light: "#f4f4f6",
      dark: "#2b2b2f",
    };
    return (
      <>
        {bot.face.parts.slice(0, 6).map((part, at) => {
          const fill = String(part.fill ?? "skin").toLowerCase();
          const colour = fill.startsWith("#") ? fill : (paint[fill] ?? bot.color);
          const w = (part.w / 100) * u;
          const h = (part.h / 100) * u;
          const ring = part.shape === "ring";
          return (
            <View
              key={at}
              style={{
                position: "absolute",
                left: (part.x / 100) * u - w / 2,
                top: (part.y / 100) * u - h / 2,
                width: w,
                height: h,
                backgroundColor: ring ? "transparent" : colour,
                borderWidth: ring ? Math.max(1, h * 0.22) : 0,
                borderColor: colour,
                borderRadius:
                  part.shape === "ellipse" || ring
                    ? Math.max(w, h)
                    : part.shape === "line"
                      ? h / 2
                      : ((part.r ?? 0) / 100) * Math.min(w, h) * 2,
                transform: [{ rotate: `${part.rot ?? 0}deg` }],
              }}
            />
          );
        })}
      </>
    );
  }

  switch (mark) {
    case "antenna":
      return (
        <>
          <View style={{ position: "absolute", top: -u * 0.2, left: u * 0.48, width: u * 0.045, height: u * 0.22, backgroundColor: bot.color, borderRadius: u * 0.03 }} />
          <View style={{ position: "absolute", top: -u * 0.28, left: u * 0.43, width: u * 0.14, height: u * 0.14, backgroundColor: bot.color, borderRadius: u * 0.07 }} />
        </>
      );
    case "tuft":
      return (
        <View style={{ position: "absolute", top: -u * 0.13, left: u * 0.4, width: u * 0.2, height: u * 0.2, backgroundColor: bot.color, borderTopLeftRadius: u * 0.14, borderBottomRightRadius: u * 0.14, transform: [{ rotate: "-14deg" }] }} />
      );
    case "cheeks":
      return (
        <>
          <View style={{ position: "absolute", top: u * 0.56, left: u * 0.08, width: u * 0.15, height: u * 0.09, backgroundColor: "rgba(0,0,0,0.18)", borderRadius: u * 0.08 }} />
          <View style={{ position: "absolute", top: u * 0.56, right: u * 0.08, width: u * 0.15, height: u * 0.09, backgroundColor: "rgba(0,0,0,0.18)", borderRadius: u * 0.08 }} />
        </>
      );
    case "band":
      return <View style={{ position: "absolute", top: u * 0.12, left: -u * 0.02, width: u * 1.04, height: u * 0.1, backgroundColor: "rgba(0,0,0,0.42)" }} />;
    case "bolt":
      return <View style={{ position: "absolute", top: u * 0.14, right: u * 0.12, width: u * 0.06, height: u * 0.2, backgroundColor: "rgba(0,0,0,0.38)", transform: [{ rotate: "16deg" }] }} />;
    case "cowboy":
      return (
        <>
          <View style={{ position: "absolute", top: -u * 0.3, left: u * 0.27, width: u * 0.46, height: u * 0.27, backgroundColor: HAT, borderTopLeftRadius: u * 0.2, borderTopRightRadius: u * 0.2 }} />
          <View style={{ position: "absolute", top: -u * 0.1, left: -u * 0.01, width: u * 1.02, height: u * 0.15, backgroundColor: HAT, borderRadius: u * 0.5, borderBottomWidth: u * 0.03, borderColor: HAT_DARK }} />
        </>
      );
    case "cap":
      return (
        <>
          <View style={{ position: "absolute", top: -u * 0.22, left: u * 0.22, width: u * 0.56, height: u * 0.28, backgroundColor: HAT, borderTopLeftRadius: u * 0.28, borderTopRightRadius: u * 0.28 }} />
          <View style={{ position: "absolute", top: -u * 0.02, left: u * 0.52, width: u * 0.4, height: u * 0.1, backgroundColor: HAT_DARK, borderTopRightRadius: u * 0.06, borderBottomRightRadius: u * 0.06, transform: [{ rotate: "-5deg" }] }} />
        </>
      );
    case "bow":
      return (
        <>
          <View style={{ position: "absolute", top: -u * 0.12, left: u * 0.26, width: u * 0.2, height: u * 0.17, backgroundColor: "rgba(255,255,255,0.55)", borderTopLeftRadius: u * 0.12, borderBottomRightRadius: u * 0.12 }} />
          <View style={{ position: "absolute", top: -u * 0.12, right: u * 0.26, width: u * 0.2, height: u * 0.17, backgroundColor: "rgba(255,255,255,0.55)", borderTopRightRadius: u * 0.12, borderBottomLeftRadius: u * 0.12 }} />
        </>
      );
    case "halo":
      return (
        <View style={{ position: "absolute", top: -u * 0.24, left: u * 0.24, width: u * 0.52, height: u * 0.16, borderWidth: u * 0.05, borderColor: "#ffd166", borderRadius: u * 0.26 }} />
      );
    default:
      return null;
  }
}

/** What a face is doing, which is a fact about this minute rather than about
 *  the bot. The laptop keeps a longer list; these are the ones the phone can
 *  tell from what it is sent. */
export type Mood = "idle" | "think" | "work" | "sleep";

export default function Face({
  bot,
  size = 40,
  still = false,
  mood = "idle",
}: {
  bot: Bot;
  size?: number;
  /** A portrait rather than a face: no blink.
   *
   *  A face that moves is worth watching in the list the bots live in, and is
   *  something twitching beside the words you are trying to read anywhere
   *  else — the same rule the laptop follows. */
  still?: boolean;
  /** Thinking, working, asleep — or nothing in particular. */
  mood?: Mood;
}) {
  const u = size;
  const face = faceOf(bot);
  // Its own beat, as on the laptop, so a list of bots does not blink in unison.
  const beat = (seedOf(bot.id) % 1700) + 2200;
  const lid = useRef(new Animated.Value(0)).current;
  /** One value drives whichever loop the mood wants: they never run together,
   *  and a face has only so many parts to move. */
  const busy = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (still || (mood !== "think" && mood !== "work")) {
      busy.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(busy, {
          toValue: 1,
          duration: mood === "work" ? 380 : 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(busy, {
          toValue: 0,
          duration: mood === "work" ? 380 : 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, mood, still]);

  useEffect(() => {
    // Asleep, a face does not blink: the eyes are shut, which the lid value
    // below holds them at.
    if (still || mood === "sleep" || face.eyes === "sleepy") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(beat),
        Animated.timing(lid, { toValue: 1, duration: 80, easing: Easing.linear, useNativeDriver: true }),
        Animated.delay(80),
        Animated.timing(lid, { toValue: 0, duration: 210, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [beat, face.eyes, lid, mood, still]);

  // A lid rather than a fade: the eye squashes to nothing and springs back,
  // which is the closest the native driver gets to the laptop's clip.
  const blink = {
    transform: [
      {
        scaleY:
          mood === "sleep"
            ? 0.06
            : lid.interpolate({ inputRange: [0, 1], outputRange: [1, 0.05] }),
      },
    ],
  };

  // Thinking looks up and away, the way anyone does; working leans in. Small
  // numbers on purpose — a face in a list that moves more than a hair is a
  // face that pulls the eye off the words beside it.
  const eyesMove =
    mood === "think"
      ? {
          transform: [
            { translateX: busy.interpolate({ inputRange: [0, 1], outputRange: [0, -u * 0.03] }) },
            { translateY: busy.interpolate({ inputRange: [0, 1], outputRange: [0, -u * 0.035] }) },
          ],
        }
      : null;
  const browsMove =
    mood === "work"
      ? { transform: [{ translateY: busy.interpolate({ inputRange: [0, 1], outputRange: [0, u * 0.045] }) }] }
      : null;
  // Working bobs, slightly, on the beat the brows move on: the whole head
  // rather than a part of it, which is what reads as effort.
  const headMove =
    mood === "work"
      // A pixel and a half at roster size. Less than this and two frames a
      // second apart are the same picture; more and a list of eight bots is a
      // list that will not sit still.
      ? { transform: [{ translateY: busy.interpolate({ inputRange: [0, 1], outputRange: [0, u * 0.04] }) }] }
      : null;

  return (
    <Animated.View
      style={[
        { width: u, height: u, backgroundColor: bot.color, ...headShape(face.head, u) },
        headMove,
      ]}
    >
      {/* What it is thinking with. A dot above the head rather than a cloud:
          at twenty-six points a cloud is a smudge. */}
      {mood === "think" ? (
        <Animated.View
          style={{
            position: "absolute",
            top: -u * 0.16,
            right: -u * 0.04,
            width: u * 0.13,
            height: u * 0.13,
            borderRadius: u * 0.07,
            backgroundColor: "rgba(255,255,255,0.75)",
            opacity: busy.interpolate({ inputRange: [0, 1], outputRange: [0.15, 1] }),
          }}
        />
      ) : null}

      {face.brow !== "none" ? (
        <Animated.View style={[browsMove, { position: "absolute", top: u * 0.31, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: u * 0.16 }]}>
          <View style={{ width: u * 0.2, height: face.brow === "thick" ? u * 0.085 : u * 0.045, borderRadius: u * 0.03, backgroundColor: "rgba(0,0,0,0.56)", transform: [{ rotate: face.brow === "angled" ? "12deg" : "0deg" }, { translateY: face.brow === "quirk" ? -u * 0.05 : 0 }] }} />
          <View style={{ width: u * 0.2, height: face.brow === "thick" ? u * 0.085 : u * 0.045, borderRadius: u * 0.03, backgroundColor: "rgba(0,0,0,0.56)", transform: [{ rotate: face.brow === "angled" ? "-12deg" : "0deg" }] }} />
        </Animated.View>
      ) : null}

      <Animated.View style={[eyesMove, { position: "absolute", top: u * 0.42, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: u * 0.16 }]}>
        <Animated.View style={[eyeShape(face.eyes, u, false), blink]} />
        <Animated.View style={[eyeShape(face.eyes, u, true), face.eyes === "wink" ? undefined : blink]} />
      </Animated.View>

      <View style={{ position: "absolute", top: u * 0.64, left: 0, right: 0, alignItems: "center" }}>
        <View style={smileShape(face.smile, u)} />
      </View>

      <Mark bot={bot} u={u} />
    </Animated.View>
  );
}
