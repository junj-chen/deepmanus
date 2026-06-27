import { makeAutoObservable, runInAction } from "mobx";

import {
  getTeamMessages,
  postTeamMessage,
  subscribeTeam,
} from "@/services/teamService";

/**
 * TeamStore owns the live team group-chat view.
 *
 * When a team session is opened, we load its history and subscribe to the SSE
 * stream. Incoming GROUP_MESSAGE events append to `messages`; non-group AG-UI
 * frames (tool calls etc.) are folded into the last speaker's message as
 * "details" (rendered collapsed).
 *
 * Views call actions here; never the service directly.
 */
export class TeamStore {
  activeTeamId = null;
  messages = []; // [{id, speaker, text, direction, collapsed, details:[]}]
  status = "idle"; // idle | loading | running | done | error
  error = null;
  _sub = null; // current SSE subscription

  constructor() {
    makeAutoObservable(this);
  }

  /** Open a team: load history + subscribe to live stream. */
  async open(teamId) {
    // tear down any previous subscription
    this._dispose();

    this.activeTeamId = teamId;
    this.messages = [];
    this.status = "loading";
    this.error = null;

    try {
      const data = await getTeamMessages(teamId);
      runInAction(() => {
        this.messages = (data.messages || []).map((m) => ({
          id: m.id,
          speaker: m.speaker,
          text: m.text,
          direction: m.direction,
          collapsed: m.speaker !== "user", // user msgs expanded, others collapsed
          details: [],
        }));
        this.status = data.status === "done" ? "done" : "running";
      });
    } catch (e) {
      runInAction(() => {
        this.error = e.message || String(e);
        this.status = "error";
      });
      return;
    }

    // subscribe to live updates (only meaningful if still running)
    if (this.status === "running") {
      this._sub = subscribeTeam(teamId, {
        onGroup: (msg) => this._appendGroup(msg),
        onFrame: (payload) => this._handleFrame(payload),
        onDone: () => runInAction(() => (this.status = "done")),
        onError: () =>
          runInAction(() => {
            this.error = "stream error";
          }),
      });
    }
  }

  /** Close the team view + stop the SSE subscription. */
  close() {
    this._dispose();
    this.activeTeamId = null;
    this.messages = [];
    this.status = "idle";
  }

  /** User posts a message into the team. */
  async sendMessage(text, targetAgent = null) {
    if (!this.activeTeamId || !text.trim()) return;
    // optimistic: show the user's message immediately
    this.messages.push({
      id: `u-${Date.now()}`,
      speaker: "user",
      text,
      direction: targetAgent ? "mention" : "chat",
      collapsed: false,
      details: [],
    });
    try {
      await postTeamMessage(this.activeTeamId, {
        content: text,
        targetAgent,
      });
    } catch (e) {
      this.error = e.message || String(e);
    }
  }

  /** Toggle a message's collapsed state (expand/collapse sub-agent detail). */
  toggleCollapse(id) {
    const m = this.messages.find((x) => x.id === id);
    if (m) m.collapsed = !m.collapsed;
  }

  // --- internal handlers ---

  _appendGroup(msg) {
    runInAction(() => {
      this.messages.push({
        id: msg.messageId || `g-${Date.now()}`,
        speaker: msg.speaker || "agent",
        text: msg.content || "",
        direction: msg.direction || "chat",
        collapsed: msg.speaker !== "user",
        details: [],
      });
    });
  }

  _handleFrame(payload) {
    // Fold tool-call / text-token frames into the last agent message as detail.
    // For MVP we just track them as opaque detail entries on the last non-user
    // message, which the UI renders collapsed.
    runInAction(() => {
      const last = [...this.messages].reverse().find((m) => m.speaker !== "user");
      if (!last) return;
      if (payload.type === "TOOL_CALL_START") {
        last.details.push(`🔧 ${payload.toolCallName || "tool"}`);
      }
    });
  }

  _dispose() {
    if (this._sub) {
      this._sub.dispose();
      this._sub = null;
    }
  }
}
