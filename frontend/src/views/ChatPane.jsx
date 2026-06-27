import { observer } from "mobx-react-lite";

import { useStore } from "@/hooks/useStore";
import { useChat } from "@/hooks/useChat";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";

/**
 * ChatPane — the middle column: self-rendered conversation.
 *
 * No <CopilotChat>; we use the headless CopilotKit API (useChat) and render
 * messages ourselves (avatars + bubbles + collapsible tool calls). One unified
 * renderer for both single-agent and team sessions (team group-chat styling is
 * a later refinement on top of this same component).
 */
export const ChatPane = observer(function ChatPane() {
  const { sessions } = useStore();
  const active = sessions.active;
  const isTeam = active?.kind === "team";
  const { items, sendMessage, isLoading } = useChat();

  return (
    <div className="flex h-full flex-col bg-background">
      {/* header strip */}
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-2.5">
        <span
          className={
            isTeam
              ? "size-1.5 rounded-full bg-accent"
              : "size-1.5 rounded-full bg-muted-foreground/40"
          }
        />
        <span className="truncate text-[13px] font-medium">
          {active ? active.title || active.id.slice(0, 12) : "New conversation"}
        </span>
        {isTeam && (
          <span className="rounded-sm bg-accent/10 px-1.5 text-[10px] text-accent">
            team
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {isLoading ? "thinking…" : isTeam ? "group chat" : "1:1"}
        </span>
      </div>

      {/* messages */}
      <ChatMessages items={items} />

      {/* input */}
      <ChatInput
        onSend={(text) => sendMessage({ message: text })}
        isLoading={isLoading}
        onStop={() => {
          /* stop streaming — wired in a later step */
        }}
      />
    </div>
  );
});
