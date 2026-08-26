/**
 * Every bot on the laptop, and whether it is doing something right now.
 *
 * The list is a live view rather than a snapshot: the same event stream that
 * drives a conversation also marks a bot busy here, so a routine that fires
 * while the phone is in a pocket is visible when it comes back out.
 */
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Bot, Channel, Message } from "../types";
import Face from "../face";
import { T } from "../theme";
import { unreadIn } from "../unread";


function Badge({ unread, mentions }: { unread: number; mentions: number }) {
  if (mentions) {
    return (
      <View style={s.badge}>
        <Text style={s.badgeText}>{mentions > 9 ? "9+" : mentions}</Text>
      </View>
    );
  }
  return unread ? <View style={s.unreadDot} /> : null;
}

/** Whether the laptop is answering, as a light rather than a sentence.
 *
 *  It breathes while the link is up — a still dot says nothing about whether
 *  anything is still listening. Colour alone carries no meaning, so the state
 *  is also spoken: a screen reader still hears "connected to your laptop".
 *  Anyone who has asked the system for less motion gets a steady dot. */
function Light({ connected }: { connected: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const [still, setStill] = useState(false);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setStill(on));
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setStill);
    return () => {
      live = false;
      listener.remove();
    };
  }, []);

  useEffect(() => {
    if (!connected || still) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.25, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [connected, still, pulse]);

  return (
    <Animated.View
      accessibilityRole="image"
      accessibilityLabel={connected ? "Connected to your laptop" : "Reconnecting to your laptop"}
      style={[
        s.light,
        { backgroundColor: connected ? T.green : T.amber, shadowColor: connected ? T.green : T.amber },
        connected && !still ? { opacity: pulse } : null,
      ]}
    />
  );
}


