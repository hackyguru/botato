/**
 * The strip of icons down the left of the drawer.
 *
 * The laptop's sidebar collapsed to 66px, in the place Discord keeps its
 * server rail: a panel of hashes for the rooms, a panel of faces for the bots,
 * with whatever is open lit. Everything here is a shortcut — nothing is only
 * reachable from the rail, which is what lets it be wordless.
 *
 * No search icon, unlike the collapsed laptop sidebar. There it is the only way
 * to search, because a 66px column has nowhere to put a field; here the field
 * is nine pixels to the right, and a button that focuses a visible field is a
 * button pretending to do something.
 *
 * The mark sits at the top of it, where Discord keeps its home button and where
 * the laptop keeps the same mark: level with the wordmark beside it, and on the
 * black rather than on either panel, so it reads as the app rather than as the
 * first thing in the list. It is not a button — there is nowhere for it to go
 * that you are not already looking at.
 */

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import Brand from "./brand";
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
      <View style={s.crest}>
        <Brand size={26} />
      </View>

      <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
        {rooms.length ? (
          <View style={[s.block, bots.length ? null : s.tail]}>
            {rooms.map((room) => {
              // A room you are in through one of its threads counts as the
              // room you are in: the thread is not drawn here, so nothing else
              // would be lit at all.
              const here = room.id === openRoom;
              return (
                <Pressable
                  key={room.id}
                  style={[s.slot, here ? s.slotHere : null]}
                  onPress={() => onOpenChannel(room)}
                >
                  <Text style={[s.hash, here ? s.hashHere : null]}>#</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {bots.length ? (
          <View style={[s.block, s.tail]}>
            {bots.map((bot) => {
              const here = bot.id === openBot && !openRoom;
              return (
                <Pressable
                  key={bot.id}
                  style={[s.slot, here ? s.slotHere : null]}
                  onPress={() => onOpen(bot)}
                >
                  <Face bot={bot} size={38} />
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  /* No dividing line down its right any more: the strip is black, and what is
     drawn on it are the two panels below — the edge of those is the edge of
     the rail, and a hairline as well would be a second one saying the same
     thing a pixel away. */
  rail: { width: RAIL_W },
  /* Level with the "botcage" beside it: the same 64 the list's header uses,
     and the same 26 its title is set in. */
  crest: { paddingTop: 64, paddingBottom: 9, alignItems: "center" },
  /* `flexGrow` so the last panel has room to run into: without it the content
     is only as tall as the icons and there is nothing below them to fill. */
  list: { flexGrow: 1, paddingTop: 8, alignItems: "center", gap: 10 },
  /* The rooms on one panel, the bots on another, both in the colour of the
     search field across the way. The gap between them is what says where one
     ends — a rule between two things already sitting apart is a third mark for
     a job two are doing. */
  block: {
    padding: 4,
    gap: 4,
    alignItems: "center",
    backgroundColor: T.field,
    borderRadius: 17,
  },
  /* The last panel runs off the bottom of the screen rather than stopping
     under the final face. Square at that end, because a rounded corner an inch
     above the edge says the panel ends there and the black below it is
     something else. */
  tail: {
    flex: 1,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  slot: {
    width: 46,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  /* Lit, not filled: the panel underneath is already the field's colour, so
     what is open is the tile a shade above it. */
  slotHere: { backgroundColor: "rgba(255,255,255,0.11)" },
  hash: { color: T.text2, fontSize: 21 },
  hashHere: { color: T.text },
});
