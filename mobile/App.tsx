/**
 * botcage on a phone.
 *
 * The laptop holds the state; this app holds a copy and keeps it honest two
 * ways. Snapshots come from the desktop on demand — when a screen opens, when
 * the app comes back from the background, on a pull. Between snapshots the
 * event stream applies deltas locally, so a reply reads as it arrives instead
 * of after a poll.
 *
 * Navigation is a screen name and a bot id rather than a router: there are four
 * screens and one of them is a chat, and a router would be more moving parts
 * than the whole app.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, StatusBar, StyleSheet, Text, View } from "react-native";
import {
  call,
  clearPairing,
  listen,
  loadPairing,
  NotPaired,
  type BotEvent,
  type Pairing,
} from "./src/api";
import type { Bot, Routine, Snapshot } from "./src/types";
import Pair from "./src/screens/Pair";
import Bots from "./src/screens/Bots";
import Chat from "./src/screens/Chat";
import BotSettings from "./src/screens/BotSettings";
import { T } from "./src/theme";

type Screen = "bots" | "chat" | "settings";

export default function App() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [screen, setScreen] = useState<Screen>("bots");
  const [botId, setBotId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  // Read inside the event handler, which is registered once and would otherwise
  // close over the first render's pairing forever.
  const current = useRef<Pairing | null>(null);
  current.current = pairing;

  useEffect(() => {
    void loadPairing().then((saved) => {
      setPairing(saved);
      setReady(true);
    });
  }, []);

  const refresh = useCallback(async () => {
    const p = current.current;
    if (!p) return;
    setLoading(true);
    try {
      setSnapshot(await call<Snapshot>(p, "state"));
      setProblem(null);
    } catch (err) {
      if (err instanceof NotPaired) {
        await clearPairing();
        setPairing(null);
      } else {
        setProblem(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  /** Apply a delta from the laptop to the copy held here. The desktop is still
   *  the authority — this only spares us a round trip per token. */
  const apply = useCallback((event: BotEvent) => {
    setNotes((was) => ({
      ...was,
      [event.botId]:
        event.kind === "thinking"
          ? "Thinking…"
          : event.kind === "tool"
            ? event.text ?? "Using a tool…"
            : event.kind === "rate-limit"
              ? "Waiting on usage limits…"
              : "",
    }));

    setSnapshot((was) => {
      if (!was) return was;
      const bots = was.bots.map((bot) => {
        if (bot.id !== event.botId) return bot;
        const messages = [...bot.messages];
        const last = messages[messages.length - 1];

        if (event.kind === "delta") {
          // The desktop appends an empty bot message when a turn starts; if the
          // phone missed that snapshot, start one here so text has somewhere to
          // land rather than being dropped.
          if (!last || last.from !== "bot") {
            messages.push({ id: `live-${Date.now()}`, from: "bot", text: event.text ?? "", at: Date.now() });
          } else {
            messages[messages.length - 1] = { ...last, text: last.text + (event.text ?? "") };
          }
          return { ...bot, busy: true, messages };
        }

        if (event.kind === "error" || event.kind === "cancelled") {
          const text = event.kind === "cancelled" ? "Stopped." : event.text ?? "Something went wrong.";
          if (last && last.from === "bot" && !last.text) {
            messages[messages.length - 1] = { ...last, text };
          } else {
            messages.push({ id: `live-${Date.now()}`, from: "bot", text, at: Date.now() });
          }
          return { ...bot, busy: false, messages };
        }

        return { ...bot, busy: event.kind !== "done", messages };
      });
      return { ...was, bots };
    });

    // A finished turn is worth one authoritative read: the desktop may have
    // rewritten the message with links, costs and anything the deltas lacked.
    if (event.kind === "done") void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pairing) return;
    void refresh();
    const stop = listen(pairing, apply, setConnected);
    // A phone sleeps constantly, and a stream that died in a pocket must not
    // leave the app showing a stale conversation.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [pairing, apply, refresh]);

  // Android's back button is a real button, and an app that ignores it feels
  // broken there in a way it never does on iOS.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (screen === "settings") {
        setScreen("chat");
        return true;
      }
      if (screen === "chat") {
        setScreen("bots");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen]);

  const act = useCallback(
    async (kind: string, payload: Record<string, unknown> = {}) => {
      const p = current.current;
      if (!p) return;
      try {
        await call(p, kind, payload);
        await refresh();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  if (!ready) {
    return (
      <View style={s.middle}>
        <ActivityIndicator color={T.text3} />
      </View>
    );
  }

  if (!pairing) {
    return (
      <>
        <StatusBar barStyle="light-content" />
        <Pair onPaired={setPairing} />
      </>
    );
  }

  const bots = snapshot?.bots ?? [];
  const bot: Bot | undefined = bots.find((b) => b.id === botId);

  return (
    <>
      <StatusBar barStyle="light-content" />
      {problem ? (
        <View style={s.problem}>
          <Text style={s.problemText}>{problem}</Text>
        </View>
      ) : null}

      {screen === "bots" || !bot ? (
        <Bots
          bots={bots}
          connected={connected}
          loading={loading}
          onRefresh={refresh}
          onOpen={(chosen) => {
            setBotId(chosen.id);
            setScreen("chat");
            void act("open", { botId: chosen.id });
          }}
          onCreate={async (name, role) => {
            await act("bot/create", { name, role });
          }}
          onDisconnect={async () => {
            await clearPairing();
            setPairing(null);
            setSnapshot(null);
          }}
        />
      ) : screen === "chat" ? (
        <Chat
          bot={bot}
          note={notes[bot.id] ?? ""}
          onBack={() => setScreen("bots")}
          onSettings={() => setScreen("settings")}
          onSend={async (text) => {
            // Show it immediately; the laptop's own copy arrives with the next
            // snapshot and replaces this one.
            setSnapshot((was) =>
              was
                ? {
                    ...was,
                    bots: was.bots.map((b) =>
                      b.id === bot.id
                        ? {
                            ...b,
                            busy: true,
                            messages: [
                              ...b.messages,
                              { id: `local-${Date.now()}`, from: "me" as const, text, at: Date.now() },
                            ],
                          }
                        : b,
                    ),
                  }
                : was,
            );
            const p = current.current;
            if (!p) return;
            try {
              await call(p, "send", { botId: bot.id, text });
            } catch (err) {
              setProblem(err instanceof Error ? err.message : String(err));
              void refresh();
            }
          }}
          onCancel={() => void act("cancel", { botId: bot.id })}
        />
      ) : (
        <BotSettings
          bot={bot}
          onBack={() => setScreen("chat")}
          onUpdate={(patch) => act("bot/update", { botId: bot.id, ...patch })}
          onDelete={async () => {
            setScreen("bots");
            await act("bot/delete", { botId: bot.id });
          }}
          onRoutineSave={(routine: Routine) => act("routine/save", { botId: bot.id, routine })}
          onRoutineDelete={(id: string) => act("routine/delete", { botId: bot.id, routineId: id })}
          onDesktop={(start: boolean) =>
            act(start ? "desktop/start" : "desktop/stop", { botId: bot.id })
          }
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  middle: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: T.bg },
  problem: {
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: "#3a1d1d",
  },
  problemText: { color: "#ffb4ae", fontSize: 12.5 },
});
