"use client";

import { useEffect, useRef } from "react";
import { useChat } from "@/lib/useChat";

export default function CoachPage() {
  const { messages, input, setInput, sendMessage, loading, thinking } =
    useChat("coach");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
  }, [messages, thinking]);

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`mb-2 max-w-[85%] rounded px-3 py-2 ${
              m.role === "user"
                ? "ml-auto bg-blue-100 text-right"
                : "mr-auto bg-gray-100 text-left"
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
          </div>
        ))}
        {thinking ? (
          <div className="mb-2 max-w-[85%] mr-auto rounded px-3 py-2 bg-gray-50 text-left">
            <p className="whitespace-pre-wrap break-words italic text-gray-400">
              {thinking}
            </p>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      <div className="flex flex-row items-center gap-2 border-t border-gray-200 p-3">
        <input
          type="text"
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button
          type="button"
          className="shrink-0 rounded bg-gray-800 px-4 py-2 text-white disabled:opacity-50"
          onClick={() => void sendMessage()}
          disabled={loading}
        >
          Send
        </button>
        {loading ? (
          <span className="shrink-0 text-sm text-gray-500">thinking...</span>
        ) : null}
      </div>
    </div>
  );
}
