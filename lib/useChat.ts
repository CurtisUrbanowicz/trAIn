"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const THINKING_DELIMITER = "\x00THINKING\x00";
const FINAL_DELIMITER = "\x00FINAL\x00";

function getLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

export type Message = {
  role: "user" | "assistant";
  content: string;
};

export function useChat(tab: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState<string | null>(null);
  const openerRef = useRef(false);

  const updateLastAssistant = useCallback((content: string) => {
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

  // Auto-opener on mount
  useEffect(() => {
    if (openerRef.current) return;
    openerRef.current = true;

    void (async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "",
            localDate: getLocalDate(),
            tab,
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
    })();
  }, [tab, processStream]);

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

  return { messages, input, setInput, sendMessage, loading, thinking };
}
