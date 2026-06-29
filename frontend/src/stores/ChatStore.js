import { makeAutoObservable, runInAction } from "mobx";

import { streamAgent, subscribeSession } from "@/services/agentService";
import { getSession } from "@/services/sessionService";

/**
 * ChatStore owns the single-agent conversation view.
 *
 * It is driven ENTIRELY by AG-UI events arriving from `POST /agents/main`
 * (via streamAgent in agentService). There is no CopilotKit anywhere.
 *
 * RENDER MODEL — a flat timeline, one item per event segment, IN ORDER:
 *
 *   items: [
 *     { kind:'user',          id, text }                      // user bubble
 *     { kind:'assistant-text', id, text, streaming? }         // text segment
 *     { kind:'tool',          id, name, args, result?, streaming? } // tool call
 *     { kind:'assistant-text', id, text, streaming? }         // more text
 *     ...
 *   ]
 *
 * Why flat: deepagents interleaves text → tool → text → tool as it works.
 * Folding all text into one bubble (the old model) collapsed that order, so
 * text piled on top while tools slid below. A flat list keeps the real
 * sequence: each tool call renders right under the text that preceded it,
 * and the post-tool text renders under the tool.
 *
 * Every mutation uses immutable index replacement (mobx tracks array-index
 * reassignment unconditionally; in-place property writes were not reliably
 * triggering observers).
 *
 * Views call actions here; never the service directly.
 */
export class ChatStore {
  // Flat render timeline. See file header for item shape.
  items = [];
  // true while an agent turn is streaming
  isRunning = false;
  // last error message, if any
  error = null;
  // AbortController for the in-flight stream (so `stop()` can cancel it)
  _abort = null;
  // messageId the backend is currently streaming text under (reused across a
  // whole run; tracked only to detect TEXT_MESSAGE_END vs spurious deltas)
  _textMessageId = null;
  // id of the session whose history is currently loaded into `items`; used to
  // avoid reloading on no-op switches and to know when items are stale.
  loadedSessionId = null;
  // true while loading history for a switched session
  isLoadingHistory = false;
  // true while passively watching a running subagent's live stream (distinct
  // from isRunning = a user-initiated turn). Drives the "watching…" status.
  isWatching = false;
  // ref to SessionStore (injected by RootStore) so a finished turn can bump
  // the session's activity + unread in the list. null until wired.
  _sessions = null;
  // the session id of the in-flight turn (so _endTurn knows which to bump)
  _runningSessionId = null;
  // handle to the live subagent SSE subscription (so it can be disposed)
  _liveSub = null;

  constructor() {
    makeAutoObservable(this);
  }

  /** Injected by RootStore to avoid a circular import. */
  setSessionStore(sessions) {
    this._sessions = sessions;
  }

  /** User sends a message: optimistically show it, then stream the turn. */
  async send(sessionId, text) {
    if (!text.trim() || this.isRunning) return;

    // optimistic user bubble
    this.items = [
      ...this.items,
      { kind: "user", id: `u-${Date.now()}`, text },
    ];
    // mark this session as the one currently rendered so a switch back to it
    // doesn't reload (which would replace the just-streamed items)
    this.loadedSessionId = sessionId;

    this.isRunning = true;
    this.error = null;
    this._abort = new AbortController();
    this._textMessageId = null;
    this._runningSessionId = sessionId;
    // tell the session list this one is running (instant spinner)
    this._sessions?.markRunning(sessionId);

    await streamAgent({
      sessionId,
      text,
      signal: this._abort.signal,
      onEvent: (evt) => this._handleEvent(evt),
      onDone: () => runInAction(() => this._endTurn()),
      onError: (e) =>
        runInAction(() => {
          this.error = e.message || String(e);
          this._endTurn();
        }),
    });
  }

  /** Stop the in-flight stream (stop button). */
  stop() {
    if (this._abort) {
      this._abort.abort();
      this._abort = null;
    }
    this._endTurn();
  }

  /**
   * Subscribe to a RUNNING subagent's live SSE stream, feeding its AG-UI frames
   * into the same _handleEvent reducer used for the default agent (so the
   * timeline renders identically). Used when the user opens a delegated task
   * that is still in progress.
   */
  subscribeLive(sessionId) {
    this._disposeLive();
    this.isWatching = true;
    this._liveSub = subscribeSession(sessionId, {
      onEvent: (evt) => this._handleEvent(evt),
      onDone: () =>
        runInAction(() => {
          this.isWatching = false;
          this._disposeLive();
          // mark the session done + refresh its preview in the list
          if (this._sessions) {
            this._sessions.bumpActivity(sessionId, {
              preview: this._lastAssistantText(),
              speaker: "assistant",
            });
            this._sessions.markStatus(sessionId, "active");
          }
        }),
      onError: () =>
        runInAction(() => {
          this.isWatching = false;
          this._disposeLive();
        }),
    });
  }

