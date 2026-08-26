/**
 * The strip of icons down the left of the drawer.
 *
 * The laptop's sidebar collapsed to 62px, in the place Discord keeps its server
 * rail: a hash per room, a rule, then a face per bot, with whatever is open
 * lit. Everything here is a shortcut — nothing is only reachable from the rail,
 * which is what lets it be wordless.
 *
 * It is told apart from the list beside it by shade, which is how Discord tells
 * its own rail apart and is the only thing that works at this width. The
 * alternatives were tried: a hairline down the right is a detail you have to go
 * looking for, and standing the icons on panels made the strip read as two
 * cards floating on the list rather than as the edge of the app. Here the rail
 * is the darkest surface in the drawer and the list steps up from it, so the
 * boundary is a change of ground rather than a mark somebody drew.
 *
 * No search icon, unlike the collapsed laptop sidebar. There it is the only way
 * to search, because a 66px column has nowhere to put a field; here the field
 * is nine pixels to the right, and a button that focuses a visible field is a
 * button pretending to do something.
 *
 * The mark sits at the top, where Discord keeps its home button and where the
 * laptop keeps the same mark: level with the wordmark beside it. It is not a
 * button — there is nowhere for it to go that you are not already looking at.
 */

import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import Brand from "./brand";
import Face from "./face";
import { T } from "./theme";
import type { Bot, Channel } from "./types";

export const RAIL_W = 62;

/** One icon in the strip, with the marker for whether you are in it.
 *
 *  The white tab at the left edge is Discord's, and it is worth copying: at
 *  this size a tinted tile is a thing you notice only once you are looking for
 *  it, and a tab breaking the rail's edge is visible from the other side of
 *  the screen. */
function Seat({
  here,
  onPress,
  children,
}: {
  here: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={s.seat}>
      {here ? <View style={s.tab} /> : null}
      <Pressable style={[s.slot, here ? s.slotHere : null]} onPress={onPress}>
        {children}
      </Pressable>
    </View>
  );
}

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
      <View style={s.rule} />

      <ScrollView contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
        {rooms.map((room) => (
          // A room you are in through one of its threads counts as the room you
          // are in: the thread is not drawn here, so nothing else would be lit
          // at all.
          <Seat key={room.id} here={room.id === openRoom} onPress={() => onOpenChannel(room)}>
            <Text style={[s.hash, room.id === openRoom ? s.hashHere : null]}>#</Text>
          </Seat>
        ))}

        {rooms.length && bots.length ? <View style={s.rule} /> : null}

        {bots.map((bot) => (
          <Seat
            key={bot.id}
            here={bot.id === openBot && !openRoom}
            onPress={() => onOpen(bot)}
          >
            <Face bot={bot} size={38} />
          </Seat>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  /* The darkest surface in the drawer, and the whole of how the strip is told
     apart from the list. Painted rather than left transparent: the drawer
     behind it is this colour too, and a rail that only looks right because of
     what is underneath it stops looking right the moment anything changes
     there. */
  rail: { width: RAIL_W, backgroundColor: T.bg },
  /* Level with the "botcage" beside it: the same 64 the list's header uses,
     and the same 26 its title is set in. */
  crest: { paddingTop: 64, paddingBottom: 8, alignItems: "center" },
  /* The last icon clears the bar that floats across the bottom of the drawer,
     this strip included. */
  list: { paddingTop: 8, paddingBottom: 104, alignItems: "center", gap: 6 },
  rule: {
    alignSelf: "center",
    width: 24,
    height: 2,
    marginVertical: 5,
    borderRadius: 1,
    backgroundColor: "rgba(255,255,255,0.11)",
  },
  seat: { width: RAIL_W, alignItems: "center", justifyContent: "center" },
  slot: {
    width: 46,
    height: 46,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  slotHere: { backgroundColor: T.field },
  /* Half of it hangs off the left edge, so what is drawn is a tab with two
     corners rather than a floating lozenge. */
  tab: {
    position: "absolute",
    left: -4,
    width: 8,
    height: 26,
    borderRadius: 4,
    backgroundColor: T.text,
  },
  hash: { color: T.text2, fontSize: 21 },
  hashHere: { color: T.text },
});
