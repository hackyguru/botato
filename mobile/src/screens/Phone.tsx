/**
 * This phone's own settings.
 *
 * Everything here is about the link between this device and one laptop, which
 * is the only thing the phone owns: the bots, their names, their faces and
 * their schedules all live on the machine at the other end. So it is short by
 * design, and disconnecting — the one destructive thing a phone can do — lives
 * here rather than under the list of bots, where it sat one careless thumb
 * away from the thing you actually wanted to tap.
 */
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Pairing } from "../api";
import { T } from "../theme";

export default function Phone({
  pairing,
  connected,
  onBack,
  onDisconnect,
}: {
  pairing: Pairing | null;
  connected: boolean;
  onBack: () => void;
  onDisconnect: () => void;
}) {
  // The laptop is named by a public key. Nobody reads sixty-four characters of
  // hex, but the first and last few are enough to tell one machine from
  // another, which is the only question this line has to answer.
  const machine = pairing?.peer ?? "";
  const shortened = machine.length > 20 ? `${machine.slice(0, 8)}…${machine.slice(-6)}` : machine;

  function confirm() {
    Alert.alert(
      "Disconnect this phone?",
      "The laptop forgets this device, and you would pair again with a new code. Nothing on the laptop is deleted.",
      [
        { text: "Stay connected", style: "cancel" },
        { text: "Disconnect", style: "destructive", onPress: onDisconnect },
      ],
    );
  }

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <Pressable onPress={onBack} hitSlop={14}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Text style={s.title}>This phone</Text>
        <View style={s.spacer} />
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.group}>Connection</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowBody}>
              <Text style={s.rowLabel}>{connected ? "Connected" : "Reconnecting"}</Text>
              <Text style={s.rowHint}>
                {connected
                  ? "Encrypted, straight to your laptop. No account, and nothing of ours in between."
                  : "Looking for the laptop. It may be asleep, or phone access may be switched off on it."}
              </Text>
            </View>
            <View style={[s.light, connected ? s.lightOn : s.lightOff]} />
          </View>

          <View style={s.row}>
            <View style={s.rowBody}>
              <Text style={s.rowLabel}>Your laptop</Text>
              <Text style={s.key}>{shortened || "not paired"}</Text>
            </View>
          </View>
        </View>

        <Text style={s.group}>Pairing</Text>
        <View style={s.card}>
          <Text style={s.fine}>
            This phone holds a key of its own, bound to this device — a copy of it is refused from
            anywhere else. Disconnecting throws it away at both ends.
          </Text>
          <Pressable style={s.danger} onPress={confirm}>
            <Text style={s.dangerText}>Disconnect this phone</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
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
  title: { flex: 1, color: T.text, fontSize: 17, fontWeight: "600" },
  spacer: { width: 20 },
  body: { padding: 16, paddingBottom: 40 },
  group: {
    marginBottom: 8,
    marginLeft: 4,
    color: T.text3,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  card: {
    marginBottom: 22,
    padding: 14,
    backgroundColor: T.field,
    borderRadius: 14,
  },
  row: { flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 6 },
  rowBody: { flex: 1 },
  rowLabel: { color: T.text, fontSize: 15 },
  rowHint: { marginTop: 3, color: T.text2, fontSize: 12.5, lineHeight: 18 },
  key: { marginTop: 4, color: T.text2, fontSize: 12.5, fontFamily: T.mono },
  light: { width: 9, height: 9, borderRadius: 5 },
  lightOn: { backgroundColor: T.green },
  lightOff: { backgroundColor: T.text3 },
  fine: { color: T.text2, fontSize: 12.5, lineHeight: 19 },
  danger: {
    alignItems: "center",
    marginTop: 14,
    padding: 12,
    backgroundColor: "rgba(255,69,58,0.12)",
    borderRadius: 11,
  },
  dangerText: { color: T.red, fontSize: 15, fontWeight: "500" },
});
