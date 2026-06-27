import { useEffect } from "react";
import { useCopilotChatHeadless_c } from "@copilotkit/react-core";

import { useStore } from "./useStore";

/**
 * useChat — the single hook for self-rendered chat.
 *
 * Wraps CopilotKit's headless chat API (messages + sendMessage + isLoading)
 * and ties it to the active session: when the session id changes, we clear
 * CopilotKit's message list so the new conversation starts clean (the backend
 * keeps history per-thread via the x-session-id header).
 *
 * Also flattens CopilotKit message objects into a simple render shape
 * ({ role, text, toolCalls }) so <ChatMessages> stays framework-agnostic.
 */
export function useChat() {
  const { sessions } = useStore();
  const { messages, sendMessage, isLoading, setMessages } =
    useCopilotChatHeadless_c();

  const activeId = sessions.activeId;

  // Clear the chat when switching sessions (the provider is keyed by activeId
  // in providers.jsx, which already remounts; this is a belt-and-suspenders
  // reset for the message list).
  useEffect(() => {
    setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Flatten CopilotKit messages into a render-friendly list.
  const items = messages.map((m) => ({
    id: m.id,
    role: m.role, // "user" | "assistant"
    text: extractText(m.content),
    toolCalls: extractToolCalls(m),
  }));

  return { items, sendMessage, isLoading };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p?.type === "text") return p.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

function extractToolCalls(message) {
  // CopilotKit assistant messages may carry toolCalls (array) on the message
  // object, and matching tool results as separate "tool" role messages.
  const calls = message?.toolCalls || message?.tool_calls || [];
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.name || tc.toolName,
    args: tc.arguments || tc.args,
    // result is typically on a follow-up tool-role message; left null here,
    // ChatMessages joins them by id.
    result: null,
  }));
}
