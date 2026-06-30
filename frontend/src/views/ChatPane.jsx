

import { observer } from "mobx-react-lite";
import { useEffect } from "react";

import { useStore } from "@/hooks/useStore";
import { useChat } from "@/hooks/useChat";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { ChatInput } from "@/components/chat/ChatInput";
import { TeamMessages } from "@/components/chat/TeamMessages";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * ChatPane — the middle column: self-rendered conversation.
 *
 * Two modes, same column:
 *  - Single-agent session (kind != team): ChatStore driven by AG-UI SSE.
 *  - Team session (kind == team): TeamStore SSE group-chat (speaker bubbles).
 *
 * On team open, subscribe to the team's live stream (team.open); on leave,
 * close it.
 */
export const ChatPane = observer(function ChatPane() {
  const { sessions, team, chat } = useStore();
  const active = sessions.active;

  /** "New chat" = reset the default entry's history and return to it. */
  const handleNewChat = async () => {
    await sessions.resetDefault();
    // force ChatStore to reload (history was wiped) + show empty timeline
    chat.clear();
    chat.loadedSessionId = null;
  };
  const isTeam = active?.kind === "team";

  // single-agent chat API (only meaningful for non-team sessions, but the hook
  // must be called unconditionally to satisfy React rules-of-hooks)
  const { items, isLoading, isLoadingHistory, send, stop } = useChat();

  // when switching to a NON-team session, load its history into the timeline,
  // and — if it's a subagent still running — attach to its live SSE stream so
  // the user watches it work in real time. History frames first (what's done
  // so far), then live frames append on top.
  //
  // IMPORTANT: we ALWAYS dispose the previous live subscription first, even
  // when going subagent → default. Otherwise the subagent's stream keeps
  // feeding frames into the shared ChatStore and the default view shows the
  // subagent's output ("串台"). Only `isTeam` toggling used to trigger the
  // dispose, which left subagent→default switches leaking.
  useEffect(() => {
    // tear down any live subagent subscription from the PREVIOUS session
    chat._disposeLive();
    if (!isTeam && active?.id) {
      (async () => {
        await chat.loadHistory(active.id);
        // re-read the session row AFTER load (status may have changed)
        const cur = sessions.sessions.find((s) => s.id === active.id);
        if (active.kind === "subagent" && cur?.status === "running") {
          chat.subscribeLive(active.id);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, isTeam]);

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
    <TooltipProvider delayDuration={300}>
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
          {active
            ? active.kind === "subagent"
              ? active.name || "agent"
              : active.kind === "team"
                ? "Team"
                : active.title || active.id.slice(0, 12)
            : "New conversation"}
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
        <ChatMessages items={items} loading={isLoadingHistory} session={active} />
      )}

      {/* input: both modes use the same ChatInput, different senders.
          onNewChat resets the default entry's history (only meaningful there). */}
      {isTeam ? (
        <ChatInput
          onSend={(text) => team.sendMessage(text)}
          isLoading={team.status === "running"}
        />
      ) : (
        <ChatInput
          onSend={send}
          isLoading={isLoading}
          onStop={stop}
          showNewChat={active?.kind === "root"}
          onNewChat={handleNewChat}
        />
      )}
    </div>
    </TooltipProvider>
  );
});
