import { makeAutoObservable, runInAction } from "mobx";

import * as sessionApi from "@/services/sessionService";

const LS_KEY = "deepopen.activeSessionId";

/**
 * SessionStore owns the conversation list + the active session id.
 *
 * The active session id is THE thing that makes memory work: it's sent with
 * every agent message so the backend checkpointer keeps one continuous thread.
 * It persists to localStorage so a page refresh keeps you in the same convo.
 *
 * Views call actions here; they never call the service directly.
 */
export class SessionStore {
  sessions = [];
  activeId = null;
  loading = false;
  error = null;

  constructor() {
    makeAutoObservable(this);
    // restore last active session from a previous visit
    this.activeId = localStorage.getItem(LS_KEY) || null;
  }

  get active() {
    return this.sessions.find((s) => s.id === this.activeId) || null;
  }

  _setActive(id) {
    this.activeId = id;
    if (id) localStorage.setItem(LS_KEY, id);
    else localStorage.removeItem(LS_KEY);
  }

  /** Load the session list from the backend (via service). */
  async load() {
    this.loading = true;
    this.error = null;
    try {
      const data = await sessionApi.listSessions();
      runInAction(() => {
        this.sessions = Array.isArray(data) ? data : [];
        this.loading = false;
        // if the restored activeId no longer exists, clear it
        if (this.activeId && !this.sessions.some((s) => s.id === this.activeId)) {
          this._setActive(null);
        }
      });
    } catch (e) {
      runInAction(() => {
        this.error = e.message || String(e);
        this.loading = false;
      });
    }
  }

  /** Create a new conversation and switch to it. Returns the session. */
  async create(title) {
    const s = await sessionApi.createSession({ title });
    runInAction(() => {
      // dedupe: avoid a duplicate if load() later returns the same id
      if (!this.sessions.some((x) => x.id === s.id)) {
        this.sessions.unshift(s);
      }
      this._setActive(s.id);
    });
    return s;
  }

  /** Switch the active conversation. */
  select(id) {
    this._setActive(id);
  }

  /** Ensure there's an active session; create one if none. Returns its id. */
  async ensureActive() {
    if (this.activeId) return this.activeId;
    const s = await this.create();
    return s.id;
  }

  /** Delete a session and pick another active one if needed. */
  async remove(id) {
    await sessionApi.deleteSession(id);
    runInAction(() => {
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.activeId === id) {
        this._setActive(this.sessions[0]?.id || null);
      }
    });
  }

  /** Rename a session. */
  async rename(id, title) {
    const s = await sessionApi.updateSession(id, { title });
    runInAction(() => {
      const idx = this.sessions.findIndex((x) => x.id === id);
      if (idx >= 0) this.sessions[idx] = { ...this.sessions[idx], ...s };
    });
  }
}