  /** Close any live subagent subscription. */
  _disposeLive() {
    if (this._liveSub) {
      this._liveSub.dispose();
      this._liveSub = null;
    }
    this.isWatching = false;
  }

  /** Replace the whole item list (e.g. when loading a past session). */
  setItems(items, sessionId = null) {
    runInAction(() => {
      this.items = items;
      this.isRunning = false;
      this.error = null;
      this._textMessageId = null;
      this.loadedSessionId = sessionId;
    });
  }

  /** Reset chat state for a new conversation. */
  clear() {
    this.items = [];
    this.isRunning = false;
    this.error = null;
    this._textMessageId = null;
    this.loadedSessionId = null;
  }

  /**
   * Clear chat state if we're switching to a different conversation.
   * Now superseded by loadHistory (which clears + reloads); kept as a guard
   * for the case where history load is skipped or fails.
   */
  clearIfStale() {
    if (this.isRunning) return; // never nuke a live stream
    this.items = [];
    this.loadedSessionId = null;
  }

  /**
   * Load a session's history from the backend into the timeline.
   *
   * The backend returns the SAME segment shape the live stream produces
   * ({kind:'user'|'assistant-text'|'tool', ...}), so this is just a fetch +
   * setItems. Called when the active session changes.
   *
   * No-op if the requested session is already loaded (avoids refetching on
   * a spurious switch). Clears current items immediately (direct replace),
   * then fills in the history.
   */
  async loadHistory(sessionId) {
    if (!sessionId) {
      runInAction(() => {
        this.items = [];
        this.loadedSessionId = null;
      });
      return;
    }
    if (this.loadedSessionId === sessionId) return; // already showing it
    if (this.isRunning) return; // don't clobber a live stream

    this.isLoadingHistory = true;
    // optimistically clear so the old conversation doesn't linger
    this.items = [];
    this.loadedSessionId = null;
    try {
      const data = await getSession(sessionId);
      runInAction(() => {
        this.items = Array.isArray(data.messages) ? data.messages : [];
        this.loadedSessionId = sessionId;
        this.isLoadingHistory = false;
      });
    } catch (e) {
      runInAction(() => {
        this.error = e.message || String(e);
        this.isLoadingHistory = false;
      });
    }
  }

  // --- AG-UI event dispatch -------------------------------------------

  _handleEvent(evt) {
    runInAction(() => {
      switch (evt.type) {
        case "TEXT_MESSAGE_START":
          // The backend reuses ONE messageId for all text across a run, so we
          // must NOT key text segments on messageId uniqueness alone. We just
          // remember which messageId the stream is writing, and ensure a text
          // segment is open at the end of the timeline.
          this._textMessageId = evt.messageId;
          this._ensureTextSegment();
          break;
        case "TEXT_MESSAGE_CONTENT":
          this._appendText(evt.delta);
          break;
        case "TEXT_MESSAGE_END":
          this._closeTextSegments();
          this._textMessageId = null;
          break;
        case "TOOL_CALL_START":
          this._openTool(evt.toolCallId, evt.toolCallName);
          break;
        case "TOOL_CALL_ARGS":
          this._appendToolArgs(evt.toolCallId, evt.delta);
          break;
        case "TOOL_CALL_RESULT":
          this._setToolResult(evt.toolCallId, evt.content);
          break;
        case "TOOL_CALL_END":
          this._closeTool(evt.toolCallId);
          break;
        case "RUN_ERROR":
          this.error = evt.message || "agent error";
          break;
        // RUN_STARTED / RUN_FINISHED / STEP_* — no rendering branch needed.
        default:
          break;
      }
    });
  }

  // --- low-level mutators ---------------------------------------------

  /**
   * Ensure there is an "open" assistant-text segment at the END of the timeline
   * to receive the next text delta.
   *
   * Why this matters: deepagents interleaves text → tool → text → tool in ONE
   * run, but the backend reuses a single messageId for all of it and emits
   * TEXT_MESSAGE_START only once. So when text resumes after a tool call, there
   * is no new START event — only CONTENT deltas. We must (re)open a text segment
   * ourselves whenever the last timeline item isn't an open text segment.
   *
   * This produces a separate text segment per inter-tool pause, which is what
   * makes "text under text, tool under the text that preceded it" render right.
   */
  _ensureTextSegment() {
    const last = this.items[this.items.length - 1];
    if (last && last.kind === "assistant-text" && last.streaming) return;
    const seg = {
      kind: "assistant-text",
      id: `a-${Date.now()}-${this.items.length}`,
      text: "",
      streaming: true,
    };
    this.items = [...this.items, seg];
  }

