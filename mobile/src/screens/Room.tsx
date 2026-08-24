/**
 * A channel, on the phone.
 *
 * The same room as on the laptop, drawn the same way: several bots and you,
 * each message wearing the face of whoever said it, because a room with more
 * than two voices needs to say which one is speaking.
 *
 * A thread is a channel with a parent, here as there — so this screen draws
 * both, and the only difference is a line at the top saying where it came
 * from.
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
import type { Bot, Channel, Message } from "../types";
import Face from "../face";
import Markdown from "../markdown";
import { T } from "../theme";

export default function Room({
  channel,
  bots,
  parent,
  threads,
  onBack,
  onSend,
  onOpenThread,
}: {
  channel: Channel;
  bots: Bot[];
  parent?: Channel;
  threads: Channel[];
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onOpenThread: (thread: Channel) => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<ScrollView>(null);
  const inside = channel.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));

  useEffect(() => {
    const to = setTimeout(() => scroller.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(to);
  }, [channel.messages.length, channel.id]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend(text);
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
        <View style={s.heading}>
          <Text style={s.title} numberOfLines={1}>
            {channel.from ? "↳ " : "#"}
            {channel.name}
          </Text>
          {parent ? <Text style={s.parent}>in #{parent.name}</Text> : null}
        </View>
        <View style={s.faces}>
          {inside.slice(0, 3).map((bot) => (
            <View key={bot.id} style={s.facePeek}>
              <Face bot={bot} size={22} />
            </View>
          ))}
        </View>
      </View>

      <ScrollView ref={scroller} contentContainerStyle={s.list}>
        {channel.messages.length === 0 ? (
          <Text style={s.empty}>
            {inside.length > 1
              ? `${inside.map((b) => b.name).join(", ")} are in here. Name one with @ to bring them in.`
              : inside.length === 1
                ? `${inside[0].name} is in here and answers everything said.`
                : "Nobody is in here yet."}
          </Text>
        ) : null}

        {channel.messages.map((msg) => (
          <Said
            key={msg.id}
            msg={msg}
            bots={bots}
            thread={threads.find((t) => t.from?.messageId === msg.id)}
            onOpenThread={onOpenThread}
          />
        ))}

        {channel.busy ? (
          <View style={s.working}>
            <ActivityIndicator color={T.text3} />
          </View>
        ) : null}
      </ScrollView>

      <View style={s.dock}>
        <TextInput
          style={s.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={channel.from ? "Reply in this thread" : `Message #${channel.name}`}
          placeholderTextColor={T.text3}
          multiline
        />
        <Pressable style={[s.send, !draft.trim() && s.sendOff]} onPress={send}>
          <Text style={s.sendText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/** One message, with the face of whoever said it. */
function Said({
  msg,
  bots,
  thread,
  onOpenThread,
}: {
  msg: Message;
  bots: Bot[];
  thread?: Channel;
  onOpenThread: (thread: Channel) => void;
}) {
  // A routine firing is a marker, not something said — the same badge the
  // laptop shows, so a bot suddenly talking about last night's backups says
  // why.
  if (msg.kind === "routine") {
    return (
      <View style={s.note}>
        <Text style={s.noteText}>Routine · {msg.meta?.name ?? ""}</Text>
      </View>
    );
  }

  const author = msg.from === "bot" ? bots.find((b) => b.id === msg.by) : undefined;
  const mine = msg.from === "me";
  const said = thread ? Math.max(0, thread.messages.filter((m) => m.text.trim()).length - 1) : 0;

  return (
    <View style={[s.turn, mine ? s.turnMine : s.turnTheirs]}>
      {author ? (
        <View style={s.gutter}>
          <Face bot={author} size={22} />
        </View>
      ) : null}
      <View style={mine ? s.stackMine : s.stack}>
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
          {msg.pinned ? <Text style={s.pin}>📌</Text> : null}
          <Markdown text={msg.text} />
        </View>
        {thread ? (
          <Pressable style={s.strip} onPress={() => onOpenThread(thread)}>
            <Text style={s.stripText}>
              ↳ {said === 0 ? "Thread — nothing said yet" : said === 1 ? "1 reply" : `${said} replies`}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  head: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    paddingTop: 62,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: T.line,
  },
  back: { color: T.blue, fontSize: 32, lineHeight: 34, fontWeight: "300" },
  heading: { flex: 1, minWidth: 0 },
  title: { color: T.text, fontSize: 17, fontWeight: "600" },
  parent: { color: T.text3, fontSize: 12, marginTop: 1 },
  faces: { flexDirection: "row" },
  facePeek: { marginLeft: -6 },

  list: { padding: 14, paddingBottom: 24, gap: 10 },
  empty: { color: T.text2, fontSize: 14, lineHeight: 21, textAlign: "center", paddingVertical: 40 },

  turn: { flexDirection: "row", gap: 8, alignItems: "flex-start", maxWidth: "100%" },
  turnMine: { justifyContent: "flex-end" },
  turnTheirs: { justifyContent: "flex-start" },
  gutter: { paddingTop: 4 },
  stack: { flexShrink: 1, alignItems: "flex-start", gap: 5 },
  stackMine: { flexShrink: 1, alignItems: "flex-end", gap: 5 },

  bubble: { maxWidth: "100%", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16 },
  bubbleTheirs: { backgroundColor: T.field },
  bubbleMine: { backgroundColor: T.bubbleMe },
  pin: { position: "absolute", top: -8, right: -4, fontSize: 11 },

  strip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: T.line,
  },
  stripText: { color: T.text2, fontSize: 12 },

  note: { alignItems: "center", paddingVertical: 6 },
  noteText: { color: T.text3, fontSize: 12 },
  working: { paddingVertical: 14 },

  dock: {
    flexDirection: "row",
    gap: 10,
    alignItems: "flex-end",
    padding: 12,
    paddingBottom: 30,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.line,
  },
  input: {
    flex: 1,
    maxHeight: 130,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: T.field,
    borderRadius: 20,
    color: T.text,
    fontSize: 15,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: T.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.35 },
  sendText: { color: "#fff", fontSize: 19, fontWeight: "600" },
});
