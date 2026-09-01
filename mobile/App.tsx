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
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  Linking,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Device from "expo-device";
import {
  call,
  clearPairing,
  listen,
  loadPairing,
  NotPaired,
  pair,
  type BotEvent,
  type Pairing,
} from "./src/api";
import type { Bot, Channel, Routine, Snapshot } from "./src/types";
import Pair from "./src/screens/Pair";
import Bots from "./src/screens/Bots";
import Room from "./src/screens/Room";
import Chat from "./src/screens/Chat";
import BotSettings from "./src/screens/BotSettings";
import Calendar from "./src/screens/Calendar";
import Drawer from "./src/drawer";
import type { Mood } from "./src/face";
import Foot from "./src/foot";
import { pushWhere, showThemWhileOpen } from "./src/push";
import Rail from "./src/rail";
import Phone from "./src/screens/Phone";
import { T } from "./src/theme";

// "settings" is one bot's; "phone" is this device's own — the link to the
// laptop, and the one destructive thing a phone can do.
/** What is on top of the conversation, if anything.
 *
 *  The list used to be one of these — you went to it and came back. It is a
 *  drawer now, which is a different thing: the conversation stays, and the list
 *  slides over it. Settings and pairing genuinely do replace the screen. */
type Screen = "chat" | "room" | "settings" | "phone" | "calendar";

