"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

const ATHLETE_ID = "bc1c4cd0-a69a-4317-9b46-f7072d3bd886";

function getLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

function getLocalTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export function useChat(tab: string, enabled = true, autoOpen = true) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Code-generated line shown while a tool runs ("pulling up your runs…")
  const [status, setStatus] = useState<string | null>(null);
  const [openerStarted, setOpenerStarted] = useState(false);
  const openerRef = useRef(false);
  const isOpenerStream = useRef(false);

  const appendToLastAssistant = useCallback((delta: string) => {
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = { ...last, content: last.content + delta };
      }
      return updated;
    });
  }, []);

  const processStream = useCallback(
    async (response: Response) => {
      // Add empty assistant message placeholder
      setMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: "" },
      ]);

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      // NDJSON from /api/chat, one frame per line:
      //   {"t":"text","v"}   reply text — appended to the bubble
      //   {"t":"status","v"} tool status line — shown in the dimmed slot
      //   {"t":"done"}        end of turn
      // Chunks can split mid-line, so lines are buffered.
      const decoder = new TextDecoder();
      let buffer = "";
      let sawText = false;

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let frame: { t?: string; v?: unknown };
        try {
          frame = JSON.parse(line);
        } catch {
          console.error("[useChat] bad stream frame:", line);
          return;
        }
        if (frame.t === "text" && typeof frame.v === "string") {
          if (!sawText) {
            sawText = true;
            if (isOpenerStream.current) {
              setOpenerStarted(true);
              window.dispatchEvent(new Event("opener-started"));
            }
          }
          // Text after a tool call means the tool is done
          setStatus(null);
          appendToLastAssistant(frame.v);
        } else if (frame.t === "status" && typeof frame.v === "string") {
          setStatus(frame.v);
        } else if (frame.t === "done") {
          setStatus(null);
        }
      };

      try {
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
      } finally {
        setStatus(null);
        // A turn that produced no text leaves an empty placeholder; drop it
        // so it never goes back out as history (the catch paths do the same)
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last && last.role === "assistant" && !last.content
            ? prev.slice(0, -1)
            : prev;
        });
      }
    },
    [appendToLastAssistant]
  );

  // Auto-opener — hydrate from Supabase first, waits for enabled
  useEffect(() => {
    if (!enabled) return;
    if (openerRef.current) return;
    openerRef.current = true;

    void (async () => {
      setLoading(true);
      try {
        // Check for existing messages today for this tab
        const localDate = getLocalDate();
        const { data: saved } = await supabase
          .from("messages")
          .select("role, content")
          .eq("athlete_id", ATHLETE_ID)
          .eq("date", localDate)
          .eq("tab", tab)
          .order("timestamp", { ascending: true });

        if (saved && saved.length > 0) {
          // Hydrate from persisted messages — skip opener
          const hydrated: Message[] = saved
            .filter((m: { role: string; content: string }) => m.content.trim() !== "")
            .map((m: { role: string; content: string }) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }));
          setMessages(hydrated);
          setOpenerStarted(true);
          window.dispatchEvent(new Event("opener-started"));
          setLoading(false);
          return;
        }

        // No existing messages — only fire auto-opener if autoOpen is true
        if (!autoOpen) {
          setOpenerStarted(true);
          window.dispatchEvent(new Event("opener-started"));
          setLoading(false);
          return;
        }

        isOpenerStream.current = true;
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "",
            localDate,
            localTime: getLocalTime(),
            tab,
          }),
        });
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        await processStream(response);
        isOpenerStream.current = false;
      } catch (err) {
        isOpenerStream.current = false;
        setOpenerStarted(true);
        window.dispatchEvent(new Event("opener-started"));
        setStatus(null);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
        console.error(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, enabled, autoOpen, processStream]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;

    const userMessage = input.trim();
    const currentHistory = [...messages];

    setMessages((prev) => [
      ...prev,
      { role: "user" as const, content: userMessage },
    ]);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          localDate: getLocalDate(),
          localTime: getLocalTime(),
          tab,
          history: currentHistory,
        }),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      await processStream(response);
    } catch (err) {
      setStatus(null);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && !last.content) {
          return prev.slice(0, -1);
        }
        return prev;
      });
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, tab, processStream]);

  return { messages, input, setInput, sendMessage, loading, status, openerStarted };
}
