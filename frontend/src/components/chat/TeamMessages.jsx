import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import { Wrench, ChevronDown, ChevronRight } from "lucide-react";

import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";

/**
 * TeamMessages — group-chat rendering for a team session.
 *
 * Each message shows a speaker's DiceBear face + role-coloured name + the
 * bubble. Sub-agent (non-user, non-system) messages collapse to a summary line
 * by default; click to expand full text + tool-call details.
 *
 * Avatars match the rest of the app (DiceBear adventurer), seeded by speaker
 * name so each role has a stable face. The container auto-scrolls to the bottom
 * unless the user scrolled up to read history.
 */

// Role → display label + colour class (text-role-* are defined in index.css).
const ROLES = {
  teamleader: { label: "Team Leader", tint: "text-role-teamleader" },
  researcher: { label: "Researcher", tint: "text-role-researcher" },
  coder: { label: "Coder", tint: "text-role-coder" },
  user: { label: "you", tint: "text-role-user" },
  system: { label: "system", tint: "text-role-system" },
};

function roleCfg(speaker) {
  return ROLES[speaker] || { label: speaker || "agent", tint: "text-muted-foreground" };
}

export const TeamMessages = observer(function TeamMessages({ messages, onToggle }) {
  const scrollRef = useRef(null);
  const stickToBottom = useRef(true);

  // fingerprint: changes when messages change → drives auto-scroll
  const last = messages?.[messages.length - 1];
  const fingerprint = `${messages?.length || 0}:${last?.text?.length ?? 0}:${last?.speaker ?? ""}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [fingerprint]);

  if (!messages || messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">Team is starting…</p>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="content-narrow px-2 py-4">
        {messages.map((m) => (
          <TeamBubble key={m.id} msg={m} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
});

function TeamBubble({ msg, onToggle }) {
  const cfg = roleCfg(msg.speaker);
  const isUser = msg.speaker === "user";
  const isSystem = msg.speaker === "system";
  const isMention = msg.direction === "mention";
  const hasDetails = (msg.details?.length || 0) > 0;

  return (
    <div className="anim-rise mb-4 flex gap-3">
      {/* DiceBear avatar seeded by speaker name (stable per role) */}
      <div className="mt-0.5 shrink-0">
        {isUser ? (
          <div className="flex size-7 items-center justify-center rounded-full bg-muted-foreground/25 text-xs text-foreground">
            you
          </div>
        ) : (
          <Avatar seed={msg.speaker || "agent"} size={28} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* name row */}
        <div className="mb-1 flex items-center gap-1.5">
          <span className={cn("text-[11px] font-medium", cfg.tint)}>
            {cfg.label}
          </span>
          {isMention && (
            <span className="rounded-sm bg-accent/10 px-1 text-[10px] text-accent">
              @
            </span>
          )}
          {hasDetails && (
            <button
              onClick={() => onToggle?.(msg.id)}
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground transition hover:text-foreground"
            >
              {msg.collapsed ? (
                <ChevronRight className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
              {msg.details.length} steps
            </button>
          )}
        </div>

        {/* text body (collapsed → single line clamp; system → muted) */}
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-[14px] leading-relaxed",
            isSystem ? "text-muted-foreground" : "text-foreground",
            msg.collapsed ? "line-clamp-2" : "",
          )}
        >
          {msg.text}
        </p>

        {/* expanded details (tool calls) */}
        {!msg.collapsed && hasDetails && (
          <ul className="mt-2 space-y-1 border-l border-border/60 pl-3 font-mono text-[11px] text-muted-foreground">
            {msg.details.map((d, i) => (
              <li key={i} className="flex items-center gap-1">
                <Wrench className="size-3 text-accent/60" />
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
