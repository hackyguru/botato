/**
 * The bar you type in, shaped the way Discord shapes it on a phone.
 *
 * One rounded field spanning the width, with the send arrow *inside* it on the
 * right and only once there is something to send. botcage had the field and a
 * blue circle beside it, which is the iMessage arrangement: the circle is
 * always there, always the brightest thing on the screen, and mostly disabled.
 *
 * Deliberately no "+". Discord has one for attachments and botcage has nothing
 * to attach — a button that opens nothing is worse than a missing button.
 */

import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { T } from "./theme";

export default function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  busy,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  /** Mid-turn: what you type is kept, and sending waits. */
  busy?: boolean;
}) {
  const ready = !!value.trim() && !busy;
  return (
    <View style={s.dock}>
      <View style={s.field}>
        <TextInput
          style={s.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={T.text3}
          multiline
        />
        {/* Absent rather than dimmed when there is nothing to send: a control
            that cannot be used is one more thing to read past, and the field
            gets the width back. */}
        {ready ? (
          <Pressable style={s.send} onPress={onSend} hitSlop={8}>
            <Text style={s.sendText}>↑</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  dock: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 30,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.line,
  },
  field: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 6,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 5,
    backgroundColor: T.field,
    borderRadius: 22,
  },
  input: {
    flex: 1,
    maxHeight: 130,
    paddingVertical: 6,
    color: T.text,
    fontSize: 15,
  },
  send: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: T.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
