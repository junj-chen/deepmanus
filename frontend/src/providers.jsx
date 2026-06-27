import { observer } from "mobx-react-lite";
import { CopilotKit } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";

import { rootStore } from "@/stores";

/**
 * CopilotKit provider, keyed by the active session id.
 *
 * Why key the whole provider: CopilotKit caches chat messages at the PROVIDER
 * level (not inside <CopilotChat>), so remounting just <CopilotChat> doesn't
 * clear them on a session switch. Keying <CopilotKit> itself forces a full
 * tear-down + rebuild of the entire chat state when the active session changes
 * — which is exactly what we want (a clean chat for the new conversation).
 *
 * The session id is also injected into every runtime request via `headers`,
 * so the backend checkpointer keeps one thread per conversation (memory).
 */
const AppProviders = observer(function AppProviders({ children }) {
  const sid = rootStore.sessions.activeId;
  return (
    <CopilotKit
      key={sid ?? "boot"}
      runtimeUrl="/api/copilotkit"
      agent="default"
      showDevConsole={false}
      headers={() => (sid ? { "x-session-id": sid } : {})}
    >
      {children}
    </CopilotKit>
  );
});

export { AppProviders };
