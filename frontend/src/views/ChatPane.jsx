import { observer } from "mobx-react-lite";
import { useEffect } from "react";

import { useStore } from "@/hooks/useStore";
import { useChat } from "@/hooks/useChat";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";
import { TeamMessages } from "@/components/chat/TeamMessages";

/**
 * ChatPane — the middle column: self-rendered conversation.
 *
 * Two modes, same column:
 *  - Single-agent session (kind != team): CopilotKit headless via useChat.
 *  - Team session (kind == team): TeamStore SSE group-chat (speaker bubbles).
 *
 * On team open, subscribe to the team's live stream (team.open); on leave,
 * close it.
 */
export const ChatPane = observer(function ChatPane() {
  const { sessions, team } = useStore();
  const active = sessions.active;
  const isTeam = active?.kind === "team";

  // single-agent chat API (only meaningful for non-team sessions, but the hook
  // must be called unconditionally to satisfy React rules-of-hooks)
  const { items, sendMessage, isLoading } = useChat();

  // subscribe / unsubscribe the team stream when switching to/from a team
  useEffect(() => {
    if (isTeam && active) {
      team.open(active.id);
    } else {
      team.close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeam, active?.id]);

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
          {isTeam
            ? team.status === "running"
              ? "running…"
              : team.status
            : isLoading
              ? "thinking…"
              : "1:1"}
        </span>
      </div>

      {/* messages: team group-chat OR single-agent chat */}
      {isTeam ? (
        <TeamMessages messages={team.messages} onToggle={team.toggleCollapse} />
      ) : (
        <ChatMessages items={items} />
      )}

      {/* input: team uses its own store action, single uses CopilotKit */}
      {isTeam ? (
        <ChatInput
          onSend={(text) => team.sendMessage(text)}
          isLoading={team.status === "running"}
        />
      ) : (
        <ChatInput
          onSend={(text) => sendMessage({ message: text })}
          isLoading={isLoading}
        />
      )}
    </div>
  );
});
