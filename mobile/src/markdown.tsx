/**
 * The same markdown subset the desktop renders, drawn with React Native text.
 *
 * A bot writes the same way to both screens — backticks around a repo name,
 * asterisks for emphasis, a fenced block for a command — so a phone showing the
 * raw characters is not a smaller version of the app, it is a worse one. The
 * rules here are deliberately the desktop's: inline code, links, bold, italic,
 * bullets, headings and fenced blocks, and nothing else.
 */
import { Linking, StyleSheet, Text, View } from "react-native";
import { T } from "./theme";

/** One run of text with the styling that applies to it. */
interface Piece {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
  men?: Mentionable["kind"];
}

/** Someone an "@" can reach in this conversation. The laptop lights up exactly
 *  the names that summon somebody, and so does this: a phone that highlighted
 *  every word after an at sign would be telling you a turn had been spent when
 *  none had. */
export interface Mentionable {
  name: string;
  kind: "bot" | "room" | "you";
}

const INLINE =
  /(`[^`]+`)|(\[[^\]]+\]\(https?:[^\s)]+\))|(https?:\/\/[^\s]+)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/;

/** Cut a line into styled runs. Same order of precedence as the desktop: code
 *  first, so asterisks inside a command are left alone. */
function pieces(line: string, who: Mentionable[]): Piece[] {
  const out: Piece[] = [];
  let rest = line;

  while (rest.length > 0) {
    const at = rest.search(INLINE);
    if (at < 0) {
      out.push({ text: rest });
      break;
    }
    if (at > 0) out.push({ text: rest.slice(0, at) });

    const match = INLINE.exec(rest.slice(at))![0];
    rest = rest.slice(at + match.length);

    if (match.startsWith("`")) {
      out.push({ text: match.slice(1, -1), code: true });
    } else if (match.startsWith("[")) {
      const [, label, href] = /\[([^\]]+)\]\((https?:[^\s)]+)\)/.exec(match)!;
      out.push({ text: label, href });
    } else if (match.startsWith("http")) {
      out.push({ text: match, href: match });
    } else if (match.startsWith("**")) {
      out.push({ text: match.slice(2, -2), bold: true });
    } else {
      out.push({ text: match.slice(1, -1), italic: true });
    }
  }
  // Mentions last, and only in what is left as prose: the "@" in a link or in
  // a command is not a summons.
  return out.flatMap((piece) =>
    piece.code || piece.href ? [piece] : summons(piece, who),
  );
}

/** Cut one plain run around the names in it. */
function summons(piece: Piece, who: Mentionable[]): Piece[] {
  if (!who.length || !piece.text.includes("@")) return [piece];
  // Longest first, so "@Research and Writing" is one person rather than one
  // person and a conjunction — the rule the laptop follows when it decides
  // who actually gets the message.
  const wanted = [...who].sort((a, b) => b.name.length - a.name.length);

  const out: Piece[] = [];
  let rest = piece.text;
  let held = "";
  while (rest.length > 0) {
    const at = rest.indexOf("@");
    if (at < 0) break;
    held += rest.slice(0, at);
    const after = rest.slice(at + 1).toLowerCase();
    const hit = wanted.find(
      (w) =>
        after.startsWith(w.name.toLowerCase()) &&
        !/[a-z0-9]/.test(after[w.name.length] ?? " "),
    );
    if (!hit) {
      held += "@";
      rest = rest.slice(at + 1);
      continue;
    }
    if (held) out.push({ ...piece, text: held });
    held = "";
    out.push({ ...piece, text: rest.slice(at, at + 1 + hit.name.length), men: hit.kind });
    rest = rest.slice(at + 1 + hit.name.length);
  }
  if (held + rest) out.push({ ...piece, text: held + rest });
  return out;
}

function Line({ text, who }: { text: string; who: Mentionable[] }) {
  return (
    <Text style={s.body}>
      {pieces(text, who).map((piece, at) => (
        <Text
          key={at}
          style={[
            piece.bold && s.bold,
            piece.italic && s.italic,
            piece.code && s.code,
            piece.href && s.link,
            piece.men ? s.men : null,
            piece.men === "you" ? s.menYou : null,
            piece.men === "room" ? s.menRoom : null,
          ]}
          onPress={piece.href ? () => void Linking.openURL(piece.href!) : undefined}
        >
          {piece.text}
        </Text>
      ))}
    </Text>
  );
}

export default function Markdown({
  text,
  mentions = [],
}: {
  text: string;
  mentions?: Mentionable[];
}) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let at = 0;
  let key = 0;

  while (at < lines.length) {
    const line = lines[at];

    // A fenced block runs until its closing fence, or the end of what has
    // arrived so far — a reply is still streaming while this draws.
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      at += 1;
      while (at < lines.length && !lines[at].trimStart().startsWith("```")) {
        body.push(lines[at]);
        at += 1;
      }
      at += 1;
      blocks.push(
        <View key={key++} style={s.block}>
          <Text style={s.blockText}>{body.join("\n")}</Text>
        </View>,
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <Text key={key++} style={s.heading}>
          {heading[2]}
        </Text>,
      );
      at += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={key++} style={s.bullet}>
          <Text style={s.dot}>•</Text>
          <View style={s.bulletBody}>
            <Line text={bullet[1]} who={mentions} />
          </View>
        </View>,
      );
      at += 1;
      continue;
    }

    if (line.trim() === "") {
      // Keep one gap rather than however many blank lines arrived.
      if (blocks.length > 0) blocks.push(<View key={key++} style={s.gap} />);
      at += 1;
      continue;
    }

    blocks.push(<Line key={key++} text={line} who={mentions} />);
    at += 1;
  }

  return <>{blocks}</>;
}

const s = StyleSheet.create({
  body: { color: T.text, fontSize: 15.5, lineHeight: 22 },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  code: {
    // The desktop sets inline code apart with a tint rather than a box, which
    // keeps a line of prose from turning into a row of chips.
    fontFamily: T.mono,
    fontSize: 13.5,
    color: "#e6e6e6",
    backgroundColor: "rgba(255,255,255,0.09)",
  },
  link: { color: T.link, textDecorationLine: "underline" },
  /* A tint rather than the link colour: a mention is not tappable, and
     colouring it like the link on the line above would say that it was. */
  men: { color: "#7ab6ff", backgroundColor: "rgba(10,132,255,0.16)", fontWeight: "500" },
  menRoom: { backgroundColor: "rgba(10,132,255,0.22)" },
  menYou: { color: "#f5c26b", backgroundColor: "rgba(240,178,50,0.22)" },
  heading: { marginTop: 4, color: T.text, fontSize: 16, fontWeight: "600", lineHeight: 23 },
  block: {
    marginVertical: 6,
    padding: 10,
    backgroundColor: "#121214",
    borderRadius: 10,
  },
  blockText: { color: T.text2, fontFamily: T.mono, fontSize: 12.5, lineHeight: 18 },
  bullet: { flexDirection: "row", gap: 8 },
  bulletBody: { flex: 1, minWidth: 0 },
  dot: { color: T.text2, fontSize: 15.5, lineHeight: 22 },
  gap: { height: 8 },
});
