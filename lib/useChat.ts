"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRealtimeInsert } from "@/lib/useRealtimeInsert";
import {
  type ChatMessage,
  type PendingState,
  appendText,
  applyNotice,
  dropEmptyPlaceholders,
  finishPlaceholder,
  isPendingResolved,
  pendingFromMessages,
  retargetId,
  timeoutDelay,
  toHistory,
  upsertMessage,
} from "@/lib/chat-state";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

export type Message = ChatMessage;

function getLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

function getLocalTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// crypto.randomUUID needs a secure context; http over the LAN gets v4 by hand
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type SavedRow = { id: string; role: string; content: string; timestamp: string };

function rowToMessage(r: SavedRow): ChatMessage {
  return {
    id: r.id,
    role: r.role === "user" ? "user" : "assistant",
    content: r.content,
    timestamp: r.timestamp,
  };
}

function placeholder(): ChatMessage {
  return {
    id: `pending-${newId()}`,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    pending: true,
  };
}

/**
 * Chat state for one tab. Saved messages hydrate on mount, unconditionally.
 * With none for today and `autoOpen` on, an opener is expected: typing dots
 * show and the input locks from hydration until the reply lands, and the
 * opener request itself fires once `openerEnabled` is true (Today holds it
 * until /api/summarise has finished — the opener reads yesterday's summary).
 */
