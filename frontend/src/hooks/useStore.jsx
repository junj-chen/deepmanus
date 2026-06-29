import { createContext, useContext } from "react";

import { rootStore } from "@/stores";

/**
 * React binding for the mobx RootStore singleton.
 *
 * Components read state via `useStore()` and call store *actions*; the chat
 * message stream comes from AG-UI SSE via agentService -> ChatStore.
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
