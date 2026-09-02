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
  Alert,
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
import Sheet from "../sheet";
import Ask from "../ask";
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
  onPin,
  onAnswer,
  onFace,
  onThread,
  onEdit,
  onDeleteChannel,
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
  /** Pin or unpin one message. The laptop decides which, so that a stale
   *  snapshot cannot pin something that is already pinned. */
  onPin: (messageId: string) => Promise<void>;
  /** Press one of a bot's answers. */
  onAnswer: (messageId: string, answer: string) => Promise<void>;
  /** Tapping a face: who this bot is, on a card. */
  onFace: (bot: Bot) => void;
  /** Pull a message aside into a thread of its own, and open it. */
  onThread: (messageId: string) => Promise<void>;
  /** Rename the room, say what it is for, or change who is in it. */
  onEdit: (fields: {
    name: string;
    purpose: string;
    members: string[];
    muted: boolean;
  }) => Promise<void>;
  /** Close it for good. */
  onDeleteChannel: () => Promise<void>;
  /** What is scheduled to happen in this room. */
  onCalendar: () => void;
}) {
  const [draft, setDraft] = useState("");
  /** The message being acted on, or none. Held by id rather than by value so
   *  the sheet follows the message when the snapshot is read again — pinning
   *  one and finding the sheet still saying "Pin" is the kind of small lie
   *  that makes a phone feel like a stale copy of somewhere else. */
  const [acting, setActing] = useState<string | null>(null);
  const chosen = channel.messages.find((m) => m.id === acting);
  const [working, setWorking] = useState(false);

  /** The room's own settings, open or not. Its fields start from the room and
   *  are reset each time it opens, so an edit abandoned halfway is abandoned
   *  rather than waiting to surprise somebody. */
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState(channel.name);
  const [purpose, setPurpose] = useState(channel.purpose ?? "");
  const [members, setMembers] = useState<string[]>(channel.members);
  const [muted, setMuted] = useState(!!channel.muted);

  function openSettings() {
    setName(channel.name);
    setPurpose(channel.purpose ?? "");
    setMembers(channel.members);
    setMuted(!!channel.muted);
    setSettings(true);
  }
  const scroller = useRef<ScrollView>(null);
  const inside = channel.members
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));

  // The same set the laptop lights up: the room's members, the three spellings
  // that call the whole room, and you.
  const mentions: Mentionable[] = [
    ...inside.map((bot) => ({ name: bot.name, kind: "bot" as const, tint: bot.color })),
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
        {/* A thread has nothing to configure: it is named after the message it
            came from and its members are the room's. */}
        {!channel.from ? (
          <Pressable
            style={s.headAct}
            onPress={openSettings}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Settings for #${channel.name}`}
          >
            <Text style={s.dots}>⋯</Text>
          </Pressable>
        ) : null}
        <View style={s.faces}>
          {inside.slice(0, 3).map((bot) => (
            <Pressable
              key={bot.id}
              style={s.facePeek}
              onPress={() => onFace(bot)}
              accessibilityRole="button"
              accessibilityLabel={`About ${bot.name}`}
            >
              <Face bot={bot} size={22} />
            </Pressable>
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
            onHold={() => setActing(msg.id)}
            onAnswer={onAnswer}
            onFace={onFace}
          />
        ))}

        {channel.busy ? (
          <View style={s.working}>
            <ActivityIndicator color={T.text3} />
          </View>
        ) : null}
      </ScrollView>

      {/* The room itself: what it is called, what it is for, and who is in
          it — the same three the laptop's form asks for, because they are the
          same room. */}
      <Sheet open={settings} title={`#${channel.name}`} onClose={() => setSettings(false)}>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="Name"
          placeholderTextColor={T.text3}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TextInput
          style={s.input}
          value={purpose}
          onChangeText={setPurpose}
          placeholder="What it is for"
          placeholderTextColor={T.text3}
        />

        <Text style={s.who}>WHO IS IN IT</Text>
        <View style={s.chips}>
          {bots.map((bot) => {
            const on = members.includes(bot.id);
            return (
              <Pressable
                key={bot.id}
                style={[s.chip, on && s.chipOn]}
                onPress={() =>
                  setMembers((was) =>
                    was.includes(bot.id) ? was.filter((id) => id !== bot.id) : [...was, bot.id],
                  )
                }
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
              >
                <Face bot={bot} size={20} mood="idle" />
                <Text style={[s.chipText, on && s.chipTextOn]} numberOfLines={1}>
                  {bot.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Bots talk to each other, so a room of them is the one place here that
            gets genuinely noisy — and a room you cannot quieten is a room you
            end up leaving. This is not leaving: it all still happens, and
            anything waiting on an answer still reaches your desk. */}
        <Pressable
          style={s.mute}
          onPress={() => setMuted((was) => !was)}
          accessibilityRole="switch"
          accessibilityState={{ checked: muted }}
        >
          <View style={s.muteWords}>
            <Text style={s.muteLabel}>Mute this channel</Text>
            <Text style={s.muteHint}>No unread mark and no notification.</Text>
          </View>
          <View style={[s.pip, muted && s.pipOn]}>
            <View style={[s.knob, muted && s.knobOn]} />
          </View>
        </Pressable>

        <Pressable
          style={[s.save, !name.trim() && s.saveOff]}
          disabled={working || !name.trim()}
          onPress={async () => {
            setWorking(true);
            try {
              await onEdit({ name, purpose, members, muted });
              setSettings(false);
            } finally {
              setWorking(false);
            }
          }}
        >
          {working ? <ActivityIndicator color="#fff" /> : <Text style={s.saveText}>Save</Text>}
        </Pressable>

        {/* Asked about rather than done: a room holds everything said in it,
            and the threads that came out of it go too. */}
        <Pressable
          style={s.danger}
          onPress={() => {
            const threadsHere = threads.filter((t) => t.from?.channelId === channel.id).length;
            Alert.alert(
              `Delete #${channel.name}?`,
              threadsHere
                ? `Everything said in it goes, and so do its ${threadsHere} thread${threadsHere > 1 ? "s" : ""}.`
                : "Everything said in it goes.",
              [
                { text: "Keep it", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => {
                    setSettings(false);
                    void onDeleteChannel();
                  },
                },
              ],
            );
          }}
        >
          <Text style={s.dangerText}>Delete channel</Text>
        </Pressable>
      </Sheet>

      {/* What can be done with one message. A sheet rather than a menu pinned
          to the message: a phone has no pointer to anchor one to, and a
          message near the bottom of the screen would have the menu under the
          keyboard. */}
      <Sheet open={!!chosen} title="Message" onClose={() => setActing(null)}>
        {chosen ? (
          <>
            {/* Which one, in its own words. Holding the wrong message is easy
                and a sheet that does not say what it is about invites it. */}
            <Text style={s.quoted} numberOfLines={3}>
              {chosen.text.trim() || "…"}
            </Text>

            <Pressable
              style={s.act}
              disabled={working}
              onPress={async () => {
                setWorking(true);
                try {
                  await onPin(chosen.id);
                  setActing(null);
                } finally {
                  setWorking(false);
                }
              }}
            >
              <Text style={s.actText}>{chosen.pinned ? "Unpin message" : "Pin message"}</Text>
            </Pressable>

            {/* Quoting is the one that needs nothing from the laptop: it is
                two lines of what was said, dropped into the field, exactly as
                the laptop's reply button does it. */}
            <Pressable
              style={s.act}
              onPress={() => {
                setDraft(
                  `${chosen.text
                    .split("\n")
                    .slice(0, 2)
                    .map((line) => `> ${line}`)
                    .join("\n")}\n\n${draft}`,
                );
                setActing(null);
              }}
            >
              <Text style={s.actText}>Quote in a reply</Text>
            </Pressable>

            {/* Only from a room. A thread hangs off a message in a channel,
                and a thread of a thread is a place nobody can find again. */}
            {!channel.from ? (
              <Pressable
                style={s.act}
                disabled={working}
                onPress={async () => {
                  setWorking(true);
                  try {
                    await onThread(chosen.id);
                    setActing(null);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                <Text style={s.actText}>Start a thread</Text>
              </Pressable>
            ) : null}

            {working ? <ActivityIndicator color={T.text3} style={s.acting} /> : null}
          </>
        ) : null}
      </Sheet>

      <Composer
        value={draft}
        onChange={setDraft}
        onSend={send}
        placeholder={channel.from ? "Reply in this thread" : `Message #${channel.name}`}
        // Who an "@" can finish into. The room's members, which is the same
        // set the laptop offers and the same set that gets summoned.
        members={inside}
        offering={inside}
        inRoom
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
  onHold,
  onAnswer,
  onFace,
}: {
  msg: Message;
  prev?: Message;
  bots: Bot[];
  mentions: Mentionable[];
  called?: string;
  thread?: Channel;
  onOpenThread: (thread: Channel) => void;
  /** Held down: what a phone has instead of the row of buttons that appears
   *  under a cursor on the laptop. */
  onHold: () => void;
  onAnswer: (messageId: string, answer: string) => Promise<void>;
  onFace: (bot: Bot) => void;
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
      face={
        author ? (
          <Pressable
            onPress={() => onFace(author)}
            accessibilityRole="button"
            accessibilityLabel={`About ${author.name}`}
          >
            <Face bot={author} size={26} still />
          </Pressable>
        ) : (
          <Initial name={name} />
        )
      }
      name={name}
      at={msg.at}
      fromPhone={msg.fromPhone}
      ping={ping}
      onHold={onHold}
    >
      {msg.pinned ? <Text style={s.pin}>📌</Text> : null}
      <Markdown text={msg.text} mentions={mentions} />
      <Ask msg={msg} onAnswer={(answer) => onAnswer(msg.id, answer)} />
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
  dots: { color: T.text3, fontSize: 22, lineHeight: 24 },
  input: {
    letterSpacing: 0,
    height: 44,
    paddingHorizontal: 12,
    color: T.text,
    fontSize: 15,
    backgroundColor: T.field,
    borderRadius: 11,
  },
  who: {
    marginTop: 6,
    marginLeft: 2,
    color: T.text3,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.7,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: T.field,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "transparent",
  },
  chipOn: { borderColor: T.blue, backgroundColor: T.raised },
  chipText: { maxWidth: 140, color: T.text2, fontSize: 13 },
  chipTextOn: { color: T.text, fontWeight: "600" },
  mute: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  muteWords: { flex: 1, minWidth: 0 },
  muteLabel: { color: T.text, fontSize: 15 },
  muteHint: { marginTop: 2, color: T.text3, fontSize: 12.5 },
  pip: {
    justifyContent: "center",
    width: 44,
    height: 26,
    padding: 3,
    borderRadius: 13,
    backgroundColor: T.field,
  },
  pipOn: { backgroundColor: T.blue },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: T.text3 },
  knobOn: { backgroundColor: "#fff", alignSelf: "flex-end" },
  save: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
    height: 44,
    backgroundColor: T.blue,
    borderRadius: 11,
  },
  saveOff: { opacity: 0.4 },
  saveText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  danger: { alignItems: "center", justifyContent: "center", height: 44 },
  dangerText: { color: T.red, fontSize: 15 },
  quoted: {
    marginBottom: 4,
    paddingVertical: 9,
    paddingHorizontal: 12,
    color: T.text2,
    fontSize: 14,
    lineHeight: 19,
    backgroundColor: T.field,
    borderRadius: 10,
  },
  act: {
    justifyContent: "center",
    height: 46,
    paddingHorizontal: 13,
    backgroundColor: T.field,
    borderRadius: 11,
  },
  actText: { color: T.text, fontSize: 15 },
  acting: { paddingTop: 6 },
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

});
