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

import React, { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";

import { T } from "./theme";

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
  // How far the conversation slides: the whole way, because Discord leaves no
  // edge of it showing.
  //
  // Measured from this view rather than from the window. The window is a
  // slightly different number — I had a fifteen-point sliver of the chat left
  // on screen, which is exactly the thing this is meant not to have — and the
  // only width that is certainly right is the one the thing being moved was
  // actually given.
  const [width, setWidth] = useState(0);
  const wide = useRef(width);
  wide.current = width;

  const x = useRef(new Animated.Value(0)).current;
  // Where the pan started, so a drag that begins mid-animation does not jump.
  const from = useRef(0);

  useEffect(() => {
    from.current = open ? wide.current : 0;
    Animated.spring(x, {
      toValue: open ? wide.current : 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 14,
    }).start();
  }, [open, x, width]);

  const pan = useRef(
    PanResponder.create({
      // Claimed only once the drag is plainly sideways, so a scroll up the
      // conversation is still a scroll.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        const at = Math.min(wide.current, Math.max(0, from.current + g.dx));
        x.setValue(at);
      },
      onPanResponderRelease: (_e, g) => {
        const at = from.current + g.dx;
        // Where it was heading matters more than where it got to: a short
        // flick should open it, and a slow drag most of the way should not
        // snap back.
        const goingOpen = g.vx > 0.35 || (g.vx > -0.35 && at > wide.current / 2);
        if (goingOpen) onOpen();
        else onClose();
        // The effect above animates when `open` changes; when it does not —
        // dragging halfway and letting go on the side you started — nothing
        // would move, so it is settled here too.
        Animated.spring(x, {
          toValue: goingOpen ? wide.current : 0,
          useNativeDriver: true,
          bounciness: 0,
          speed: 14,
        }).start(() => {
          from.current = goingOpen ? wide.current : 0;
        });
      },
    }),
  ).current;

  return (
    // The drag is caught here rather than on the conversation, because when
    // the drawer is open the conversation is not on the screen at all and
    // there would be nothing left to swipe.
    <View
      style={s.fill}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      {...pan.panHandlers}
    >
      <View style={s.aside}>{aside}</View>

      <Animated.View style={[s.front, { transform: [{ translateX: x }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: T.bg },
  aside: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
  front: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: T.bg,
  },
});
