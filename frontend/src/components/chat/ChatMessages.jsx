import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { User, ChevronRight, ChevronDown, Wrench, Loader2 } from "lucide-react";

import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";

/**
 * ChatMessages — the flat conversation timeline.
 *
 * The store holds a flat list of segments in arrival order:
 *   user bubble → assistant text → tool call → assistant text → ...
 * We render each in sequence, so a tool call always appears under the text
 * that preceded it, and post-tool text appears under the tool. This matches
 * how a real agent works (think, act, think, act) rather than collapsing all
 * text into one bubble.
 *
 * Each segment-renderer is a mobx observer so streaming deltas re-render
 * live (immutable index replacement in the store drives this).
 *
 * The assistant avatar is a DiceBear face matching SessionList (same seed:
 * subagent → role name, root → session id), so the chat and the list show the
 * SAME identity for a given session.
 *
 * Auto-scroll: the container sticks to the bottom as new content streams in,
 * UNLESS the user has scrolled up to read history (then we don't yank them
 * back down). Resumes stick-to-bottom once they scroll near the bottom again.
 */

/** Seed for the assistant avatar, matching SessionList's SessionAvatar logic.
 * Every session gets its own face via its id (so different coders look
 * different), kept stable across refreshes. The default entry "Manus" uses a
 * dedicated seed for a distinct, fixed face. */
function assistantSeed(session) {
  if (!session) return "manus-open";
  return session.id === "default" ? "manus-open" : session.id;
}

/** Label shown above assistant messages, matching the session's identity. */
function assistantLabel(session) {
  if (!session) return "Manus";
  if (session.kind === "subagent") return session.name || "agent";
  if (session.kind === "team") return "team";
  return "Manus";
}

export const ChatMessages = observer(function ChatMessages({ items, loading, session }) {
  const scrollRef = useRef(null);
  // track whether the user is parked at the bottom (auto-scroll allowed)
  const stickToBottom = useRef(true);

  // A cheap fingerprint that changes whenever new content arrives: the item
  // count + the last item's text length. Drives the auto-scroll effect.
  const last = items[items.length - 1];
  const fingerprint = `${items.length}:${last?.text?.length ?? 0}:${last?.kind ?? ""}`;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [fingerprint]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground/60" />
      </div>
    );
  }
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
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        // "near the bottom" = within 80px of the bottom edge
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="content-narrow px-2 py-4">
        {items.map((seg) => (
          <Segment key={seg.id} seg={seg} session={session} />
        ))}
      </div>
    </div>
  );
});

/** Dispatch a segment to its renderer by kind. */
function Segment({ seg, session }) {
  switch (seg.kind) {
    case "user":
      return <UserBubble seg={seg} />;
    case "assistant-text":
      return <AssistantText seg={seg} session={session} />;
    case "tool":
      return <ToolRow seg={seg} />;
    default:
      return null;
  }
}

const UserBubble = observer(function UserBubble({ seg }) {
  return (
    <div className="anim-rise mb-5 flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted-foreground/30 text-foreground">
        <User className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">you</p>
        <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
          {seg.text}
        </p>
      </div>
    </div>
  );
});

/**
 * An assistant text segment. The avatar is the DiceBear face for this session
 * (same as SessionList), so the chat and list share one identity. While
 * streaming and empty, show a "thinking" indicator so the user immediately
 * sees the agent working before the first token lands.
 */
const AssistantText = observer(function AssistantText({ seg, session }) {
  const waiting = seg.streaming && !seg.text;
  return (
    <div className="anim-rise mb-5 flex gap-3">
      <div className="mt-0.5 shrink-0">
        <Avatar seed={assistantSeed(session)} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
          {assistantLabel(session)}
          {seg.streaming && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-accent">
              <Loader2 className="size-3 animate-spin" />
            </span>
          )}
        </p>
        {waiting ? (
          <p className="text-[13px] text-muted-foreground">thinking…</p>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
            {seg.text}
          </p>
        )}
      </div>
    </div>
  );
});

/** A tool call: name + streamed args (collapsible) + result when it arrives. */
const ToolRow = observer(function ToolRow({ seg }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 ml-10">
      <div className="rounded-md border border-border/60 bg-card/60">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Wrench className="size-3 text-accent" />
          <span className="font-mono">{seg.name}</span>
          {/* status pip: spinning while streaming, dot when done with result */}
          {seg.streaming ? (
            <Loader2 className="ml-auto size-3 animate-spin text-accent" />
          ) : seg.result != null ? (
            <span className="ml-auto size-1.5 rounded-full bg-accent ring-2 ring-accent/20" />
          ) : null}
        </button>
        {open && (
          <pre className="max-h-60 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            {seg.args ? seg.args : "(no args)"}
            {seg.result != null && (
              <span className="mt-1 block border-t border-border/40 pt-1 text-foreground/70">
                {String(seg.result)}
              </span>
            )}
          </pre>
        )}
      </div>
    </div>
  );
});
