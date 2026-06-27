import { useState } from "react";
import { Bot, User, ChevronRight, ChevronDown, Wrench } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ChatMessages — self-rendered message list (avatar + bubble).
 *
 * Replaces CopilotKit's <CopilotChat> renderer. Each message shows an avatar
 * (user vs agent), the text (streamed live), and any tool calls folded into a
 * collapsible detail block.
 */

const AVATAR = {
  user: { icon: User, cls: "bg-muted-foreground/30 text-foreground" },
  assistant: { icon: Bot, cls: "bg-accent/15 text-accent" },
};

export function ChatMessages({ items }) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">
          What would you like to build or change today?
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="content-narrow px-2 py-4">
        {items.map((m) => (
          <MessageRow key={m.id} item={m} />
        ))}
      </div>
    </div>
  );
}

function MessageRow({ item }) {
  const cfg = AVATAR[item.role] || AVATAR.assistant;
  const Icon = cfg.icon;
  const isUser = item.role === "user";

  return (
    <div className="anim-rise mb-5 flex gap-3">
      {/* avatar */}
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
          cfg.cls,
        )}
      >
        <Icon className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        {/* name */}
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
          {isUser ? "you" : "deepopen"}
        </p>

        {/* text body */}
        {item.text && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground/90">
            {item.text}
          </p>
        )}

        {/* tool calls (collapsible) */}
        {item.toolCalls?.length > 0 && (
          <div className="mt-2 space-y-1">
            {item.toolCalls.map((tc) => (
              <ToolCallBlock key={tc.id} tc={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallBlock({ tc }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-border/60 bg-card/60">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Wrench className="size-3 text-accent/70" />
        <span className="font-mono">{tc.name}</span>
      </button>
      {open && (
        <pre className="border-t border-border/60 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
          {tc.args ? JSON.stringify(tc.args, null, 2) : "(no args)"}
        </pre>
      )}
    </div>
  );
}
