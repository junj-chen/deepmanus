/**
 * Agent service: the ONLY place that talks to the AG-UI run endpoint.
 *
 * The backend `POST /agents/main` returns an SSE stream (`text/event-stream`)
 * of AG-UI protocol events, one per `data: {...}\n\n` frame. Because it is a
 * POST (not GET) we cannot use EventSource — we drive a `fetch` +
 * ReadableStream reader and parse the frames ourselves.
 *
 * Views never call this directly; they go through ChatStore actions.
 */

/**
 * Run one agent turn and dispatch every AG-UI event to `onEvent`.
 *
 * @param {object}   opts
 * @param {string}   opts.sessionId  stable thread id (checkpointer key)
 * @param {string}   opts.text       the user's message text
 * @param {AbortSignal} [opts.signal] aborts the stream (stop button)
 * @param {(evt: object) => void} [opts.onEvent] called per AG-UI frame
 * @param {() => void}            [opts.onDone]  stream ended cleanly
 * @param {(err: Error) => void}  [opts.onError] network / parse failure
 * @returns {Promise<void>}
 */
export async function streamAgent({
  sessionId,
  text,
  signal,
  onEvent,
  onDone,
  onError,
}) {
  let res;
  try {
    res = await fetch("/agents/main", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // the backend reads this to pin the checkpointer thread
        "x-session-id": sessionId,
      },
      body: JSON.stringify({
        sessionId,
        run_id: `run-${Date.now()}`,
        messages: [{ id: `u-${Date.now()}`, role: "user", content: text }],
      }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") return; // user pressed stop
    onError?.(e);
    return;
  }

  if (!res.ok || !res.body) {
    onError?.(new Error(`agent stream failed: ${res.status}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const evt = parseFrame(frame);
        if (evt) onEvent?.(evt);
      }
    }
    onDone?.();
  } catch (e) {
    if (e.name === "AbortError") return; // graceful stop
    onError?.(e);
  }
}

/**
 * Pull the first `data:` line out of an SSE frame and JSON-parse it.
 * Returns null for comments / heartbeats / malformed frames.
 */
function parseFrame(frame) {
  const dataLine = frame
    .split("\n")
    .find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Subscribe to a RUNNING single-agent (subagent) session's live SSE stream.
 *
 * Connects via EventSource to GET /sessions/:id/stream (the subagent stream
 * produced by single_runner). Each AG-UI frame → onEvent; stream end → onDone.
 * Returns a handle whose .dispose() closes the connection.
 *
 * Used to watch a delegated coder/researcher work in real time after the
 * default agent dispatches to it.
 *
 * @param {string} sessionId
 * @param {{onEvent?: (e: object) => void, onDone?: () => void, onError?: (e: unknown) => void}} [opts]
 */
export function subscribeSession(sessionId, { onEvent, onDone, onError } = {}) {
  const es = new EventSource(`/sessions/${encodeURIComponent(sessionId)}/stream`);
  es.onmessage = (ev) => {
    if (ev.data === "[DONE]") {
      onDone?.();
      es.close();
      return;
    }
    try {
      const payload = JSON.parse(ev.data);
      onEvent?.(payload);
    } catch {
      /* ignore malformed frames */
    }
  };
  es.onerror = (e) => {
    onError?.(e);
  };
  return { es, dispose: () => es.close() };
}
