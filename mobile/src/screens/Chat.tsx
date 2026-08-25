/**
 * One bot's conversation, streaming.
 *
 * The reply is assembled here from the same deltas the desktop paints, so the
 * two screens fill in together rather than the phone waiting for a finished
 * answer. What the bot is doing between tokens — thinking, running a tool — is
 * shown as it happens, because a laptop in another room gives no other clue
 * that anything is happening at all.
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Bot, Message } from "../types";
import Face from "../face";
import Markdown from "../markdown";
import { T } from "../theme";
import { Initial, startsRun, Turn } from "../turn";

export default function Chat({
  bot,
  note,
  onBack,
  onSettings,
  onSend,
  onCancel,
}: {
  bot: Bot;
  /** What the bot is doing right now, from the event stream. */
  note: string;
  onBack: () => void;
  onSettings: () => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scroll = useRef<ScrollView>(null);

  // Follow the reply as it grows, the way the desktop thread does.
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [bot.messages.length, bot.messages[bot.messages.length - 1]?.text, note]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || bot.busy) return;
    setSending(true);
    setDraft("");
    try {
      await onSend(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={s.head}>
        <Pressable onPress={onBack} hitSlop={14}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Face bot={bot} size={30} />
        <View style={s.headBody}>
          <Text style={s.name} numberOfLines={1}>
            {bot.name}
          </Text>
          <Text style={s.role} numberOfLines={1}>
            {bot.busy ? note || "Working…" : bot.role || "Ready"}
          </Text>
        </View>
        <Pressable onPress={onSettings} hitSlop={14}>
          <Text style={s.gear}>⋯</Text>
        </Pressable>
      </View>

      <ScrollView ref={scroll} contentContainerStyle={s.thread}>
        {bot.messages.length === 0 ? (
          <Text style={s.empty}>Nothing yet. Say something.</Text>
        ) : null}
        {bot.messages.map((message: Message, n: number) => {
          const head = startsRun(message, bot.messages[n - 1]);
          const bots = message.from === "bot";
          return (
            <Turn
              key={message.id}
              head={head}
              face={bots ? <Face bot={bot} size={26} still /> : <Initial name="You" />}
              name={bots ? bot.name : "You"}
              at={message.at}
              fromPhone={message.fromPhone}
            >
              {bots ? (
                // What a bot writes is markdown, and the desktop renders it. A
                // phone showing the backticks is not a smaller app, just a
                // worse one. What you type is left exactly as you typed it.
                <Markdown text={message.text || (bot.busy ? "…" : "")} />
              ) : (
                <Text style={s.text}>{message.text}</Text>
              )}
            </Turn>
          );
        })}
        {bot.busy ? (
          <View style={s.working}>
            <ActivityIndicator size="small" color={T.text3} />
            <Text style={s.workingText}>{note || "Thinking…"}</Text>
            <Pressable onPress={onCancel} hitSlop={10}>
              <Text style={s.stop}>Stop</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      <View style={s.dock}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={`Message ${bot.name}`}
          placeholderTextColor={T.text3}
          multiline
        />
        <Pressable
          style={[s.send, (!draft.trim() || bot.busy) && s.sendOff]}
          onPress={send}
          disabled={!draft.trim() || bot.busy}
        >
          <Text style={s.sendText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  head: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    paddingTop: 62,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.line,
  },
  back: { color: T.blue, fontSize: 32, lineHeight: 34, fontWeight: "300" },
  headBody: { flex: 1, minWidth: 0 },
  name: { color: T.text, fontSize: 17, fontWeight: "600" },
  role: { color: T.text2, fontSize: 12.5 },
  gear: { color: T.text2, fontSize: 22 },
  /* Rows sit flush; the air belongs to the head of a run. */
  thread: { padding: 14, paddingBottom: 20, gap: 0 },
  empty: { marginTop: 60, color: T.text3, fontSize: 14, textAlign: "center" },
  text: { color: T.text, fontSize: 15.5, lineHeight: 22 },
  working: { flexDirection: "row", gap: 10, alignItems: "center", paddingHorizontal: 6 },
  workingText: { flex: 1, color: T.text3, fontSize: 13 },
  stop: { color: T.red, fontSize: 13, fontWeight: "600" },
  dock: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
    padding: 10,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.line,
  },
  input: {
    flex: 1,
    maxHeight: 130,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    color: T.text,
    fontSize: 16,
    backgroundColor: T.field,
    borderRadius: 22,
  },
  send: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    backgroundColor: T.blue,
    borderRadius: 22,
  },
  sendOff: { opacity: 0.35 },
  sendText: { color: "#fff", fontSize: 20, fontWeight: "600" },
});
