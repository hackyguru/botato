/**
 * The strip of icons down the left of the drawer.
 *
 * The laptop's sidebar collapsed to 66px, in the place Discord keeps its
 * server rail: a hash per room, a rule, then a face per bot, with whatever is
 * open lit. Everything here is a shortcut — nothing is only reachable from the
 * rail, which is what lets it be wordless.
 *
 * No search icon, unlike the collapsed laptop sidebar. There it is the only way
 * to search, because a 66px column has nowhere to put a field; here the field
 * is nine pixels to the right, and a button that focuses a visible field is a
 * button pretending to do something.
 */

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import Face from "./face";
import { T } from "./theme";
import type { Bot, Channel } from "./types";

export const RAIL_W = 62;

export default function Rail({
  bots,
  rooms,
  openBot,
  openRoom,
  onOpen,
  onOpenChannel,
}: {
  bots: Bot[];
  /** Rooms only. A thread has no icon of its own here for the same reason it
   *  has none in the laptop's rail: there is no room for a name, and a thread
   *  without its name is a dot. */
  rooms: Channel[];
  openBot?: string | null;
  openRoom?: string | null;
  onOpen: (bot: Bot) => void;
  onOpenChannel: (room: Channel) => void;
}) {
  return (
    <View style={s.rail}>
      <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
        {rooms.map((room) => {
          // A room you are in through one of its threads counts as the room
          // you are in: the thread is not drawn here, so nothing else would be
          // lit at all.
          const here = room.id === openRoom;
          return (
            <Pressable
              key={room.id}
              style={[s.slot, here && s.slotHere]}
              onPress={() => onOpenChannel(room)}
            >
              <Text style={[s.hash, here && s.hashHere]}>#</Text>
            </Pressable>
          );
        })}

        {rooms.length && bots.length ? <View style={s.rule} /> : null}

        {bots.map((bot) => {
          const here = bot.id === openBot && !openRoom;
          return (
            <Pressable
              key={bot.id}
              style={[s.slot, here && s.slotHere]}
              onPress={() => onOpen(bot)}
            >
              <Face bot={bot} size={38} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  rail: {
    width: RAIL_W,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: T.line,
  },
  list: { paddingTop: 62, paddingBottom: 24, alignItems: "center", gap: 6 },
  slot: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  slotHere: { backgroundColor: T.field },
  hash: { color: T.text2, fontSize: 21 },
  hashHere: { color: T.text },
  rule: { width: 22, height: 2, borderRadius: 1, backgroundColor: T.line, marginVertical: 6 },
});
