/**
 * What is waiting in a conversation.
 *
 * Here rather than in the screen it grew up in, because the bar at the bottom
 * of the drawer counts the same thing the rows do and two implementations of
 * "unread" is a badge that disagrees with the bell above it.
 */

import type { Message } from "./types";

/** What has happened somewhere you were not looking.
 *
 *  The same two numbers the laptop keeps, meaning the same two things: unread
 *  is "there is something here", mentions is "somebody wanted you". A room of
 *  bots working is not a room that asked you a question. */
export function unreadIn(messages: Message[], seenAt = 0, called = "") {
  let unread = 0;
  let mentions = 0;
  const at = called ? new RegExp(`@${called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
  for (const msg of messages) {
    if (msg.from === "me" || msg.at <= seenAt || !msg.text.trim()) continue;
    unread += 1;
    if (at?.test(msg.text)) mentions += 1;
  }
  return { unread, mentions };
}
