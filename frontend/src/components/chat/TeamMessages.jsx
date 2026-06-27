import { observer } from "mobx-react-lite";
import { Bot, User, Wrench, ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * TeamMessages — group-chat rendering for a team session.
 *
 * Each message shows a speaker avatar (coloured by role) + name + the bubble.
 * Sub-agent (non-user, non-system) messages collapse to a summary line by
 * default; click to expand full text + any tool-call details.
 *
 * Reads from TeamStore.messages via props.
 */

// Role → avatar style + label.
const ROLES = {
  teamleader: { icon: Bot, dot: "dot-teamleader", tint: "text-role-teamleader" },
  researcher: { icon: Bot, dot: "dot-researcher", tint: "text-role-researcher" },
  coder: { icon: Bot, dot: "dot-coder", tint: "text-role-coder" },
  user: { icon: User, dot: "dot-user", tint: "text-role-user" },
  system: { icon: Wrench, dot: "dot-system", tint: "text-role-system" },
};

function roleCfg(speaker) {
  return ROLES[speaker] || { icon: Bot, dot: "dot-user", tint: "text-muted-foreground" };
}

export const TeamMessages = observer(function TeamMessages({ messages, onToggle }) {
  if (!messages || messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">
          Team is starting…
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
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
  const Icon = cfg.icon;
  const isUser = msg.speaker === "user";
  const isMention = msg.direction === "mention";
  const hasDetails = (msg.details?.length || 0) > 0;

  return (
    <div className="anim-rise mb-4 flex gap-3">
      {/* avatar */}
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-muted-foreground/25" : "bg-card",
        )}
      >
        <Icon className={cn("size-4", cfg.tint)} />
      </div>

      <div className="min-w-0 flex-1">
        {/* name row */}
        <div className="mb-1 flex items-center gap-1.5">
          <span className={cn("text-[11px] font-medium", cfg.tint)}>
            {msg.speaker}
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

        {/* text body (collapsed → single line clamp) */}
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground/90",
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
