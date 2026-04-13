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

export default function ChatView({ tab, children, enabled = true, autoOpen = true }: ChatViewProps) {
  const { messages, input, setInput, sendMessage, loading, thinking } =
    useChat(tab, enabled, autoOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages, streaming, or thinking
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "instant",
    });
  }, [messages, thinking]);

  // Auto-resize textarea
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

  // Reset textarea height after send
  useEffect(() => {
    if (!input && textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input]);

  // Determine if the last assistant message is actively streaming
  const lastMsg = messages[messages.length - 1];
  const isStreaming =
    loading && !thinking && lastMsg?.role === "assistant";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Sticky children slot */}
      {children && (
        <div
          className="shrink-0 px-4 pt-4"
          style={{ borderBottom: "0.5px solid var(--border-default)" }}
        >
          {children}
        </div>
      )}

      {/* Message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.map((msg, i) => {
          const prev: Message | undefined = messages[i - 1];
          const sameSender = prev?.role === msg.role;
          const isUser = msg.role === "user";
          const isLastStreaming =
            isStreaming && i === messages.length - 1;

          // Skip empty assistant placeholders while thinking
          if (msg.role === "assistant" && !msg.content && thinking) {
            return null;
          }
          // Skip empty messages
          if (!msg.content) return null;

          return (
            <div
              key={i}
              style={{ marginTop: i === 0 ? 0 : sameSender ? 4 : 16 }}
              className={isUser ? "flex justify-end" : "flex justify-start"}
            >
              <div
                style={{
                  maxWidth: "80%",
                  padding: "12px 16px",
                  fontSize: "15px",
                  lineHeight: 1.5,
                  color: "var(--text-primary)",
                  opacity: isLastStreaming ? 0.7 : 1,
                  background: isUser
                    ? "var(--bg-athlete-bubble)"
                    : "var(--bg-coach-bubble)",
                  borderRadius: isUser
                    ? "16px 16px 4px 16px"
                    : "16px 16px 16px 4px",
                }}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            </div>
          );
        })}

        {/* Thinking bubble */}
        {thinking && (
          <div
            style={{ marginTop: 16 }}
            className="flex justify-start"
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "12px 16px",
                fontSize: "15px",
                lineHeight: 1.5,
                color: "var(--text-primary)",
                opacity: 0.5,
                background: "var(--bg-coach-bubble)",
                borderRadius: "16px 16px 16px 4px",
              }}
            >
              <p className="whitespace-pre-wrap break-words italic">
                {thinking}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div
        className="shrink-0 flex items-end gap-2"
        style={{
          padding: "8px 12px",
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
            fontSize: "15px",
            lineHeight: 1.5,
            color: "var(--text-primary)",
            background: "var(--bg-surface)",
            borderRadius: "8px",
            padding: "10px 12px",
            maxHeight: "120px",
          }}
        />
        {input.trim() && (
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={loading}
            className="shrink-0 flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--bg-surface)",
              marginBottom: 2,
            }}
          >
            <ArrowUp size={20} style={{ color: "var(--accent)" }} />
          </button>
        )}
      </div>
    </div>
  );
}
