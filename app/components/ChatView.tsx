"use client";

import { useEffect, useRef, useCallback } from "react";
import { useChat, type Message } from "@/lib/useChat";
import { ArrowUp } from "lucide-react";

interface ChatViewProps {
  tab: string;
  children?: React.ReactNode;
  enabled?: boolean;
  autoOpen?: boolean;
}

export default function ChatView({
  tab,
  children,
  enabled = true,
  autoOpen = true,
}: ChatViewProps) {
  const { messages, input, setInput, sendMessage, loading, thinking } =
    useChat(tab, enabled, autoOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "instant",
    });
  }, [messages, thinking]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    resizeTextarea();
  };

  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input]);

  const lastMsg = messages[messages.length - 1];
  const isStreaming =
    loading && !thinking && lastMsg?.role === "assistant";
  const hasInput = input.trim().length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {children && (
        <div
          className="shrink-0 px-4 pt-4"
          style={{ borderBottom: "0.5px solid var(--border-default)" }}
        >
          {children}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((msg, i) => {
          const prev: Message | undefined = messages[i - 1];
          const sameSender = prev?.role === msg.role;
          const isUser = msg.role === "user";
          const isLastStreaming = isStreaming && i === messages.length - 1;

          if (msg.role === "assistant" && !msg.content && thinking) return null;
          if (!msg.content) return null;

          return (
            <div
              key={i}
              style={{ marginTop: i === 0 ? 0 : sameSender ? 4 : 10 }}
              className={isUser ? "flex justify-end" : "flex justify-start"}
            >
              <div
                style={{
                  maxWidth: "85%",
                  padding: "10px 14px",
                  fontSize: isUser ? 14 : 15,
                  lineHeight: 1.42,
                  letterSpacing: isUser ? "0" : "-0.003em",
                  fontFamily: isUser
                    ? "var(--font-inter)"
                    : "var(--font-serif)",
                  color: "var(--text-primary)",
                  opacity: isLastStreaming ? 0.7 : 1,
                  background: isUser
                    ? "var(--bg-athlete-bubble)"
                    : "var(--bg-coach-bubble)",
                  border: isUser
                    ? "0.5px solid var(--border-athlete-bubble)"
                    : "0.5px solid var(--border-default)",
                  borderRadius: isUser
                    ? "18px 18px 4px 18px"
                    : "18px 18px 18px 4px",
                }}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          );
        })}

        {thinking && (
          <div style={{ marginTop: 10 }} className="flex justify-start">
            <div
              style={{
                maxWidth: "85%",
                padding: "10px 14px",
                fontSize: 15,
                lineHeight: 1.42,
                letterSpacing: "-0.003em",
                fontFamily: "var(--font-serif)",
                color: "var(--text-primary)",
                opacity: 0.5,
                background: "var(--bg-coach-bubble)",
                border: "0.5px solid var(--border-default)",
                borderRadius: "18px 18px 18px 4px",
              }}
            >
              <p className="whitespace-pre-wrap break-words italic">
                {thinking}
              </p>
            </div>
          </div>
        )}
      </div>

      <div
        className="shrink-0 flex items-center gap-2"
        style={{
          padding: "8px 12px calc(8px + env(safe-area-inset-bottom))",
          background: "var(--bg-base)",
          borderTop: "0.5px solid var(--border-default)",
        }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          disabled={loading}
          placeholder="Message..."
          rows={1}
          className="flex-1 resize-none outline-none"
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            border: "0.5px solid var(--border-default)",
            borderRadius: 999,
            padding: "10px 16px",
            maxHeight: 120,
            fontFamily: "var(--font-inter)",
          }}
        />
        <button
          type="button"
          onClick={() => void sendMessage()}
          disabled={loading || !hasInput}
          className="shrink-0 flex items-center justify-center"
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: hasInput ? "var(--accent)" : "var(--bg-surface)",
            color: hasInput ? "white" : "var(--text-muted)",
            transition: "background 150ms, color 150ms, opacity 150ms",
            opacity: hasInput ? 1 : 0.6,
          }}
        >
          <ArrowUp size={20} />
        </button>
      </div>
    </div>
  );
}
