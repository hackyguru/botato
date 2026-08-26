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
import Composer from "../composer";
import Markdown, { type Mentionable } from "../markdown";
import { Cal } from "../marks";
import { T } from "../theme";
import { Initial, startsRun, Turn } from "../turn";

export default function Room({
  channel,
  bots,
  called,
  parent,
  threads,
  onBack,
  onSend,
  onOpenThread,
  onCalendar,
}: {
  channel: Channel;
  bots: Bot[];
  /** What you are called, so a bot saying it is visibly saying it to you. */
  called?: string;
  parent?: Channel;
  threads: Channel[];
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onOpenThread: (thread: Channel) => void;
  /** What is scheduled to happen in this room. */
  onCalendar: () => void;
}) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<ScrollView>(null);
  const inside = channel.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));

  // The same set the laptop lights up: the room's members, the three spellings
  // that call the whole room, and you.
  const mentions: Mentionable[] = [
    ...inside.map((bot) => ({ name: bot.name, kind: "bot" as const })),
    ...(inside.length
      ? ["everyone", "channel", "here"].map((name) => ({ name, kind: "room" as const }))
      : []),
    ...(called?.trim() ? [{ name: called.trim(), kind: "you" as const }] : []),
  ];

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
        <Pressable style={s.headAct} onPress={onCalendar} hitSlop={10}>
          <Cal size={19} />
        </Pressable>
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

        {channel.messages.map((msg, n) => (
          <Said
            key={msg.id}
            msg={msg}
            prev={channel.messages[n - 1]}
            bots={bots}
            mentions={mentions}
            called={called}
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

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        placeholder={channel.from ? "Reply in this thread" : `Message #${channel.name}`}
      />
    </KeyboardAvoidingView>
  );
}

/** One message, with the face of whoever said it — at the head of a run of
 *  them, and nothing at all on the lines that continue it. */
function Said({
  msg,
  prev,
  bots,
  mentions,
  called,
  thread,
  onOpenThread,
}: {
  msg: Message;
  prev?: Message;
  bots: Bot[];
  mentions: Mentionable[];
  called?: string;
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
  const said = thread ? Math.max(0, thread.messages.filter((m) => m.text.trim()).length - 1) : 0;
  const head = startsRun(msg, prev);
  const name = author ? author.name : "You";
  // Not "does your name appear" — a bot discussing a file called guru.md is
  // not talking to you. The "@" is what makes it a summons, here as on the
  // laptop.
  const ping =
    msg.from === "bot" &&
    !!called?.trim() &&
    new RegExp(`@${called.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(msg.text);

  return (
    <Turn
      head={head}
      face={author ? <Face bot={author} size={26} still /> : <Initial name={name} />}
      name={name}
      at={msg.at}
      fromPhone={msg.fromPhone}
      ping={ping}
    >
      {msg.pinned ? <Text style={s.pin}>📌</Text> : null}
      <Markdown text={msg.text} mentions={mentions} />
      {thread ? (
        <Pressable style={s.strip} onPress={() => onOpenThread(thread)}>
          <Text style={s.stripText}>
            ↳ {said === 0 ? "Thread — nothing said yet" : said === 1 ? "1 reply" : `${said} replies`}
          </Text>
        </Pressable>
      ) : null}
    </Turn>
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
  headAct: { paddingHorizontal: 4 },
  faces: { flexDirection: "row" },
  facePeek: { marginLeft: -6 },

  /* Rows sit flush; the air belongs to the head of a run. */
  list: { padding: 14, paddingBottom: 24, gap: 0 },
  empty: { color: T.text2, fontSize: 14, lineHeight: 21, textAlign: "center", paddingVertical: 40 },

  pin: { position: "absolute", top: -2, right: 0, fontSize: 11 },

  strip: {
    alignSelf: "flex-start",
    marginTop: 5,
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
    letterSpacing: 0,
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