  _appendText(delta) {
    // If the last item isn't an open text segment (e.g. a tool just closed),
    // open a fresh one so post-tool text lands under the tool, not dropped.
    const last = this.items[this.items.length - 1];
    if (!last || last.kind !== "assistant-text" || !last.streaming) {
      this._ensureTextSegment();
    }
    const i = this.items.length - 1;
    const cur = this.items[i];
    this.items[i] = { ...cur, text: cur.text + (delta || "") };
  }

  /** Open a new tool-call item at the end of the timeline. */
  _openTool(toolCallId, name) {
    // Seal any open text segment first so the tool starts cleanly after it.
    this._closeTextSegments();
    const item = {
      kind: "tool",
      id: toolCallId,
      name: name || "tool",
      args: "",
      result: null,
      streaming: true,
    };
    this.items = [...this.items, item];
  }

  _appendToolArgs(toolCallId, delta) {
    this._replaceItem(
      (it) => it.kind === "tool" && it.id === toolCallId,
      (it) => ({ ...it, args: it.args + (delta || "") }),
    );
  }

  _setToolResult(toolCallId, content) {
    this._replaceItem(
      (it) => it.kind === "tool" && it.id === toolCallId,
      (it) => ({ ...it, result: content }),
    );
  }

  _closeTool(toolCallId) {
    this._replaceItem(
      (it) => it.kind === "tool" && it.id === toolCallId,
      (it) => ({ ...it, streaming: false }),
    );
  }

  /** Seal every open assistant-text segment (used at END / before a tool). */
  _closeTextSegments() {
    let changed = false;
    this.items = this.items.map((it) => {
      if (it.kind === "assistant-text" && it.streaming) {
        changed = true;
        return { ...it, streaming: false };
      }
      return it;
    });
    return changed;
  }

  /** Immutable find-and-replace one item by predicate (mobx-safe). */
  _replaceItem(pred, updater) {
    const i = this.items.findIndex(pred);
    if (i < 0) return;
    this.items[i] = updater(this.items[i]);
  }

  _endTurn() {
    this._closeTextSegments();
    this.isRunning = false;
    this._abort = null;
    this._textMessageId = null;
    // bump the session's activity in the list; +1 unread only if the user is
    // viewing a DIFFERENT conversation (so the red dot signals new replies).
    const sid = this._runningSessionId;
    const hadToolCalls = this.items.some((it) => it.kind === "tool");
    this._runningSessionId = null;
    if (sid && this._sessions) {
      const isActive = this._sessions.activeId === sid;
      // preview = the last assistant text segment (the reply), truncated
      const preview = this._lastAssistantText();
      this._sessions.bumpActivity(sid, {
        unread: isActive ? 0 : 1,
        preview,
        speaker: "assistant",
      });
      // If this turn invoked any tools, the agent may have created new sessions
      // (dispatch_single / dispatch_to_team). Refresh the list so they appear
      // without a manual page reload, then auto-switch to the newest derived
      // session so the user lands on the work the agent just delegated. This
      // runs detached (not inside runInAction) since it's async.
      if (hadToolCalls) {
        this._afterDelegation(sid).catch(() => {});
      }
    }
  }

  /** Refresh the list and auto-select any newly-created derived session.
   *
   * We detect "new" by diffing the id set before vs after the reload (more
   * reliable than trusting a `parent` metadata field, which can be missing).
   * Picks the newest derived session (team/subagent) among the new ids.
   */
  async _afterDelegation(sid) {
    const before = new Set(this._sessions.sessions.map((s) => s.id));
    const list = await this._sessions.load();
    const child = _newestDerived(list, before);
    if (child) this._sessions.select(child.id);
  }

  /** The text of the most recent assistant-text segment (for list preview). */
  _lastAssistantText() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "assistant-text" && it.text) {
        return it.text.replace(/\s+/g, " ").trim().slice(0, 80);
      }
    }
    return "";
  }
}

/**
 * Find the newest derived session (team/subagent) whose parent is `parentId`.
 * Used to auto-switch to the task the default agent just delegated. Picks the
 * most recently updated/created one.
 */
/**
 * Find the newest DERIVED session (team/subagent) that was NOT in `beforeIds`.
 * Used to auto-switch to the task the default agent just delegated: instead of
 * trusting a parent metadata field (which can be missing), we diff the session
 * list before vs after reload and grab any new derived session. Picks the most
 * recently updated/created one if several appeared.
 */
function _newestDerived(list, beforeIds) {
  const fresh = (list || []).filter(
    (s) =>
    (s) =>
      (s.kind === "team" ||
        (s.kind === "subagent" && !s.metadata?.internal)) &&
      !beforeIds.has(s.id),
  );
  if (fresh.length === 0) return null;
  return fresh.sort((a, b) => {
    const ta = Date.parse((a.updated_at || a.created_at || "").replace(" ", "T")) || 0;
    const tb = Date.parse((b.updated_at || b.created_at || "").replace(" ", "T")) || 0;
    return tb - ta;
  })[0];
}
