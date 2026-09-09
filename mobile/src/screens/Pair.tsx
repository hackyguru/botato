/**
 * Connecting this phone to a laptop, once.
 *
 * A laptop is named by a public key, and with its relay and direct routes that
 * comes to nearly two hundred characters — not something anyone should type or
 * paste. So the camera is the way in, and the laptop draws a square holding
 * both halves: which machine, and the code proving you are standing in front
 * of it.
 *
 * Typing it stays available, because a camera can be refused, broken, or
 * pointed at a laptop that is on the other end of a video call.
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
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { pair, probe, type Pairing } from "../api";
import { T } from "../theme";

/** What the laptop draws into the square. */
interface Scanned {
  peer: string;
  code: string;
}

export default function Pair({ onPaired }: { onPaired: (pairing: Pairing) => void }) {
  const [scanning, setScanning] = useState(true);
  const [permission, requestPermission] = useCameraPermissions();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [found, setFound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeField = useRef<TextInput>(null);
  /** A camera reports the same square many times a second. */
  const handled = useRef(false);

  useEffect(() => {
    if (scanning && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [scanning, permission, requestPermission]);

  async function connect(withAddress: string, withCode: string) {
    setBusy(true);
    setError(null);
    try {
      const name = Device.deviceName ?? (Platform.OS === "ios" ? "an iPhone" : "an Android phone");
      onPaired(await pair(withAddress.trim(), withCode, name));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      // Let the camera try again: a code that expired mid-scan deserves another
      // square, not a restart.
      handled.current = false;
    } finally {
      setBusy(false);
    }
  }

  function onScan(raw: string) {
    if (handled.current || busy) return;
    let payload: Scanned;
    try {
      payload = JSON.parse(raw) as Scanned;
    } catch {
      setError("that doesn't look like a botato code");
      return;
    }
    if (!payload?.peer || !payload?.code) {
      setError("that code is missing something — show a new one on the laptop");
      return;
    }
    handled.current = true;
    setAddress(payload.peer);
    setCode(payload.code);
    void connect(payload.peer, payload.code);
  }

  async function check(text: string) {
    setFound(null);
    setError(null);
    if (text.trim().length < 20) return;
    try {
      const info = await probe(text.trim());
      setFound(`botato ${info.version}`);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  if (scanning) {
    return (
      <View style={s.fill}>
        <View style={s.viewfinder}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => onScan(data)}
            />
          ) : null}
          <View style={s.reticle} />
        </View>

        <View style={s.below}>
          <Text style={s.title}>Scan the square on your laptop</Text>
          <Text style={s.blurb}>
            botato → account menu → Settings → Phone. Turn on phone access, then point the camera
            at what it shows.
          </Text>

          {busy ? <ActivityIndicator color={T.blue} style={s.spinner} /> : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
          {permission && !permission.granted ? (
            <Text style={s.error}>
              botato needs the camera to read the code. You can type it instead.
            </Text>
          ) : null}

          <Pressable onPress={() => setScanning(false)} style={s.secondary}>
            <Text style={s.secondaryText}>Enter it by hand</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.mark}>
          <View style={s.eye} />
          <View style={s.eye} />
        </View>
        <Text style={s.title}>Connect to your botato</Text>
        <Text style={s.blurb}>
          On the laptop: botato → account menu → Settings → Phone. Turn on phone access, and it
          shows this machine's name and a code. Spaces don't matter.
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
          placeholder="the name your laptop shows"
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
          onSubmitEditing={() => connect(address, code)}
        />

        {error ? <Text style={s.error}>{error}</Text> : null}

        <Pressable
          style={[s.button, (busy || !address || code.length < 6) && s.buttonOff]}
          disabled={busy || !address || code.length < 6}
          onPress={() => connect(address, code)}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>Connect</Text>}
        </Pressable>

        <Pressable
          onPress={() => {
            handled.current = false;
            setScanning(true);
          }}
          style={s.secondary}
        >
          <Text style={s.secondaryText}>Scan a code instead</Text>
        </Pressable>

        <Text style={s.fine}>
          Encrypted end to end and tied to this phone: a code lasts five minutes and works once, and
          the key it earns is refused from any other device. Nothing passes through a server of ours.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  // A viewfinder people can aim: big enough for a laptop screen at arm's
  // length, and square, because that is the shape it is looking for.
  viewfinder: {
    aspectRatio: 1,
    width: "100%",
    marginTop: 90,
    overflow: "hidden",
    backgroundColor: "#0a0a0c",
  },
  reticle: {
    alignSelf: "center",
    width: "62%",
    aspectRatio: 1,
    marginTop: "19%",
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.55)",
    borderRadius: 22,
  },
  below: { padding: 24, gap: 8 },
  spinner: { marginTop: 8 },
  secondary: { alignItems: "center", marginTop: 18, padding: 12 },
  secondaryText: { color: T.blue, fontSize: 15 },
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
  eye: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.onBlue },
  title: { marginTop: 18, color: T.text, fontSize: 22, fontWeight: "600", textAlign: "center" },
  blurb: {
    marginBottom: 14,
    color: T.text2,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
  },
  label: { marginTop: 10, color: T.text2, fontSize: 13 },
  input: {
    letterSpacing: 0,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: T.text,
    fontSize: 16,
    backgroundColor: T.field,
    borderRadius: 12,
  },
  code: { fontSize: 22, letterSpacing: 6, textAlign: "center", fontFamily: T.mono },
  found: { color: T.green, fontSize: 13 },
  error: { marginTop: 10, color: T.red, fontSize: 13, lineHeight: 19, textAlign: "center" },
  button: {
    alignItems: "center",
    justifyContent: "center",
    height: 50,
    marginTop: 22,
    backgroundColor: T.blue,
    borderRadius: 14,
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: T.onBlue, fontSize: 16, fontWeight: "600" },
  fine: { marginTop: 18, color: T.text3, fontSize: 12, lineHeight: 18, textAlign: "center" },
});
