/**
 * A bot's settings, its routines, and its desktop — the rest of what the
 * laptop can do for one bot.
 *
 * Everything here is an action name the desktop already implements, so this
 * screen is arrangement rather than logic. Plugins are the one thing it will
 * not finish: connecting one runs an OAuth flow in a browser on the laptop, and
 * pretending otherwise on a phone would only produce a dead end.
 */
import { useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Bot, EngineInfo, Routine } from "../types";
import Face from "../face";
import Sheet from "../sheet";
import { T } from "../theme";

/** Used only against a laptop running a build from before engines were a
 *  choice, which still answers every bot with Claude Code. */
const FALLBACK_MODELS = [
  { key: "opus", name: "Opus", hint: "" },
  { key: "sonnet", name: "Sonnet", hint: "" },
];
/** How often a bot looks by itself. The same rungs the desktop offers, minus
 *  the ones nobody reaches for on a phone. */
const BEATS: { every: number; says: string }[] = [
  { every: 0, says: "Never" },
  { every: 30, says: "30m" },
  { every: 60, says: "1h" },
  { every: 180, says: "3h" },
  { every: 480, says: "8h" },
];

const NETWORKS: Bot["network"][] = ["full", "no-lan", "offline"];
const NETWORK_LABEL: Record<Bot["network"], string> = {
  full: "Everything",
  "no-lan": "Internet only",
  offline: "Nothing",
};

