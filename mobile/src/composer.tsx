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

import React, { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import Face from "./face";
import {
  accept,
  matches,
  matchingShortcuts,
  offers,
  query,
  shortcuts,
  slash,
  type Offer,
  type Shortcut,
} from "./mention";
import type { Bot } from "./types";
import { T } from "./theme";

export default function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  busy,
  members,
  offering,
  inRoom,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  placeholder: string;
  /** Mid-turn: what you type is kept, and sending waits. */
  busy?: boolean;
  /** Who is in this room, for finishing an "@". Absent in a one-to-one
   *  conversation, where there is nobody to summon but the bot you are
   *  already talking to. */
  members?: Bot[];
  /** Whose shortcuts a "/" offers. In a room that is everyone in it; in a
   *  chat it is the one bot — which is why this is separate from `members`,
   *  where an "@" would make no sense. */
  offering?: Bot[];
  /** Whether a chosen shortcut needs the bot's name in front of it. In a room
   *  it does: "/log" said into a room of five is addressed to nobody. */
  inRoom?: boolean;
}) {
  const ready = !!value.trim() && !busy;

  /** Where the caret is, because an "@" is only being typed if the caret is
   *  after it — and on a phone the caret moves by tap as often as by typing. */
  const [caret, setCaret] = useState(0);
  const field = useRef<TextInput>(null);

  const asking = members?.length ? query(value, caret) : null;
  const found: Offer[] = asking ? matches(offers(members ?? []), asking.query) : [];

  // A slash at the start of the line offers what these bots say they do. It
  // works in a chat as well as a room, unlike "@", which needs somebody else
  // to be there.
  const typing = offering?.length ? slash(value, caret) : null;
  const commands: Shortcut[] =
    typing === null ? [] : matchingShortcuts(shortcuts(offering ?? []), typing);

  function put(text: string, at: number) {
    onChange(text);
    setCaret(at);
    field.current?.setNativeProps({ selection: { start: at, end: at } });
  }

  /** Nothing is sent: a shortcut is the beginning of a message, not the whole
   *  of one. Most take a few words after them. */
  function take(pick: Shortcut) {
    const whose = inRoom ? `@${pick.botName} ` : "";
    const written = `${whose}/${pick.name} `;
    put(written + value.slice(Math.max(0, Math.min(caret, value.length))), written.length);
  }

  function finish(pick: Offer) {
    if (!asking) return;
    const done = accept(value, caret, asking.at, pick.name);
    // The keyboard stays up and the caret goes after the name rather than to
    // the end: picking a mention is the middle of typing a sentence, not the
    // end of one.
    put(done.text, done.caret);
  }

  return (
    <View style={s.dock}>
      {/* Above the bar, where the laptop puts it and where a thumb can reach
          it without covering what it is choosing from. Scrolls rather than
          growing: a room with a dozen bots in it must not push the field off
          the top of the keyboard. */}
      {commands.length ? (
        <View style={s.list}>
          <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
            {commands.map((pick) => (
              <Pressable
                key={`${pick.botId}/${pick.name}`}
                style={s.pick}
                onPress={() => take(pick)}
                accessibilityRole="button"
                accessibilityLabel={`${pick.name}, ${pick.botName}`}
              >
                <Text style={s.slash}>/{pick.name}</Text>
                <Text style={s.pickHint} numberOfLines={1}>
                  {inRoom ? `${pick.botName} — ${pick.what}` : pick.what}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {found.length ? (
        <View style={s.list}>
          <ScrollView keyboardShouldPersistTaps="always" showsVerticalScrollIndicator={false}>
            {found.map((pick) => {
              const bot = members?.find((b) => b.id === pick.botId);
              return (
                <Pressable
                  key={pick.botId ?? pick.name}
                  style={s.pick}
                  onPress={() => finish(pick)}
                  accessibilityRole="button"
                  accessibilityLabel={`Mention ${pick.name}`}
                >
                  {bot ? (
                    <Face bot={bot} size={22} mood="idle" />
                  ) : (
                    // "everyone" is not a bot and gets no face; a hash stands
                    // for the room, the same mark the room wears everywhere
                    // else in the app.
                    <View style={s.all}>
                      <Text style={s.allMark}>#</Text>
                    </View>
                  )}
                  <Text style={s.pickName} numberOfLines={1}>
                    {pick.name}
                  </Text>
                  {pick.hint ? (
                    <Text style={s.pickHint} numberOfLines={1}>
                      {pick.hint}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <View style={s.field}>
        <TextInput
          ref={field}
          style={s.input}
          value={value}
          onChangeText={onChange}
          onSelectionChange={(e) => setCaret(e.nativeEvent.selection.start)}
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
  list: {
    maxHeight: 188,
    marginHorizontal: 4,
    marginBottom: 8,
    paddingVertical: 4,
    backgroundColor: T.raised,
    borderRadius: 14,
    overflow: "hidden",
  },
  pick: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 7,
    paddingHorizontal: 11,
  },
  all: {
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    backgroundColor: T.field,
    borderRadius: 6,
  },
  allMark: { color: T.text3, fontSize: 13, fontWeight: "700" },
  pickName: { color: T.text, fontSize: 15, fontWeight: "600" },
  slash: { color: T.text, fontSize: 15, fontWeight: "600", fontFamily: T.mono },
  pickHint: { flexShrink: 1, color: T.text3, fontSize: 13 },
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
    letterSpacing: 0,
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
