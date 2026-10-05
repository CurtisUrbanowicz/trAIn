/**
 * Pure state logic for the chat list: one bubble per message id, and the
 * "reply pending" state that survives the app closing. No React, no
 * Supabase — useChat applies these to its state; a node script can test
 * them directly.
 *
 * Every message has an id from the start: the athlete's from the phone,
 * the reply's from the server's first NDJSON frame. Stream frames,
 * realtime inserts and hydration all go through upsertMessage, so the
 * saved row is canonical and a reply can never appear twice.
 */

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  // ISO timestamp; insert order for rows not yet in the list
  timestamp: string;
  // Reply placeholder: dots while empty, dimmed while streaming. Cleared by
  // the done frame or replaced by the saved row.
  pending?: boolean;
  // Shown on this device only (timeout / error notice); never persisted,
  // never sent as history
  ephemeral?: boolean;
};

export type PendingState = {
  // Null for the opener (no user message to reply to)
  userMessageId: string | null;
  // Epoch ms: the user message's timestamp (or send time) — the timeout
  // counts from here, not from reopen
  since: number;
};

export const PENDING_TIMEOUT_MS = 5 * 60 * 1000;
export const TIMEOUT_NOTICE = "Didn't come through — send it again?";

/** Replace by id (position kept), else insert in timestamp order. */
export function upsertMessage(
  list: ChatMessage[],
  msg: ChatMessage
): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id);
  if (i !== -1) {
    const cur = list[i]!;
    if (
      cur.content === msg.content &&
      cur.role === msg.role &&
      cur.timestamp === msg.timestamp &&
      !!cur.pending === !!msg.pending &&
      !!cur.ephemeral === !!msg.ephemeral
    ) {
      return list;
    }
    const out = list.slice();
    out[i] = msg;
    return out;
  }
  // Numeric compare: Postgres and the browser format ISO strings differently
  const t = Date.parse(msg.timestamp) || 0;
  const at = list.findIndex((m) => (Date.parse(m.timestamp) || 0) > t);
  const out = list.slice();
  out.splice(at === -1 ? out.length : at, 0, msg);
  return out;
}

export function appendText(
  list: ChatMessage[],
  id: string,
  delta: string
): ChatMessage[] {
  const i = list.findIndex((m) => m.id === id);
  // Only a placeholder takes stream text: once the saved row has replaced
  // it (realtime can beat a late chunk), nothing is appended
  if (i === -1 || !list[i]!.pending) return list;
  const out = list.slice();
  out[i] = { ...out[i]!, content: out[i]!.content + delta };
  return out;
}

/** The start frame names the reply; the placeholder takes that id. */
export function retargetId(
  list: ChatMessage[],
  fromId: string,
  toId: string
): ChatMessage[] {
  const i = list.findIndex((m) => m.id === fromId);
  if (i === -1 || fromId === toId) return list;
  // The saved row may already be in the list (realtime beat the frame)
  const existing = list.findIndex((m) => m.id === toId);
  const out = list.slice();
  if (existing !== -1) {
    out.splice(i, 1);
    return out;
  }
  out[i] = { ...out[i]!, id: toId };
  return out;
}

/** Done frame: the placeholder is complete. Empty placeholders are dropped. */
export function finishPlaceholder(
  list: ChatMessage[],
  id: string
): ChatMessage[] {
  const i = list.findIndex((m) => m.id === id);
  if (i === -1) return list;
  const out = list.slice();
  if (out[i]!.content === "") out.splice(i, 1);
  else out[i] = { ...out[i]!, pending: false };
  return out;
}

/** Removes empty placeholders (a saved row has taken their place). */
export function dropEmptyPlaceholders(list: ChatMessage[]): ChatMessage[] {
  const out = list.filter((m) => !(m.pending && m.content === ""));
  return out.length === list.length ? list : out;
}

/**
 * On mount or on becoming visible: a pending reply is implied when the
 * latest real message is the athlete's and it is under the timeout.
 */
export function pendingFromMessages(
  list: ChatMessage[],
  now: number
): PendingState | null {
  let last: ChatMessage | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.ephemeral || (m.pending && m.content === "")) continue;
    last = m;
    break;
  }
  if (!last || last.role !== "user") return null;
  const since = Date.parse(last.timestamp);
  if (!Number.isFinite(since)) return null;
  if (now - since >= PENDING_TIMEOUT_MS) return null;
  return { userMessageId: last.id, since };
}

/** True once the saved reply is in the list (realtime or hydration). */
export function isPendingResolved(
  list: ChatMessage[],
  pending: PendingState
): boolean {
  const from =
    pending.userMessageId === null
      ? 0
      : list.findIndex((m) => m.id === pending.userMessageId) + 1;
  return list
    .slice(from)
    .some(
      (m) =>
        m.role === "assistant" &&
        !m.pending &&
        !m.ephemeral &&
        m.content.trim() !== ""
    );
}

/**
 * Timeout or error while waiting: placeholders go, a local-only notice
 * takes their place, and the athlete can send again.
 */
export function applyNotice(
  list: ChatMessage[],
  now: number,
  noticeId: string,
  text: string = TIMEOUT_NOTICE
): ChatMessage[] {
  const out = list.filter((m) => !m.pending);
  out.push({
    id: noticeId,
    role: "assistant",
    content: text,
    timestamp: new Date(now).toISOString(),
    ephemeral: true,
  });
  return out;
}

/** What goes back to the server as history. */
export function toHistory(
  list: ChatMessage[]
): Array<{ role: "user" | "assistant"; content: string }> {
  return list
    .filter((m) => !m.ephemeral && !m.pending && m.content.trim() !== "")
    .map((m) => ({ role: m.role, content: m.content }));
}

/** Milliseconds until the pending reply times out (0 if already past). */
export function timeoutDelay(pending: PendingState, now: number): number {
  return Math.max(0, pending.since + PENDING_TIMEOUT_MS - now);
}
