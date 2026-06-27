import { ChatStore } from "./ChatStore";
import { SessionStore } from "./SessionStore";
import { TeamStore } from "./TeamStore";

/**
 * Root store: single source of truth injected into the React tree via a
 * React context (see hooks/useStore.js + main.jsx).
 *
 * Anything the views need lives here. Views call store *actions* only — never
 * services directly.
 */
export class RootStore {
  chat;
  sessions;
  team;

  constructor() {
    this.chat = new ChatStore();
    this.sessions = new SessionStore();
    this.team = new TeamStore();
  }
}

/** Process-wide singleton. */
export const rootStore = new RootStore();