export default function BotSettings({
  bot,
  engines,
  onBack,
  onUpdate,
  onDelete,
  manners,
  onRoutineSave,
  onRoutineDelete,
  onDesktop,
}: {
  bot: Bot;
  /** What the laptop says can answer for a bot. Empty from an older desktop. */
  engines: EngineInfo[];
  onBack: () => void;
  onUpdate: (patch: Record<string, unknown>) => Promise<void>;
  onDelete: () => void;
  /** What a bot can be told to write like, as the laptop lists them. */
  manners?: { key: string; name: string }[];
  onRoutineSave: (routine: Routine) => Promise<void>;
  onRoutineDelete: (id: string) => Promise<void>;
  onDesktop: (start: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(bot.name);
  const [role, setRole] = useState(bot.role);
  const [adding, setAdding] = useState(false);
  const [routineName, setRoutineName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [at, setAt] = useState("09:00");

  async function addRoutine() {
    if (!instruction.trim()) return;
    await onRoutineSave({
      id: "",
      name: routineName.trim() || "Routine",
      instruction: instruction.trim(),
      every: "day",
      at,
      active: true,
    });
    setRoutineName("");
    setInstruction("");
    setAdding(false);
  }

  function confirmDelete() {
    Alert.alert(`Delete ${bot.name}?`, "Its thread, workspace and desktop go too.", [
      { text: "Keep", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onDelete },
    ]);
  }

  return (
    <View style={s.fill}>
      <View style={s.head}>
        <Pressable onPress={onBack} hitSlop={14}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <Face bot={bot} size={26} />
        <Text style={s.title}>{bot.name}</Text>
        <View style={s.spacer} />
      </View>

      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.group}>Bot</Text>
        <View style={s.card}>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            onBlur={() => name.trim() && name !== bot.name && onUpdate({ name: name.trim() })}
            placeholder="Name"
            placeholderTextColor={T.text3}
          />
          <Text style={s.fieldLabel}>Role and job description</Text>
          <TextInput
            style={[s.input, s.prose]}
            value={role}
            onChangeText={setRole}
            onBlur={() => role !== bot.role && onUpdate({ role })}
            placeholder="What this bot is responsible for: the work it owns, how you want it approached, anything it should always or never do."
            placeholderTextColor={T.text3}
            multiline
            textAlignVertical="top"
          />

          {/* What it answers to. Visible until now only by typing "/" or by
              tapping its face, which is fine for using them and no use for
              finding out they exist — and this screen is where somebody looks
              to learn what a bot does. */}
          {bot.commands?.length ? (
            <>
              <Text style={s.fieldLabel}>Shortcuts</Text>
              <View style={s.cmds}>
                {bot.commands.map((one) => (
                  <View key={one.name} style={s.cmd}>
                    <Text style={s.cmdName}>/{one.name}</Text>
                    <Text style={s.cmdWhat} numberOfLines={1}>
                      {one.what}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={s.cmdNote}>
                Type &quot;/&quot; in a message to use one. It writes these itself.
              </Text>
            </>
          ) : null}
        </View>

        {engines.length ? (
          <>
            <Text style={s.group}>Answered by</Text>
            <View style={s.card}>
              <View style={s.segment}>
                {engines.map((info) => (
                  <Pressable
                    key={info.key}
                    // An engine the laptop hasn't got is shown, and dimmed,
                    // with the reason underneath: the fix is on the laptop, and
                    // whoever is holding the phone may not be near it.
                    disabled={!info.ready.usable}
                    style={[
                      s.choice,
                      bot.engine === info.key && s.choiceOn,
                      !info.ready.usable && s.choiceOut,
                    ]}
                    onPress={() =>
                      onUpdate({
                        engine: info.key,
                        // Sent together, because "opus" means nothing to Gemini:
                        // the model is kept only if the new engine has it.
                        model: info.models.some((m) => m.key === bot.model)
                          ? bot.model
                          : (info.models[0]?.key ?? bot.model),
                      })
                    }
                  >
                    <Text
                      style={[
                        s.choiceText,
                        bot.engine === info.key && s.choiceTextOn,
                        !info.ready.usable && s.choiceTextOut,
                      ]}
                    >
                      {info.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {engineNote(bot, engines) ? (
                <Text style={s.fine}>{engineNote(bot, engines)}</Text>
              ) : null}
            </View>
          </>
        ) : null}

        <Text style={s.group}>Model</Text>
        <View style={s.card}>
          <View style={s.segment}>
            {modelsFor(bot, engines).map((model) => (
              <Pressable
                key={model.key}
                style={[s.choice, bot.model === model.key && s.choiceOn]}
                onPress={() => onUpdate({ model: model.key })}
              >
                <Text style={[s.choiceText, bot.model === model.key && s.choiceTextOn]}>
                  {model.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {manners?.length ? (
          <>
            <Text style={s.group}>Manner</Text>
            <View style={s.card}>
              <View style={s.segmentWrap}>
                {/* "Its own" first: the default is picked from the bot's id the
                    way its face and voice are, and most bots should keep it. */}
                <Pressable
                  style={[s.choice, s.choiceFit, !bot.manner && s.choiceOn]}
                  onPress={() => onUpdate({ manner: "" })}
                >
                  <Text style={[s.choiceText, !bot.manner && s.choiceTextOn]}>Its own</Text>
                </Pressable>
                {manners.map((manner) => (
                  <Pressable
                    key={manner.key}
                    style={[s.choice, s.choiceFit, bot.manner === manner.key && s.choiceOn]}
                    onPress={() => onUpdate({ manner: manner.key })}
                  >
                    <Text style={[s.choiceText, bot.manner === manner.key && s.choiceTextOn]}>
                      {manner.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={s.note}>How it writes, not what it says.</Text>
            </View>
          </>
        ) : null}

        {bot.hours || bot.spend ? (
          <>
            <Text style={s.group}>The job</Text>
            <View style={s.card}>
              {/* Both read-only. The hours are set on the laptop, where the
                  seven day toggles have room; the tab is a fact and is nobody's
                  to edit. */}
              <View style={s.row}>
                <View style={s.rowBody}>
                  <Text style={s.rowLabel}>Working hours</Text>
                  <Text style={s.rowHint}>
                    {bot.hours
                      ? `${bot.hours.from}–${bot.hours.to} · routines only`
                      : "Any time"}
                  </Text>
                </View>
              </View>
              {bot.spend?.turns ? (
                <View style={s.row}>
                  <View style={s.rowBody}>
                    <Text style={s.rowLabel}>This week</Text>
                    <Text style={s.rowHint}>
                      {bot.spend.weekTurns} turn{bot.spend.weekTurns === 1 ? "" : "s"}
                      {bot.spend.weekUsd >= 0.005 ? ` · $${bot.spend.weekUsd.toFixed(2)}` : ""}
                      {"  ·  all time "}
                      {bot.spend.turns} turn{bot.spend.turns === 1 ? "" : "s"}
                      {bot.spend.usd >= 0.005 ? ` · $${bot.spend.usd.toFixed(2)}` : ""}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          </>
        ) : null}

        <Text style={s.group}>Keeping up</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowBody}>
              <Text style={s.rowLabel}>Keeps up</Text>
              <Text style={s.rowHint}>Reads its own channels while nobody is asking.</Text>
            </View>
            <Switch
              value={Boolean(bot.aware)}
              onValueChange={(on) => onUpdate({ aware: on })}
              trackColor={{ true: T.blue, false: "#39393d" }}
            />
          </View>

          {/* Only once it may look. Choosing how often something happens that
              cannot happen is a control that does nothing. */}
          {bot.aware ? (
            <>
              <View style={s.row}>
                <View style={s.rowBody}>
                  <Text style={s.rowLabel}>Checks in</Text>
                  <Text style={s.rowHint}>Costs nothing when nothing has been said.</Text>
                </View>
              </View>
              <View style={s.segment}>
                {BEATS.map((beat) => (
                  <Pressable
                    key={beat.every}
                    onPress={() => onUpdate({ heartbeat: beat.every || undefined })}
                    style={[s.choice, (bot.heartbeat ?? 0) === beat.every && s.choiceOn]}
                  >
                    <Text
                      style={[
                        s.choiceText,
                        (bot.heartbeat ?? 0) === beat.every && s.choiceTextOn,
                      ]}
                    >
                      {beat.says}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
        </View>

        <Text style={s.group}>Computer</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowBody}>
              <Text style={s.rowLabel}>Own computer</Text>
              <Text style={s.rowHint}>A private Linux desktop it can switch on.</Text>
            </View>
            <Switch
              value={bot.computer}
              onValueChange={(on) => onUpdate({ computer: on })}
              trackColor={{ true: T.blue, false: "#39393d" }}
            />
          </View>

          {bot.computer ? (
            <>
              <View style={s.row}>
                <View style={s.rowBody}>
                  <Text style={s.rowLabel}>What it can reach</Text>
                </View>
              </View>
              <View style={s.segment}>
                {NETWORKS.map((network) => (
                  <Pressable
                    key={network}
                    style={[s.choice, bot.network === network && s.choiceOn]}
                    onPress={() => onUpdate({ network })}
                  >
                    <Text style={[s.choiceText, bot.network === network && s.choiceTextOn]}>
                      {NETWORK_LABEL[network]}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={s.pair}>
                <Pressable style={s.chip} onPress={() => onDesktop(true)}>
                  <Text style={s.chipText}>Start desktop</Text>
                </Pressable>
                <Pressable style={s.chip} onPress={() => onDesktop(false)}>
                  <Text style={s.chipText}>Stop desktop</Text>
                </Pressable>
              </View>
              <Text style={s.fine}>
                Watching the screen isn't in the phone app yet — start it here, watch it on the
                laptop.
              </Text>
            </>
          ) : null}
        </View>

        <View style={s.groupRow}>
          <Text style={s.group}>Routines</Text>
          <Pressable onPress={() => setAdding(true)} hitSlop={12}>
            <Text style={s.addSmall}>Add</Text>
          </Pressable>
        </View>
        <View style={s.card}>
          {(bot.routines ?? []).length === 0 ? (
            <Text style={s.none}>Nothing scheduled.</Text>
          ) : null}

          {(bot.routines ?? []).map((routine) => (
            <View key={routine.id} style={s.row}>
              <View style={s.rowBody}>
                <Text style={s.rowLabel}>{routine.name}</Text>
                <Text style={s.rowHint} numberOfLines={1}>
                  {describeRoutine(routine)}
                </Text>
              </View>
              <Switch
                value={routine.active}
                onValueChange={(active) => onRoutineSave({ ...routine, active })}
                trackColor={{ true: T.blue, false: "#39393d" }}
              />
              <Pressable onPress={() => onRoutineDelete(routine.id)} hitSlop={10}>
                <Text style={s.remove}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <Text style={s.group}>Plugins</Text>
        <View style={s.card}>
          <Text style={s.none}>
            {bot.plugins.length ? bot.plugins.join(", ") : "None connected."}
          </Text>
          <Text style={s.fine}>
            Connecting one signs in through a browser, so it has to be done on the laptop.
          </Text>
        </View>

        <Pressable style={s.delete} onPress={confirmDelete}>
          <Text style={s.deleteText}>Delete this bot</Text>
        </Pressable>
      </ScrollView>

      {/* Over the settings rather than unfolding inside the Routines card,
          which pushed the routines you were reading down the screen. */}
      <Sheet open={adding} title="New routine" onClose={() => setAdding(false)}>
        <TextInput
          style={s.input}
          value={routineName}
          onChangeText={setRoutineName}
          placeholder="Name"
          placeholderTextColor={T.text3}
          autoFocus
        />
        <TextInput
          style={[s.input, s.tall]}
          value={instruction}
          onChangeText={setInstruction}
          placeholder="What should it do?"
          placeholderTextColor={T.text3}
          multiline
        />
        <TextInput
          style={s.input}
          value={at}
          onChangeText={setAt}
          placeholder="09:00"
          placeholderTextColor={T.text3}
        />
        <Pressable style={s.save} onPress={addRoutine}>
          <Text style={s.saveText}>Add — every day at {at}</Text>
        </Pressable>
      </Sheet>
    </View>
  );
}

const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The same sentence the laptop writes under a routine. Schedules are made on
 *  the laptop's calendar; the phone shows and pauses them. */
function describeRoutine(routine: Routine): string {
  switch (routine.every) {
    case "minutes":
      return `Every ${routine.minutes ?? 30} min`;
    case "hour":
      return `Hourly at :${routine.at.slice(-2)}`;
    case "week":
      return `${DAY_FULL[routine.day ?? 1]}s at ${routine.at}`;
    case "once":
      return routine.date ? `Once on ${routine.date} at ${routine.at}` : `Once at ${routine.at}`;
    case "weekday":
      return `Weekdays at ${routine.at}`;
    default:
      return `Daily at ${routine.at}`;
  }
}

/** The models this bot's engine can be asked for. */
function modelsFor(bot: Bot, engines: EngineInfo[]) {
  const chosen = engines.find((info) => info.key === bot.engine);
  return chosen?.models.length ? chosen.models : FALLBACK_MODELS;
}

/** Who keeps the conversation, and anything the laptop is missing. Both are
 *  things a person can act on; the rest of an engine's nature is not. */
function engineNote(bot: Bot, engines: EngineInfo[]): string {
  const chosen = engines.find((info) => info.key === bot.engine);
  const lines: string[] = [];
  if (chosen && !chosen.ownsTranscript) {
    lines.push(`${chosen.name} can't resume a conversation, so botato keeps this thread on the laptop and sends it each turn.`);
  }
  for (const info of engines) {
    if (!info.ready.usable) lines.push(`${info.name}: ${info.ready.missing ?? "not available"}`);
  }
  return lines.join("\n");
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
  },
  back: { color: T.blue, fontSize: 32, lineHeight: 34, fontWeight: "300" },
  title: { flex: 1, color: T.text, fontSize: 17, fontWeight: "600", textAlign: "center" },
  spacer: { width: 22 },
  body: { padding: 14, paddingBottom: 50 },
  group: { marginTop: 18, marginBottom: 7, marginLeft: 6, color: T.text2, fontSize: 12.5 },
  groupRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  addSmall: { marginBottom: 7, marginRight: 6, color: T.blue, fontSize: 13.5 },
  card: { gap: 10, padding: 14, backgroundColor: T.panel, borderRadius: 14 },
  input: {
    letterSpacing: 0,
    height: 44,
    paddingHorizontal: 12,
    color: T.text,
    fontSize: 15,
    backgroundColor: T.field,
    borderRadius: 11,
  },
  tall: { height: 88, paddingTop: 12, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  rowBody: { flex: 1, minWidth: 0 },
  rowLabel: { color: T.text, fontSize: 15 },
  /* A line under a set of choices, saying what they are. */
  note: {
    paddingHorizontal: 12,
    paddingBottom: 11,
    color: T.text3,
    fontSize: 12.5,
    lineHeight: 17,
  },
  rowHint: { marginTop: 2, color: T.text2, fontSize: 12.5 },
  segment: { flexDirection: "row", gap: 6 },
  /* Seven of them do not fit across a phone, and squeezing them turns
     "Precise" into two lines of four letters. They wrap and size to their
     words instead — a row and a bit, which is what seven short labels want. */
  segmentWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  choiceFit: { flex: 0, paddingHorizontal: 12 },
  choice: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 9,
    backgroundColor: T.field,
    borderRadius: 10,
  },
  choiceOn: { backgroundColor: T.blue },
  // Present, and plainly not available: the reason is under the segment.
  choiceOut: { opacity: 0.45 },
  choiceTextOut: { textDecorationLine: "line-through" },
  choiceText: { color: T.text2, fontSize: 13.5 },
  choiceTextOn: { color: "#fff", fontWeight: "600" },
  pair: { flexDirection: "row", gap: 8 },
  chip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    backgroundColor: T.field,
    borderRadius: 10,
  },
  chipText: { color: T.text, fontSize: 13.5 },
  fine: { color: T.text3, fontSize: 12, lineHeight: 18 },
  cmds: {
    gap: 3,
    marginTop: 6,
    paddingVertical: 9,
    paddingHorizontal: 12,
    backgroundColor: T.field,
    borderRadius: 10,
  },
  cmd: { flexDirection: "row", alignItems: "baseline", gap: 9 },
  cmdName: { color: T.text, fontSize: 13, fontFamily: T.mono },
  cmdWhat: { flexShrink: 1, color: T.text3, fontSize: 13 },
  cmdNote: { marginTop: 6, color: T.text3, fontSize: 12 },
  fieldLabel: { paddingHorizontal: 14, paddingTop: 10, color: T.text2, fontSize: 12.5 },
  // Room to describe a job rather than name one.
  prose: { minHeight: 108, paddingTop: 10, paddingBottom: 10, lineHeight: 20 },
  none: { color: T.text2, fontSize: 13.5 },
  save: {
    alignItems: "center",
    paddingVertical: 11,
    backgroundColor: T.blue,
    borderRadius: 11,
  },
  saveText: { color: "#fff", fontSize: 14.5, fontWeight: "600" },
  remove: { color: T.red, fontSize: 13 },
  delete: { alignItems: "center", marginTop: 28, padding: 14 },
  deleteText: { color: T.red, fontSize: 15 },
});
