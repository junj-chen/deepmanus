import { SessionStore } from "./SessionStore";
import { AgentRuntime } from "@/runtime/agentRuntime";

/**
 * Root store: single source of truth injected into the React tree via a
 * React context (see hooks/useStore.jsx + main.jsx).
 *
 * Two collaborators:
 *   - sessions: the conversation list + active id (session tree / scope)
 *   - runtime:  the multi-agent runtime (agentRuntime) — an observable data
 *               source owning per-session messages + the live SSE subscription.
 *               It is framework-agnostic (no React inside); views read its
 *               observable state and call its actions.
 *
 * Views call store/runtime *actions* only — never services directly.
 */
export class RootStore {
  sessions;
  runtime;

  constructor() {
    this.sessions = new SessionStore();
    this.runtime = new AgentRuntime();
    // wire the runtime to the session list so a finished turn bumps the
    // session's activity + unread, without a circular module import.
    this.runtime.setSessionStore(this.sessions);
  }
}

/** Process-wide singleton. */
export const rootStore = new RootStore();