export default function App() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [ready, setReady] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [screen, setScreen] = useState<Screen>("chat");
  // Open when there is nothing to look at yet, which is also how the app opens.
  const [aside, setAside] = useState(true);
  const [botId, setBotId] = useState<string | null>(null);
  /* Whose calendar is open. Null is everyone's, from the bar at the bottom of
     the drawer; the two conversation headers open their own. */
  const [calFor, setCalFor] = useState<{ kind: "bot" | "room"; id: string } | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
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

  // Pairing by link, for the times there is no camera pointed at a laptop: a
  // simulator, a phone the square will not focus on, a laptop being described
  // over a call. The link carries what the square carries and nothing more —
  // the machine's public key and a code that lasts five minutes, works once,
  // and is burned after five wrong guesses. Handing it to somebody else buys
  // them the same five minutes, which is the bargain the square already makes.
  //
  //   botcage://pair?peer=<the laptop>&code=ABC123
  useEffect(() => {
    const take = async (url: string | null) => {
      if (!url) return;
      const at = url.indexOf("?");
      if (!url.includes("pair") || at < 0) return;
      const asked = new URLSearchParams(url.slice(at + 1));
      const peer = asked.get("peer");
      const code = asked.get("code");
      if (!peer || !code) return;
      try {
        const name = Device.deviceName ?? (Platform.OS === "ios" ? "an iPhone" : "an Android phone");
        setPairing(await pair(peer, code, name));
        setProblem(null);
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      }
    };

    void Linking.getInitialURL().then(take);
    const open = Linking.addEventListener("url", (event) => void take(event.url));
    return () => open.remove();
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
    let live = true;
    let stop = listen(pairing, apply, setConnected, () => void refresh());
    let retry: ReturnType<typeof setTimeout> | null = null;
    /** How many attempts have failed in a row, for the backoff. */
    let waited = 0;
    void refresh();

    /** Throw the stream away and open a new one. Reconnecting is cheaper than
     *  working out whether the old one is still good — the laptop is dialled
     *  per use anyway. */
    const reopen = () => {
      if (!live) return;
      stop();
      stop = listen(pairing, apply, (up) => {
        setConnected(up);
        // The banner reports the last failure and nothing else clears it, so a
        // laptop that came back leaves its own error on screen. Reaching it
        // again is proof enough that the message is stale.
        if (up) {
          setProblem(null);
          void refresh();
        }
        // A stream that drops while the app is open — a change of network, a
        // laptop that slept — comes back on its own rather than sitting on
        // "reconnecting" until someone pulls to refresh.
        if (up) {
          waited = 0;
        } else if (live && !retry) {
          // Keep trying. The laptop may be closed, or its phone access
          // switched off, and neither announces itself coming back — so the
          // phone has to ask. Backing off to half a minute keeps a laptop
          // that is off for an hour from being dialled every four seconds.
          const wait = Math.min(4000 * 2 ** waited, 30000);
          waited += 1;
          retry = setTimeout(() => {
            retry = null;
            if (AppState.currentState === "active") reopen();
          }, wait);
        }
      }, () => void refresh());
    };

    // iOS suspends a backgrounded app and the stream dies with it, silently —
    // the app simply stops hearing anything. So it is rebuilt on the way back
    // in rather than trusted.
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") return;
      void refresh();
      reopen();
    });

    return () => {
      live = false;
      if (retry) clearTimeout(retry);
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
      if (screen === "calendar") {
        setScreen(calFor?.kind === "room" ? "room" : "chat");
        return true;
      }
      if (screen === "phone") {
        setScreen("chat");
        return true;
      }
      // Back out of a conversation is back to the list, which is now the
      // drawer rather than a screen. Once it is open there is nowhere further
      // back to go, so the button does what it does anywhere else and leaves.
      if (!aside) {
        setAside(true);
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [screen, aside, calFor]);

  /* Where Apple should deliver, when this app is not running.
   *
   * Sent on every launch rather than once and remembered: a token changes when
   * the app is reinstalled or the phone is restored, and a laptop pushing to a
   * token that has moved on is a laptop that thinks it told you. */
  useEffect(() => {
    if (!pairing) return;
    let gone = false;
    showThemWhileOpen();
    void pushWhere().then((where) => {
      if (gone || !where) return;
      // Its own call rather than part of the state fetch: this is the phone
      // telling the laptop something, and everything else is the phone asking.
      void call(pairing, "phone/push", { ...where }).catch(() => {});
    });
    return () => {
      gone = true;
    };
  }, [pairing]);

  /** Do something on the laptop and read the result back.
   *
   *  What it answers is passed on rather than dropped: most actions have
   *  nothing to say, but starting a thread names the thread it made, and the
   *  only useful thing to do next is open it. */
  const act = useCallback(
    async <T,>(kind: string, payload: Record<string, unknown> = {}): Promise<T | undefined> => {
      const p = current.current;
      if (!p) return undefined;
      try {
        const answered = await call<T>(p, kind, payload);
        await refresh();
        return answered;
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
        return undefined;
      }
    },
    [refresh],
  );

  /* Opening something, from wherever it was tapped. One pair of these rather
     than a copy per list: the rail, the names beside it and the bell in the
     bar all mean the same thing by "open this", and three copies of it is
     three places for the drawer to forget to close. */
  const goToBot = (chosen: Bot) => {
    setBotId(chosen.id);
    setScreen("chat");
    setAside(false);
    void act("open", { botId: chosen.id });
  };
  const goToRoom = (chosen: Channel) => {
    setRoomId(chosen.id);
    setScreen("room");
    setAside(false);
    void act("channel/seen", { channelId: chosen.id });
  };

  // A room can be deleted while you are standing in it — from the laptop, or
  // from another phone. What is left is a screen with nothing on it and a
  // closed list, which reads as the app having lost its place. Slide the list
  // out instead: the room is gone, so the only thing left to do is pick
  // another one.
  //
  // Above the early returns below, not beside the room it is about: a hook
  // that some renders reach and others do not is not a hook, and React stops
  // the app rather than guess which one it was.
  useEffect(() => {
    if (screen !== "room" || !roomId) return;
    const here = snapshot?.channels ?? [];
    // Only once there is a snapshot to be sure with. Before the first read
    // every room is missing, and closing the one you opened because nothing
    // has loaded yet is its own bug.
    if (snapshot && !here.some((c) => c.id === roomId)) {
      setRoomId(null);
      setAside(true);
    }
  }, [screen, roomId, snapshot]);

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
  // Absent from a laptop older than channels, which is why everything here
  // copes with there being none rather than assuming the field exists.
  const channels = snapshot?.channels ?? [];
  const room = channels.find((c) => c.id === roomId);

  const called = String(snapshot?.settings?.name ?? "");

  /* What each face is doing. The laptop keeps a longer list of moods and works
     them out from its own event stream; the phone can tell three of them from
     what it is sent, which is three more than a still face.

     Three days, the same as the laptop: a bot nobody has spoken to since
     Tuesday is asleep rather than merely idle, and it is judged on the
     conversation because that is the thing that actually stopped. */
  const SLEEPS_AFTER = 3 * 24 * 60 * 60 * 1000;
  const moodOf = (bot: Bot): Mood => {
    if (bot.busy) {
      return (notes[bot.id] ?? "").toLowerCase().includes("using") ? "work" : "think";
    }
    const last = bot.messages[bot.messages.length - 1]?.at ?? 0;
    return last && Date.now() - last > SLEEPS_AFTER ? "sleep" : "idle";
  };

  /* A calendar is everyone's, one bot's, or one room's. A room's is the bots
     in it — a room has no routines of its own, its members do — narrowed to
     the ones that report there. */
  const calRoom = calFor?.kind === "room" ? channels.find((c) => c.id === calFor.id) : null;
  const calBots =
    calFor?.kind === "bot"
      ? bots.filter((b) => b.id === calFor.id)
      : calRoom
        ? bots.filter((b) => calRoom.members.includes(b.id))
        : bots;
  const calTitle =
    calFor?.kind === "bot"
      ? (bots.find((b) => b.id === calFor.id)?.name ?? "Calendar")
      : calRoom
        ? `#${calRoom.name}`
        : "Calendar";

  return (
    <>
      <StatusBar barStyle="light-content" />
      {problem ? (
        <View style={s.problem}>
          <Text style={s.problemText}>{problem}</Text>
        </View>
      ) : null}

      {screen === "calendar" ? (
        <Calendar
          bots={calBots}
          title={calTitle}
          into={calFor?.kind === "room" ? calFor.id : undefined}
          // Back to where the calendar was opened from: the room or the chat
          // if it was one of those, and the drawer if it was the bar.
          onBack={() => setScreen(calFor?.kind === "room" ? "room" : "chat")}
          onSave={(whose, routine) => act("routine/save", { botId: whose, routine })}
          onOpen={(chosen) => {
            setBotId(chosen.id);
            setScreen("settings");
          }}
        />
      ) : screen === "phone" ? (
        <Phone
          pairing={pairing}
          connected={connected}
          // Leaving the screen, not opening the drawer. This screen is not
          // inside the drawer — it replaces everything — so reopening one that
          // is already open behind it did nothing at all, and the chevron was
          // a button that could be pressed all day. What the drawer was doing
          // is left alone: you came here from it, so it is open, and it comes
          // back with you. Android's back button has always done this.
          onBack={() => setScreen("chat")}
          onDisconnect={async () => {
            await clearPairing();
            setPairing(null);
            setSnapshot(null);
            setScreen("chat");
          }}
        />
      ) : screen === "settings" && bot ? (
        <BotSettings
          bot={bot}
          engines={snapshot?.engines ?? []}
          manners={snapshot?.manners}
          onBack={() => setScreen("chat")}
          onUpdate={(patch) => act("bot/update", { botId: bot.id, ...patch })}
          onDelete={async () => {
            setAside(true);
            setScreen("chat");
            await act("bot/delete", { botId: bot.id });
          }}
          onRoutineSave={(routine: Routine) => act("routine/save", { botId: bot.id, routine })}
          onRoutineDelete={(id: string) => act("routine/delete", { botId: bot.id, routineId: id })}
          onDesktop={(start: boolean) =>
            act(start ? "desktop/start" : "desktop/stop", { botId: bot.id })
          }
        />
      ) : (
        // The conversation is the app; the list slides over it. Both are
        // always mounted, so opening the drawer is not a screen being built
        // and coming back is not one being built again.
        <Drawer
          open={aside}
          onOpen={() => setAside(true)}
          onClose={() => setAside(false)}
          aside={
            // The laptop's collapsed sidebar, in the place Discord keeps its
            // server rail, with the named list beside it.
            <View style={s.aside}>
              <Rail
                bots={bots}
                moodOf={moodOf}
                rooms={channels.filter((c) => !c.from)}
                openBot={botId}
                openRoom={
                  screen === "room"
                    ? (room?.from?.channelId ?? room?.id ?? null)
                    : null
                }
                onOpen={goToBot}
                onOpenChannel={goToRoom}
              />
              <Bots
                bots={bots}
                moodOf={moodOf}
                channels={channels}
                called={called}
                connected={connected}
                loading={loading}
                onRefresh={refresh}
                onOpen={goToBot}
                onOpenChannel={goToRoom}
                onCreate={async (name, role) => {
                  await act("bot/create", { name, role });
                }}
                onCreateChannel={async (name, purpose, members) => {
                  await act("channel/create", { name, purpose, members });
                }}
                desk={snapshot?.desk}
                onOpenDesk={(item) => {
                  // The same three destinations the laptop's desk has, minus
                  // the one it keeps for itself: an engine that cannot run is
                  // fixed on the machine it cannot run on.
                  const room = item.at.channelId
                    ? channels.find((c) => c.id === item.at.channelId)
                    : undefined;
                  const whose = item.at.botId
                    ? bots.find((b) => b.id === item.at.botId)
                    : undefined;
                  if (room) goToRoom(room);
                  else if (whose) goToBot(whose);
                }}
              />

              {/* Over the rail as well as the list, because it is about you and
                  not about either of them. Last child so it sits in front of
                  both. */}
              <Foot
                called={called}
                onCalendar={() => {
                  setCalFor(null);
                  setScreen("calendar");
                }}
                onSettings={() => setScreen("phone")}
              />
            </View>
          }
        >
          {screen === "room" && room ? (
          <Room
            channel={room}
            bots={bots}
            called={String(snapshot?.settings?.name ?? "")}
            parent={channels.find((c) => c.id === room.from?.channelId)}
            threads={channels.filter((c) => c.from)}
            onBack={() => setAside(true)}
            onCalendar={() => {
              setCalFor({ kind: "room", id: room.id });
              setScreen("calendar");
            }}
            onOpenThread={(thread) => {
              setRoomId(thread.id);
              void act("channel/seen", { channelId: thread.id });
            }}
            onEdit={async (fields) => {
              await act("channel/update", { channelId: room.id, ...fields });
            }}
            onDeleteChannel={async () => {
              // Out of the room first: staying in one that has just been
              // deleted leaves the screen showing a transcript that no longer
              // exists anywhere.
              setAside(true);
              setRoomId(null);
              await act("channel/delete", { channelId: room.id });
            }}
            onAnswer={async (messageId, answer) => {
              await act("message/answer", { channelId: room.id, messageId, answer });
            }}
            onPin={async (messageId) => {
              // No "pinned" flag sent: the laptop flips whatever it has, so
              // acting on a snapshot a few seconds old cannot pin something
              // that is already pinned. The refresh is what puts the mark on
              // the message here.
              await act("message/pin", { channelId: room.id, messageId });
            }}
            onThread={async (messageId) => {
              const made = await act<{ id: string }>("thread/start", {
                channelId: room.id,
                messageId,
              });
              // Straight into it, because starting a thread is wanting to say
              // something in it.
              if (made?.id) {
                setRoomId(made.id);
                void act("channel/seen", { channelId: made.id });
              }
            }}
            onSend={async (text) => {
              // Shown at once; the laptop's own copy replaces it with the next
              // snapshot, the same bargain a bot's chat already makes.
              setSnapshot((was) =>
                was
                  ? {
                      ...was,
                      channels: (was.channels ?? []).map((c) =>
                        c.id === room.id
                          ? {
                              ...c,
                              busy: true,
                              messages: [
                                ...c.messages,
                                {
                                  id: `local-${Date.now()}`,
                                  from: "me" as const,
                                  text,
                                  at: Date.now(),
                                  fromPhone: true,
                                },
                              ],
                            }
                          : c,
                      ),
                    }
                  : was,
              );
              const p = current.current;
              if (!p) return;
              try {
                await call(p, "channel/send", { channelId: room.id, text });
              } catch (err) {
                setProblem(err instanceof Error ? err.message : String(err));
                void refresh();
              }
            }}
          />
          ) : bot ? (
          <Chat
            bot={bot}
            note={notes[bot.id] ?? ""}
            called={String(snapshot?.settings?.name ?? "")}
            onBack={() => setAside(true)}
            onCalendar={() => {
              setCalFor({ kind: "bot", id: bot.id });
              setScreen("calendar");
            }}
            onSettings={() => setScreen("settings")}
            onPin={async (messageId) => {
              await act("message/pin", { botId: bot.id, messageId });
            }}
            onAnswer={async (messageId, answer) => {
              await act("message/answer", { botId: bot.id, messageId, answer });
            }}
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
                                {
                                  id: `local-${Date.now()}`,
                                  from: "me" as const,
                                  text,
                                  at: Date.now(),
                                  fromPhone: true,
                                },
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
            <View style={s.middle}>
              <Text style={s.nothing}>Pick a bot or a channel.</Text>
            </View>
          )}
        </Drawer>
      )}
    </>
  );
}

const s = StyleSheet.create({
  middle: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: T.bg },
  nothing: { color: T.text3, fontSize: 14 },
  aside: { flex: 1, flexDirection: "row" },
  problem: {
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 8,
    backgroundColor: "#3a1d1d",
  },
  problemText: { color: "#ffb4ae", fontSize: 12.5 },
});