export default function Bots({
  bots,
  channels,
  called,
  connected,
  loading,
  onRefresh,
  onOpen,
  onOpenChannel,
  onCreate,
}: {
  bots: Bot[];
  channels: Channel[];
  called: string;
  connected: boolean;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (bot: Bot) => void;
  onOpenChannel: (channel: Channel) => void;
  onCreate: (name: string, role: string) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();


  // Rooms, each followed by its threads. Flattened once rather than inside the
  // map, so a row can ask what comes after it — which is how the last thread
  // under a room knows to close the branch it hangs from.
  // A room matches on its own name or on anything said in it, and a room whose
  // thread matches comes along to say where that thread belongs.
  const hit = (c: Channel) =>
    !q || c.name.toLowerCase().includes(q) || c.messages.some((m) => m.text.toLowerCase().includes(q));
  const shown: Bot[] = bots.filter(
    (b) =>
      !q ||
      b.name.toLowerCase().includes(q) ||
      b.role.toLowerCase().includes(q) ||
      b.messages.some((m) => m.text.toLowerCase().includes(q)),
  );
  const rooms: Channel[] = channels
    .filter((c) => !c.from)
    .flatMap((room) => [room, ...channels.filter((t) => t.from?.channelId === room.id)])
    .filter((c) =>
      c.from ? hit(c) || hit(channels.find((r) => r.id === c.from?.channelId) ?? c) : hit(c) || channels.some((t) => t.from?.channelId === c.id && hit(t)),
    );

  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim(), role.trim());
      setName("");
      setRole("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <View style={s.heading}>
          <Text style={s.title}>botcage</Text>
          <Light connected={connected} />
        </View>
        <View style={s.actions}>
          {/* Settings used to sit here as well. It is in the bar across the
              bottom of the drawer now, with the name it belongs to — two
              controls opening one screen is one of them pretending to do
              something else. */}
          <Pressable onPress={() => setAdding((on) => !on)} hitSlop={12}>
            <Text style={s.plus}>{adding ? "×" : "+"}</Text>
          </Pressable>
        </View>
      </View>

      {adding ? (
        <View style={s.form}>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="Name"
            placeholderTextColor={T.text3}
            autoFocus
          />
          <TextInput
            style={s.input}
            value={role}
            onChangeText={setRole}
            // The short version here; the full job description is a field of
            // its own in the bot's settings, on both screens.
            placeholder="Role, e.g. ships and reviews code"
            placeholderTextColor={T.text3}
            onSubmitEditing={create}
          />
          <Pressable style={[s.add, !name.trim() && s.addOff]} onPress={create} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.addText}>Create bot</Text>}
          </Pressable>
        </View>
      ) : null}

      <View style={s.findWrap}>
        <TextInput
          style={s.find}
          value={find}
          onChangeText={setFind}
          placeholder="Search"
          placeholderTextColor={T.text3}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
      </View>

      <ScrollView
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.text3} />
        }
      >
        {bots.length === 0 && !loading ? (
          <Text style={s.empty}>No bots yet. Tap + to make one.</Text>
        ) : null}

        {/* Rooms first, then the people in them — the order every app with
            both has settled on, and for the same reason. A thread sits under
            the room it came out of. */}
        {rooms.length ? <Text style={s.group}>CHANNELS</Text> : null}
        {rooms.map((ch, n) => {
          const news = unreadIn(ch.messages, ch.seenAt, called);
          const inside = ch.members
            .map((id) => bots.find((b) => b.id === id))
            .filter((b): b is Bot => Boolean(b));
          const thread = !!ch.from;
          // The last thread under a room turns the branch into an elbow, so the
          // line stops at the thing it points to rather than running on past
          // it into nothing.
          const last = thread && !rooms[n + 1]?.from;
          return (
            <Pressable
              key={ch.id}
              style={[s.row, thread && s.threadRow]}
              onPress={() => onOpenChannel(ch)}
            >
              {thread ? (
                <>
                  <View style={[s.branch, last && s.branchLast]} />
                  <View style={s.elbow} />
                </>
              ) : (
                <Text style={s.hash}>#</Text>
              )}
              <View style={s.rowBody}>
                <Text
                  style={[thread ? s.threadName : s.name, news.unread ? s.unreadName : null]}
                  numberOfLines={1}
                >
                  {ch.name}
                </Text>
                {/* Only when something is happening. Who is in a room is on
                    the room's own header, and repeating it under every line is
                    the same two names down the whole screen — a thread's would
                    be the same names again. */}
                {ch.busy ? (
                  <Text style={s.preview} numberOfLines={1}>
                    Talking…
                  </Text>
                ) : !thread && !inside.length ? (
                  <Text style={s.preview} numberOfLines={1}>
                    Nobody in it yet
                  </Text>
                ) : null}
              </View>
              <Badge unread={news.unread} mentions={news.mentions} />
            </Pressable>
          );
        })}

        {rooms.length && shown.length ? (
          <Text style={s.group}>BOTS</Text>
        ) : null}

        {shown.map((bot) => {
          const last = bot.messages[bot.messages.length - 1];
          return (
            <Pressable key={bot.id} style={s.row} onPress={() => onOpen(bot)}>
              <Face bot={bot} />
              <View style={s.rowBody}>
                <Text style={s.name} numberOfLines={1}>
                  {bot.name}
                </Text>
                <Text style={s.preview} numberOfLines={1}>
                  {bot.busy ? "Working…" : last ? last.text.slice(0, 90) : bot.role || "No messages yet"}
                </Text>
              </View>
              {bot.busy ? (
                <View style={s.dot} />
              ) : (
                <Badge {...unreadIn(bot.messages, bot.seenAt, called)} />
              )}
            </Pressable>
          );
        })}

      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  /* A step up from the rail beside it, which is what tells the two apart —
     Discord's own arrangement, and the only one that reads at a glance on a
     screen this narrow. The fields on it stay their own colour, so a search box
     on this ground still looks like something you can type in. */
  fill: { flex: 1, backgroundColor: T.panel },

  // A count when a bot addressed you by name, a dot when a room merely
  // carried on — two marks because they mean two different things.
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: T.red,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.text2 },

  group: {
    marginTop: 18,
    marginBottom: 4,
    marginLeft: 4,
    color: T.text3,
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  findWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  find: {
    height: 36,
    paddingHorizontal: 12,
    backgroundColor: T.field,
    borderRadius: 10,
    color: T.text,
    fontSize: 15,
  },
  hash: { width: 34, textAlign: "center", color: T.text2, fontSize: 21 },

  /* A thread carries no icon of its own: the branch says what it is, and a
     glyph on every line only competes with the room's hash above it. */
  threadRow: { paddingTop: 7, paddingBottom: 7, paddingLeft: 52 },
  threadName: { color: T.text2, fontSize: 14.5 },
  branch: { position: "absolute", left: 26, top: 0, bottom: 0, width: 2, backgroundColor: T.line },
  branchLast: { bottom: "50%", borderBottomLeftRadius: 4 },
  elbow: { position: "absolute", left: 26, top: "50%", width: 12, height: 2, backgroundColor: T.line },
  unreadName: { color: T.text, fontWeight: "600" },

  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  heading: { flexDirection: "row", gap: 9, alignItems: "center" },
  title: { color: T.text, fontSize: 26, fontWeight: "700" },
  light: {
    width: 8,
    height: 8,
    marginTop: 3,
    borderRadius: 4,
    // A little glow, so it reads as a lamp rather than a bullet point.
    shadowOpacity: 0.9,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 3,
  },
  plus: { color: T.blue, fontSize: 30, fontWeight: "300" },
  actions: { flexDirection: "row", gap: 18, alignItems: "center" },
  form: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  input: {
    height: 44,
    paddingHorizontal: 12,
    color: T.text,
    fontSize: 15,
    backgroundColor: T.field,
    borderRadius: 11,
  },
  add: {
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    backgroundColor: T.blue,
    borderRadius: 11,
  },
  addOff: { opacity: 0.4 },
  addText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  /* The last row clears the bar floating over it, which the list scrolls
     underneath. */
  list: { paddingHorizontal: 14, paddingBottom: 114 },
  empty: { marginTop: 60, color: T.text3, fontSize: 14, textAlign: "center" },
  row: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
  },
  rowBody: { flex: 1, minWidth: 0 },
  name: { color: T.text, fontSize: 16, fontWeight: "600" },
  preview: { marginTop: 2, color: T.text2, fontSize: 13.5 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.blue },
});
