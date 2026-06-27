/**
 * Team service: the ONLY place that talks to the team backend endpoints.
 * Views go through store actions -> these functions.
 */

/** Load a team's group-chat history. */
export async function getTeamMessages(teamId) {
  const res = await fetch(`/teams/${encodeURIComponent(teamId)}/messages`);
  if (!res.ok) throw new Error(`getTeamMessages: ${res.status}`);
  return res.json();
}

/** Post a user message into a team (optionally @-mentioning an agent). */
export async function postTeamMessage(teamId, { content, targetAgent = null }) {
  const res = await fetch(`/teams/${encodeURIComponent(teamId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      speaker: "user",
      target_agent: targetAgent,
    }),
  });
  if (!res.ok) throw new Error(`postTeamMessage: ${res.status}`);
  return res.json();
}

/**
 * Subscribe to a team's live SSE stream of group messages + agent events.
 * Returns an object with the EventSource and a disposer.
 *
 * onGroup:  (msg) => void   — a GROUP_MESSAGE event {speaker, content, ...}
 * onFrame:  (rawData) => void — any other AG-UI frame (tool calls, etc.)
 * onDone:   () => void        — the team finished
 */
export function subscribeTeam(teamId, { onGroup, onFrame, onDone, onError }) {
  const es = new EventSource(`/teams/${encodeURIComponent(teamId)}/stream`);

  es.onmessage = (ev) => {
    if (ev.data === "[DONE]") {
      onDone?.();
      es.close();
      return;
    }
    try {
      const payload = JSON.parse(ev.data);
      if (payload.type === "GROUP_MESSAGE") {
        onGroup?.(payload);
      } else {
        onFrame?.(payload);
      }
    } catch {
      onFrame?.(ev.data);
    }
  };

  es.onerror = (e) => {
    onError?.(e);
  };

  return {
    es,
    dispose: () => es.close(),
  };
}
