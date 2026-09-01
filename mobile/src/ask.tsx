/**
 * A bot's question, with its answers ready to press.
 *
 * The point of this on a phone is larger than it is on the laptop. A routine
 * that fires while nobody is at the desk asks into an empty room; answering it
 * used to mean unlocking a phone, opening the app, finding the conversation
 * and typing a sentence one-handed. It means pressing a word now.
 *
 * The row stays after it is answered, showing what was chosen. A thread read
 * the next morning should still say what was asked and what you said back —
 * buttons that vanish leave an answer that came from nowhere.
 */

import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { T } from "./theme";
import type { Message } from "./types";

export default function Ask({
  msg,
  onAnswer,
}: {
  msg: Message;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [sending, setSending] = React.useState<string | null>(null);
  if (!msg.ask) return null;
  const { question, options, answered } = msg.ask;

  return (
    <View style={s.wrap}>
      {/* Usually absent: the reply above has just asked it in the bot's own
          words, and repeating it here is the app talking over the bot. */}
      {question ? <Text style={s.question}>{question}</Text> : null}
      <View style={s.row}>
        {options.map((one) => {
          const chosen = answered === one;
          const busy = sending === one;
          return (
            <Pressable
              key={one}
              style={[s.opt, answered ? s.optDone : null, chosen ? s.optChosen : null]}
              disabled={!!answered || !!sending}
              onPress={async () => {
                setSending(one);
                try {
                  await onAnswer(one);
                } finally {
                  setSending(null);
                }
              }}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!answered, selected: chosen }}
            >
              {busy ? (
                <ActivityIndicator size="small" color={T.text2} />
              ) : (
                <Text style={[s.optText, chosen ? s.optTextChosen : null]}>{one}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: 7 },
  question: { marginBottom: 6, color: T.text2, fontSize: 13 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  opt: {
    justifyContent: "center",
    minHeight: 34,
    paddingVertical: 7,
    paddingHorizontal: 13,
    backgroundColor: T.field,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.line,
  },
  // Answered: the ones passed over are what make the one chosen mean anything,
  // so they stay, quietly.
  optDone: { opacity: 0.45 },
  optChosen: { opacity: 1, borderColor: T.blue, backgroundColor: T.raised },
  optText: { color: T.text, fontSize: 14 },
  optTextChosen: { fontWeight: "600" },
});
