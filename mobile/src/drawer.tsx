/**
 * The list beside the conversation, the way Discord has it on a phone.
 *
 * botcage had two full screens and a back button: the list, then the room,
 * then back to the list. That is the iOS stack, and it makes the list somewhere
 * you *go* — which is wrong for a thing you glance at twenty times an hour to
 * see who is talking. Discord makes it a drawer the conversation slides off,
 * and the conversation is the app.
 *
 * Swiping right anywhere in the conversation opens it, because there is nothing
 * else a horizontal drag could mean here — nothing in a room scrolls sideways.
 * The drag is followed rather than triggered: the panel tracks your finger and
 * settles to whichever side it was heading for when you let go.
 */

import React, { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import { T } from "./theme";

const WIDTH = Dimensions.get("window").width;
/** How far the conversation slides. The sliver left behind is what says it is
 *  still there and can be tapped to come back. */
export const DRAWER_W = Math.round(WIDTH * 0.84);

export default function Drawer({
  open,
  onOpen,
  onClose,
  aside,
  children,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  aside: React.ReactNode;
  children: React.ReactNode;
}) {
  const x = useRef(new Animated.Value(open ? DRAWER_W : 0)).current;
  // Where the pan started, so a drag that begins mid-animation does not jump.
  const from = useRef(open ? DRAWER_W : 0);

  useEffect(() => {
    from.current = open ? DRAWER_W : 0;
    Animated.spring(x, {
      toValue: open ? DRAWER_W : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 14,
    }).start();
  }, [open, x]);

  const pan = useRef(
    PanResponder.create({
      // Claimed only once the drag is plainly sideways, so a scroll up the
      // conversation is still a scroll.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        const at = Math.min(DRAWER_W, Math.max(0, from.current + g.dx));
        x.setValue(at);
      },
      onPanResponderRelease: (_e, g) => {
        const at = from.current + g.dx;
        // Where it was heading matters more than where it got to: a short
        // flick should open it, and a slow drag most of the way should not
        // snap back.
        const goingOpen = g.vx > 0.35 || (g.vx > -0.35 && at > DRAWER_W / 2);
        if (goingOpen) onOpen();
        else onClose();
        // The effect above animates when `open` changes; when it does not —
        // dragging halfway and letting go on the side you started — nothing
        // would move, so it is settled here too.
        Animated.spring(x, {
          toValue: goingOpen ? DRAWER_W : 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 14,
        }).start(() => {
          from.current = goingOpen ? DRAWER_W : 0;
        });
      },
    }),
  ).current;

  return (
    <View style={s.fill}>
      <View style={s.aside}>{aside}</View>

      <Animated.View style={[s.front, { transform: [{ translateX: x }] }]} {...pan.panHandlers}>
        {children}
        {/* The conversation is still there under this, and tapping it is how
            you go back to it — the same gesture as tapping outside any panel.
            Only while open, or it would eat every tap in the room. */}
        {open ? <Pressable style={StyleSheet.absoluteFill} onPress={onClose} /> : null}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  aside: { position: "absolute", top: 0, bottom: 0, left: 0, width: DRAWER_W },
  front: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: T.bg,
    // A seam, so the conversation reads as a sheet lying over the list rather
    // than as the same surface continuing.
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: T.line,
  },
});