export function useChat(tab: string, openerEnabled = true, autoOpen = true) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [hydrating, setHydrating] = useState(false);
  // A reply is pending: dots, locked input, 5-minute timeout. Survives the
  // stream dying — the saved row arrives via realtime and resolves it.
  const [pending, setPendingState] = useState<PendingState | null>(null);
  // Code-generated line shown while a tool runs ("pulling up your runs…")
  const [status, setStatus] = useState<string | null>(null);
  // Hydration found no saved messages and autoOpen is on: the opener is
  // due, and fires once openerEnabled allows
  const [openerDue, setOpenerDue] = useState(false);
  const hydratedRef = useRef(false);
  const openerFiredRef = useRef(false);
  // The dots bubble shown from hydration; the opener turn streams into it
  const openerPlaceholderRef = useRef<ChatMessage | null>(null);
  const pendingRef = useRef<PendingState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPending = useCallback((p: PendingState | null) => {
    pendingRef.current = p;
    setPendingState(p);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    if (!p) return;
    // Counts from the user message, so a reopen inherits the remaining time
    timeoutRef.current = setTimeout(() => {
      if (pendingRef.current !== p) return;
      timeoutRef.current = null;
      pendingRef.current = null;
      setPendingState(null);
      setStatus(null);
      setMessages((prev) => applyNotice(prev, Date.now(), `local-${newId()}`));
    }, timeoutDelay(p, Date.now()));
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const fetchSaved = useCallback(async (): Promise<ChatMessage[] | null> => {
    const { data, error } = await supabase
      .from("messages")
      .select("id, role, content, timestamp")
      .eq("athlete_id", ATHLETE_ID)
      .eq("date", getLocalDate())
      .eq("tab", tab)
      .order("timestamp", { ascending: true });
    if (error || !data) return null;
    return (data as SavedRow[])
      .filter((r) => r.content.trim() !== "")
      .map(rowToMessage);
  }, [tab]);

  const mergeSaved = useCallback((rows: ChatMessage[]) => {
    setMessages((prev) => rows.reduce((acc, r) => upsertMessage(acc, r), prev));
  }, []);

  // Realtime: every saved message for this athlete; keep this tab, today.
  // The saved row is canonical — it replaces the streamed placeholder by id.
  const onMessageInsert = useCallback(
    (row: Record<string, unknown>) => {
      if (row.tab !== tab || row.date !== getLocalDate()) return;
      if (
        typeof row.id !== "string" ||
        typeof row.role !== "string" ||
        typeof row.content !== "string" ||
        typeof row.timestamp !== "string"
      ) {
        return;
      }
      if (row.content.trim() === "") return;
      setMessages((prev) => upsertMessage(prev, rowToMessage(row as SavedRow)));
    },
    [tab]
  );
  useRealtimeInsert(
    `chat-messages-${tab}`,
    "messages",
    onMessageInsert,
    `athlete_id=eq.${ATHLETE_ID}`
  );

  // Once the saved reply is in the list, the wait is over
  useEffect(() => {
    if (pending && isPendingResolved(messages, pending)) {
      setPending(null);
      setStatus(null);
      setMessages((prev) => dropEmptyPlaceholders(prev));
    }
  }, [messages, pending, setPending]);

  // Reopen mid-turn: the latest message is the athlete's, no reply yet,
  // under 5 minutes old — show dots and wait for the saved row
  const watchIfUnanswered = useCallback(
    (saved: ChatMessage[]) => {
      if (pendingRef.current) return;
      const p = pendingFromMessages(saved, Date.now());
      if (!p) return;
      setPending(p);
      setMessages((prev) => upsertMessage(prev, placeholder()));
    },
    [setPending]
  );

  /**
   * One turn against /api/chat. NDJSON frames, one per line:
   *   {"t":"start","id"}  the reply's message id — the placeholder takes it
   *   {"t":"text","v"}    reply text, appended to the placeholder
   *   {"t":"status","v"}  tool status line, shown in the dimmed slot
   *   {"t":"done"}        end of turn
   *   {"t":"error"}       the turn failed while we were connected
   *   {"t":"held"}        opener only: an earlier request is already
   *                       running it — no turn; wait for the saved reply
   * If the stream dies without done/error (app backgrounded, network
   * drop), the server still finishes: we keep waiting for the saved row.
   * `into` is an existing placeholder to stream into (the opener's dots
   * bubble, shown since hydration); otherwise a new one is added.
   */
  const runTurn = useCallback(
    async (
      body: {
        message: string;
        userMessageId: string | null;
        history: Array<{ role: "user" | "assistant"; content: string }>;
      },
      into?: ChatMessage
    ) => {
      const ph = into ?? placeholder();
      let replyId = ph.id;
      let ended = false;
      setMessages((prev) => upsertMessage(prev, ph));

      const fail = () => {
        ended = true;
        setStatus(null);
        setMessages((prev) => applyNotice(prev, Date.now(), `local-${newId()}`));
        setPending(null);
      };

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let frame: { t?: string; v?: unknown; id?: unknown };
        try {
          frame = JSON.parse(line);
        } catch {
          console.error("[useChat] bad stream frame:", line);
          return;
        }
        if (frame.t === "start" && typeof frame.id === "string") {
          const from = replyId;
          replyId = frame.id;
          setMessages((prev) => retargetId(prev, from, frame.id as string));
        } else if (frame.t === "text" && typeof frame.v === "string") {
          // Text after a tool call means the tool is done
          setStatus(null);
          const v = frame.v;
          setMessages((prev) => appendText(prev, replyId, v));
        } else if (frame.t === "status" && typeof frame.v === "string") {
          setStatus(frame.v);
        } else if (frame.t === "done") {
          ended = true;
          setStatus(null);
          setMessages((prev) => finishPlaceholder(prev, replyId));
          setPending(null);
        } else if (frame.t === "error") {
          fail();
        } else if (frame.t === "held") {
          // Another request — an earlier mount of this tab — is running
          // this opener. Keep the dots: the saved reply arrives via
          // realtime, or the fetch in finally finds it already there.
          console.log("[useChat] opener held by an earlier request");
        }
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: body.message,
            localDate: getLocalDate(),
            localTime: getLocalTime(),
            tab,
            history: body.history,
            userMessageId: body.userMessageId ?? undefined,
          }),
        });
        if (!response.ok) {
          // Rejected before the turn started: nothing to wait for
          console.error(`[useChat] API error: ${response.status}`);
          fail();
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          fail();
          return;
        }
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
          }
        }
        buffer += decoder.decode();
        if (buffer) handleLine(buffer);
      } catch (err) {
        // Connection lost mid-turn — the turn is still running server-side
        console.error("[useChat] stream ended early:", err);
      } finally {
        setStatus(null);
        if (!ended) {
          // The reply may already be saved; otherwise realtime delivers it
          // and the 5-minute timeout covers the rest
          const saved = await fetchSaved();
          if (saved) mergeSaved(saved);
        }
      }
    },
    [tab, fetchSaved, mergeSaved, setPending]
  );

  // Mount — hydrate from Supabase at once. Nothing here waits on the
  // caller: saved messages show immediately, and an expected opener shows
  // its dots immediately.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    void (async () => {
      setHydrating(true);
      try {
        const saved = await fetchSaved();

        if (saved && saved.length > 0) {
          mergeSaved(saved);
          watchIfUnanswered(saved);
          return;
        }

        // No messages today. Only an auto-opening tab starts a turn.
        if (!autoOpen) return;

        // Opener expected: dots and a locked input from now until the
        // reply lands — through the openerEnabled wait and the turn
        const ph = placeholder();
        openerPlaceholderRef.current = ph;
        setPending({ userMessageId: null, since: Date.now() });
        setMessages((prev) => upsertMessage(prev, ph));
        setOpenerDue(true);
      } catch (err) {
        console.error(err);
      } finally {
        setHydrating(false);
      }
    })();
  }, [autoOpen, fetchSaved, mergeSaved, watchIfUnanswered, setPending]);

  // The opener request: once due, and once the caller allows it. One per
  // mount here; one per day and tab server-side (the claim in /api/chat —
  // a remount mid-opener is told "held" and waits for the saved reply).
  useEffect(() => {
    if (!openerDue || !openerEnabled || openerFiredRef.current) return;
    openerFiredRef.current = true;
    void runTurn(
      { message: "", userMessageId: null, history: [] },
      openerPlaceholderRef.current ?? undefined
    ).catch((err) => console.error(err));
  }, [openerDue, openerEnabled, runTurn]);

  // Back in the foreground: re-fetch in case realtime missed an insert
  // while backgrounded, and resume waiting for an unanswered message
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void (async () => {
        const saved = await fetchSaved();
        if (!saved) return;
        mergeSaved(saved);
        watchIfUnanswered(saved);
      })();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchSaved, mergeSaved, watchIfUnanswered]);

  const loading = hydrating || pending !== null;

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    const userMessageId = newId();
    const now = Date.now();
    const history = toHistory(messages);

    setMessages((prev) =>
      upsertMessage(prev, {
        id: userMessageId,
        role: "user",
        content: userMessage,
        timestamp: new Date(now).toISOString(),
      })
    );
    setInput("");
    setPending({ userMessageId, since: now });

    await runTurn({ message: userMessage, userMessageId, history });
  }, [input, loading, messages, runTurn, setPending]);

  return { messages, input, setInput, sendMessage, loading, status };
}
