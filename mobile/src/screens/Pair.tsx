/**
 * Connecting this phone to a laptop, once.
 *
 * Two things are needed and neither is an account: where the laptop is, and the
 * code it is showing. The address is the awkward half — it is a tailnet address
 * most people have never typed — so the screen checks it as soon as it looks
 * complete and says what answered, rather than waiting for the code to be typed
 * before reporting that the address was wrong.
 */
import { useRef, useState } from "react";
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
import * as Device from "expo-device";
import { pair, probe, type Pairing } from "../api";
import { T } from "../theme";

export default function Pair({ onPaired }: { onPaired: (pairing: Pairing) => void }) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [found, setFound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeField = useRef<TextInput>(null);

  async function check(text: string) {
    setFound(null);
    setError(null);
    const clean = text.trim();
    if (clean.length < 20) return;
    try {
      const info = await probe(clean);
      setFound(`botcage ${info.version}`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const name = Device.deviceName ?? (Platform.OS === "ios" ? "an iPhone" : "an Android phone");
      onPaired(await pair(address.trim(), code, name));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.fill}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.mark}>
          <View style={s.eye} />
          <View style={s.eye} />
        </View>
        <Text style={s.title}>Connect to your botcage</Text>
        <Text style={s.blurb}>
          On the laptop: botcage → account menu → Settings → Phone. Turn on phone access, and it
          shows what to paste here plus a code.
        </Text>

        <Text style={s.label}>Your laptop</Text>
        <TextInput
          style={s.input}
          autoFocus
          value={address}
          onChangeText={(text) => {
            setAddress(text);
            setFound(null);
          }}
          onBlur={() => check(address)}
          onSubmitEditing={() => {
            void check(address);
            codeField.current?.focus();
          }}
          placeholder="paste what the laptop shows"
          placeholderTextColor={T.text3}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          returnKeyType="next"
        />
        {found ? <Text style={s.found}>Found {found}</Text> : null}

        <Text style={s.label}>Pairing code</Text>
        <TextInput
          ref={codeField}
          style={[s.input, s.code]}
          value={code}
          onChangeText={(text) => setCode(text.toUpperCase())}
          placeholder="A1B2C3"
          placeholderTextColor={T.text3}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={connect}
        />

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable
          style={[s.button, (busy || !address || code.length < 6) && s.buttonOff]}
          disabled={busy || !address || code.length < 6}
          onPress={connect}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Connect</Text>}
        </Pressable>

        <Text style={s.fine}>
          Encrypted end to end and tied to this phone: a code lasts five minutes and works once,
          and the key it earns is refused from any other device. Nothing passes through a server
          of ours.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  body: { padding: 24, paddingTop: 72, gap: 8 },
  mark: {
    flexDirection: "row",
    gap: 8,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: T.blue,
  },
  eye: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#04203f" },
  title: {
    marginTop: 18,
    color: T.text,
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
  },
  blurb: {
    marginBottom: 14,
    color: T.text2,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  label: { marginTop: 10, color: T.text2, fontSize: 13 },
  input: {
    height: 48,
    paddingHorizontal: 14,
    color: T.text,
    fontSize: 16,
    backgroundColor: T.field,
    borderRadius: 12,
  },
  code: { fontSize: 22, letterSpacing: 6, textAlign: "center", fontFamily: T.mono },
  found: { color: T.green, fontSize: 13 },
  error: { marginTop: 10, color: T.red, fontSize: 13, lineHeight: 19 },
  button: {
    alignItems: "center",
    justifyContent: "center",
    height: 50,
    marginTop: 22,
    backgroundColor: T.blue,
    borderRadius: 14,
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  fine: { marginTop: 18, color: T.text3, fontSize: 12, lineHeight: 18, textAlign: "center" },
});
