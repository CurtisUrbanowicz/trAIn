"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";
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
  const [thinking, setThinking] = useState<string | null>(null);
  const [openerStarted, setOpenerStarted] = useState(false);
  const openerRef = useRef(false);
  const isOpenerStream = useRef(false);

  const updateLastAssistant = useCallback((content: string) => {
    if (content && isOpenerStream.current) {
      setOpenerStarted(true);
      window.dispatchEvent(new Event("opener-started"));
    }
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.role === "assistant") {
        updated[updated.length - 1] = { ...last, content };
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

      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });

        const thinkIdx = fullText.indexOf(THINKING_DELIMITER);
        const finalIdx = fullText.indexOf(FINAL_DELIMITER);

        if (finalIdx !== -1) {
          // Final mode — clear thinking, stream final text into message
          setThinking(null);
          updateLastAssistant(
            fullText.slice(finalIdx + FINAL_DELIMITER.length)
          );
        } else if (thinkIdx !== -1) {
          // Thinking mode — combine text before and after THINKING delimiter
          const before = fullText.slice(0, thinkIdx);
          const after = fullText.slice(
            thinkIdx + THINKING_DELIMITER.length
          );
          setThinking(before + after);
          updateLastAssistant("");
        } else {
          // Normal mode — no delimiters, stream into message
          updateLastAssistant(fullText);
        }
      }

      // Edge case: THINKING sent but FINAL never arrived
      if (
        fullText.indexOf(THINKING_DELIMITER) !== -1 &&
        fullText.indexOf(FINAL_DELIMITER) === -1
      ) {
        setThinking(null);
        const ti = fullText.indexOf(THINKING_DELIMITER);
        updateLastAssistant(
          fullText.slice(0, ti) +
            fullText.slice(ti + THINKING_DELIMITER.length)
        );
      }
    },
    [updateLastAssistant]
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
        setThinking(null);
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
      setThinking(null);
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

  return { messages, input, setInput, sendMessage, loading, thinking, openerStarted };
}
