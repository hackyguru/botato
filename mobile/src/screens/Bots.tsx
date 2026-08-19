/**
 * Every bot on the laptop, and whether it is doing something right now.
 *
 * The list is a live view rather than a snapshot: the same event stream that
 * drives a conversation also marks a bot busy here, so a routine that fires
 * while the phone is in a pocket is visible when it comes back out.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Bot } from "../types";
import { T } from "../theme";

/** The desktop's bot face, to its own measurements: a 34px shape with two
 *  rounded 4x6 eyes. A drop is a circle with one square-ish corner, which is
 *  what makes the three shapes tell bots apart at a glance. */
function Face({ bot, size = 34 }: { bot: Bot; size?: number }) {
  const round = size / 2;
  const shape =
    bot.shape === "circle"
      ? { borderRadius: round }
      : bot.shape === "drop"
        ? {
            borderTopLeftRadius: round,
            borderTopRightRadius: round,
            borderBottomRightRadius: round,
            borderBottomLeftRadius: size * 0.22,
          }
        : { borderRadius: size * 0.3 };

  const eye = { width: 4, height: 6, borderRadius: 2, backgroundColor: "rgba(0,0,0,0.72)" };
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          backgroundColor: bot.color,
          flexDirection: "row",
          gap: 4,
          alignItems: "center",
          justifyContent: "center",
        },
        shape,
      ]}
    >
      <View style={eye} />
      <View style={eye} />
    </View>
  );
}

export default function Bots({
  bots,
  connected,
  loading,
  onRefresh,
  onOpen,
  onCreate,
  onDisconnect,
}: {
  bots: Bot[];
  connected: boolean;
  loading: boolean;
  onRefresh: () => void;
  onOpen: (bot: Bot) => void;
  onCreate: (name: string, role: string) => Promise<void>;
  onDisconnect: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);

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
        <View>
          <Text style={s.title}>botcage</Text>
          <Text style={[s.status, { color: connected ? T.text2 : T.amber }]}>
            {connected ? "Connected to your laptop" : "Reconnecting…"}
          </Text>
        </View>
        <Pressable onPress={() => setAdding((on) => !on)} hitSlop={12}>
          <Text style={s.plus}>{adding ? "×" : "+"}</Text>
        </Pressable>
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
            placeholder="What it does"
            placeholderTextColor={T.text3}
            onSubmitEditing={create}
          />
          <Pressable style={[s.add, !name.trim() && s.addOff]} onPress={create} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.addText}>Create bot</Text>}
          </Pressable>
        </View>
      ) : null}

      <ScrollView
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={T.text3} />
        }
      >
        {bots.length === 0 && !loading ? (
          <Text style={s.empty}>No bots yet. Tap + to make one.</Text>
        ) : null}

        {bots.map((bot) => {
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
              {bot.busy ? <View style={s.dot} /> : null}
            </Pressable>
          );
        })}

        <Pressable style={s.disconnect} onPress={onDisconnect}>
          <Text style={s.disconnectText}>Disconnect this phone</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  title: { color: T.text, fontSize: 26, fontWeight: "700" },
  status: { marginTop: 2, fontSize: 12.5 },
  plus: { color: T.blue, fontSize: 30, fontWeight: "300" },
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
  list: { paddingHorizontal: 14, paddingBottom: 40 },
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
  disconnect: { alignItems: "center", marginTop: 30, padding: 12 },
  disconnectText: { color: T.text3, fontSize: 13 },
});
