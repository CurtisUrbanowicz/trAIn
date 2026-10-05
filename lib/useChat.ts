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

export function useChat(tab: string, enabled = true, autoOpen = true) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [hydrating, setHydrating] = useState(false);
  // A reply is pending: dots, locked input, 5-minute timeout. Survives the
  // stream dying — the saved row arrives via realtime and resolves it.
  const [pending, setPendingState] = useState<PendingState | null>(null);
  // Code-generated line shown while a tool runs ("pulling up your runs…")
  const [status, setStatus] = useState<string | null>(null);
  const [openerStarted, setOpenerStarted] = useState(false);
  const openerRef = useRef(false);
  const isOpenerStream = useRef(false);
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
   * If the stream dies without done/error (app backgrounded, network
   * drop), the server still finishes: we keep waiting for the saved row.
   */
  const runTurn = useCallback(
    async (body: {
      message: string;
      userMessageId: string | null;
      history: Array<{ role: "user" | "assistant"; content: string }>;
    }) => {
      const ph = placeholder();
      let replyId = ph.id;
      let ended = false;
      setMessages((prev) => upsertMessage(prev, ph));

      const fail = () => {
        ended = true;
        setStatus(null);
        setMessages((prev) => applyNotice(prev, Date.now(), `local-${newId()}`));
        setPending(null);
      };

      let sawText = false;
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
          if (!sawText) {
            sawText = true;
            if (isOpenerStream.current) {
              setOpenerStarted(true);
              window.dispatchEvent(new Event("opener-started"));
            }
          }
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

  // Mount — hydrate from Supabase first, waits for enabled
  useEffect(() => {
    if (!enabled) return;
    if (openerRef.current) return;
    openerRef.current = true;

    void (async () => {
      setHydrating(true);
      try {
        const saved = await fetchSaved();

        if (saved && saved.length > 0) {
          // Hydrate from persisted messages — skip opener
          mergeSaved(saved);
          watchIfUnanswered(saved);
          setOpenerStarted(true);
          window.dispatchEvent(new Event("opener-started"));
          return;
        }

        // No existing messages — only fire auto-opener if autoOpen is true
        if (!autoOpen) {
          setOpenerStarted(true);
          window.dispatchEvent(new Event("opener-started"));
          return;
        }

        isOpenerStream.current = true;
        setPending({ userMessageId: null, since: Date.now() });
        await runTurn({ message: "", userMessageId: null, history: [] });
        isOpenerStream.current = false;
      } catch (err) {
        isOpenerStream.current = false;
        console.error(err);
      } finally {
        setOpenerStarted(true);
        window.dispatchEvent(new Event("opener-started"));
        setHydrating(false);
      }
    })();
  }, [tab, enabled, autoOpen, fetchSaved, mergeSaved, watchIfUnanswered, runTurn, setPending]);

  // Back in the foreground: re-fetch in case realtime missed an insert
  // while backgrounded, and resume waiting for an unanswered message
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, fetchSaved, mergeSaved, watchIfUnanswered]);

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

  return { messages, input, setInput, sendMessage, loading, status, openerStarted };
}
