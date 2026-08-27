/**
 * Something that comes over the top, rather than shoving the page aside.
 *
 * The forms in this app used to unfold in place: press "+" and a create-bot
 * form appeared between the header and the list, pushing everything down. It
 * works, and it is wrong. The thing you were reading moves while you are
 * reading it, the button you pressed is now next to something else, and
 * cancelling makes the whole screen jump back. On a phone, where the page is
 * the whole window, that reads as the app rearranging itself rather than as
 * you opening something.
 *
 * A sheet keeps the page still. It rises from the bottom, it dims what is
 * behind it so there is no question which thing is asking, and closing it
 * leaves the screen exactly as you left it. It is also what the laptop does,
 * so the two apps stop disagreeing about what "open a form" looks like.
 *
 * Bottom-anchored rather than centred: a phone is held at the bottom, forms
 * here are typed into, and the keyboard comes up from below — a centred dialog
 * would spend the whole time being pushed around by it.
 */

import React from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { T } from "./theme";

export default function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={open}
      transparent
      animationType="slide"
      // Android's own back gesture closes it, the same as the backdrop does.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* The dim. Tapping it is the quickest way out of something you opened
          by accident, and it is the gesture everybody already tries. */}
      <Pressable style={s.behind} onPress={onClose} />

      <KeyboardAvoidingView
        style={s.dock}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
      >
        <View style={s.sheet}>
          <View style={s.head}>
            <Text style={s.title} numberOfLines={1}>
              {title}
            </Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={s.close}>×</Text>
            </Pressable>
          </View>

          {/* Scrolls rather than grows: a form taller than the screen still has
              to be finishable, and the keyboard takes half of it. */}
          <ScrollView
            contentContainerStyle={s.body}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  behind: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  dock: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    maxHeight: "88%",
    paddingBottom: 26,
    backgroundColor: T.panel,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 16,
    paddingRight: 14,
    paddingBottom: 8,
    paddingLeft: 20,
  },
  title: { flexShrink: 1, color: T.text, fontSize: 18, fontWeight: "600" },
  close: { color: T.text2, fontSize: 26, lineHeight: 30 },
  body: { paddingHorizontal: 16, paddingBottom: 10, gap: 9 },
});
