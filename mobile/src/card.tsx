/**
 * Who a bot is, on one card.
 *
 * Everything here is already somewhere in the app — the role is in its
 * settings, the hours are on the shift picker, what it costs is on the
 * payroll, what it answers to is behind a slash. Scattered across four screens
 * it is configuration; gathered on the face you just tapped it is a colleague.
 *
 * Read-only, like the laptop's. Every line has a place it is edited, and the
 * card offers the way there rather than growing a second set of controls that
 * drift from the first.
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import Face from "./face";
import Sheet from "./sheet";
import { T } from "./theme";
import type { Bot } from "./types";

/** What it is doing, in the present tense — the question somebody tapping a
 *  face is actually asking. Working beats off-the-clock: a bot mid-turn is
 *  mid-turn whatever its hours say. */
function doing(bot: Bot): { says: string; working: boolean } {
  if (bot.busy) return { says: "Working", working: true };
  if (!bot.hours) return { says: "Ready", working: false };
  return { says: saysHours(bot), working: false };
}

/** The shift in words, the way the laptop says it. */
function saysHours(bot: Bot): string {
  const h = bot.hours;
  if (!h) return "Any time";
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = h.days?.length === 7 ? "every day" : (h.days ?? []).map((d) => DAYS[d]).join(" ");
  return `${h.from}–${h.to} ${days}`.trim();
}

export default function Card({
  bot,
  onClose,
  onOpen,
  onSettings,
}: {
  /** The bot to show, or none — which closes the sheet. */
  bot: Bot | null;
  onClose: () => void;
  onOpen: (bot: Bot) => void;
  onSettings: (bot: Bot) => void;
}) {
  const state = bot ? doing(bot) : null;

  return (
    <Sheet open={!!bot} title="" onClose={onClose}>
      {bot && state ? (
        <>
          <View style={s.head}>
            <Face bot={bot} size={52} mood="idle" />
            <View style={s.who}>
              <Text style={s.name} numberOfLines={1}>
                {bot.name}
              </Text>
              <Text style={[s.doing, state.working ? s.working : null]} numberOfLines={1}>
                {state.says}
              </Text>
            </View>
          </View>

          {bot.role ? (
            <Text style={s.role} numberOfLines={4}>
              {bot.role.split("\n")[0]}
            </Text>
          ) : null}

          <View style={s.lines}>
            <Line label="Answered by" value={bot.model || "Claude Code"} />
            {bot.routines?.filter((r) => r.active).length ? (
              <Line
                label="Routines"
                value={`${bot.routines.filter((r) => r.active).length} active`}
              />
            ) : null}
            {/* Only once it has cost something: a row saying $0.00 is a row
                about nothing. */}
            {bot.spend?.weekUsd ? (
              <Line label="This week" value={`$${bot.spend.weekUsd.toFixed(2)}`} />
            ) : null}
          </View>

          {bot.commands?.length ? (
            <View style={s.cmds}>
              {bot.commands.map((one) => (
                <View key={one.name} style={s.cmd}>
                  <Text style={s.cmdName}>/{one.name}</Text>
                  <Text style={s.cmdWhat} numberOfLines={1}>
                    {one.what}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={s.acts}>
            <Pressable style={s.act} onPress={() => onOpen(bot)}>
              <Text style={s.actText}>Open</Text>
            </Pressable>
            <Pressable style={s.act} onPress={() => onSettings(bot)}>
              <Text style={s.actText}>Settings</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.line}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 4 },
  who: { flex: 1, minWidth: 0 },
  name: { color: T.text, fontSize: 18, fontWeight: "700" },
  doing: { marginTop: 2, color: T.text3, fontSize: 13 },
  working: { color: T.blue },
  role: { color: T.text2, fontSize: 14, lineHeight: 20 },
  lines: {
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.line,
  },
  line: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 4 },
  label: { color: T.text3, fontSize: 13 },
  value: { flexShrink: 1, color: T.text2, fontSize: 13, textAlign: "right" },
  cmds: {
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: T.line,
  },
  cmd: { flexDirection: "row", alignItems: "baseline", gap: 9, paddingVertical: 3 },
  cmdName: { color: T.text, fontSize: 13, fontFamily: T.mono },
  cmdWhat: { flexShrink: 1, color: T.text3, fontSize: 13 },
  acts: { flexDirection: "row", gap: 8, paddingTop: 8 },
  act: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 11,
    backgroundColor: T.field,
    borderRadius: 11,
  },
  actText: { color: T.text, fontSize: 15, fontWeight: "600" },
});
