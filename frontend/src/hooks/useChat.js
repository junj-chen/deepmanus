import { useStore } from "./useStore";

/**
 * useChat — view-layer adapter over ChatStore.
 *
 * ChatStore is driven by AG-UI events from `POST /agents/main` (no CopilotKit).
 * This hook just hands the active session id + store state to the view.
 *
 * send() is wrapped: if there's no active session yet, it creates one first,
 * THEN sends — so the first message in a fresh app boot materializes a
 * default conversation. Each default conversation is its own bounded thread;
 * the user starts new ones via the + button (sessions.newConversation).
 */
export function useChat() {
  const { chat, sessions } = useStore();

  const send = async (text) => {
    // Ensure there is an active default conversation before sending.
    const sessionId = sessions.activeId || (await sessions.create()).id;
    await chat.send(sessionId, text);
  };

  return {
    items: chat.items,
    isLoading: chat.isRunning,
    isLoadingHistory: chat.isLoadingHistory,
    error: chat.error,
    sessionId: sessions.activeId,
    send,
    stop: () => chat.stop(),
  };
}
