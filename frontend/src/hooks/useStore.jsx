import { createContext, useContext } from "react";

import { rootStore } from "@/stores";

/**
 * React binding for the mobx RootStore singleton.
 *
 * Components read state via `useStore()` and call store *actions*; the actual
 * chat message stream is rendered by CopilotKit's <CopilotChat>, while this
 * store holds the surrounding application state (sessions, ui, connection).
 */
const StoreContext = createContext(rootStore);

export function StoreProvider({ children }) {
  return (
    <StoreContext.Provider value={rootStore}>{children}</StoreContext.Provider>
  );
}

export function useStore() {
  return useContext(StoreContext);
}
