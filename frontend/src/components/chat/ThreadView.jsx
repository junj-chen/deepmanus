import { useState } from "react";
import { observer } from "mobx-react-lite";
import { ChevronRight, ChevronDown, Wrench, Loader2, Brain } from "lucide-react";

import { Avatar } from "@/components/Avatar";

/**
 * ThreadView — a PURE presentational chat surface (no assistant-ui runtime).
 *
 * Receives a `messages` array (Message[] from the runtime's eventReducer) and
 * renders it with our cinematic dark theme + DiceBear avatars + collapsible
 * reasoning + tool fences. It has no data dependency: whoever owns the messages
 * (agentRuntime.activeMessages) just hands them in.
 *
 * Message shape (see runtime/eventReducer.js):
 *   { id, role:'user'|'assistant', speaker, thinking?, content: Part[], status }
 *   Part: { type:'text', text } | { type:'tool-call', toolCallId, toolName, args, result, _streaming }
 *
 * @param {{ messages: import("@/runtime/eventReducer").Message[], session?: object }} props
 */
export const ThreadView = observer(function ThreadView({ messages = [], session }) {
  if (!messages.length) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">
          What would you like to build or change today?
        </p>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="content-narrow px-2 py-4">
        {messages.map((m) => (
          <MessageRow key={m.id} message={m} session={session} />
        ))}
      </div>
    </div>
  );
});

/** Dispatch a message to its renderer by role. */
function MessageRow({ message, session }) {
  if (message.role === "user") return <UserMessage message={message} />;
  return <AssistantMessage message={message} session={session} />;
}

/** A user-authored message bubble — right-aligned (chat-bubble style). */
function UserMessage({ message }) {
  const text = extractText(message);
  return (
    <div className="anim-rise mb-5 flex justify-end gap-3">
      <div className="min-w-0 max-w-[80%]">
        <p className="mb-1 text-right text-[11px] font-medium text-muted-foreground">you</p>
        <div className="rounded-2xl rounded-tr-sm bg-accent/15 px-3.5 py-2">
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
            {text}
          </p>
        </div>
      </div>
      <div className="mt-0.5 shrink-0">
        <Avatar seed="user-face" size={28} />
      </div>
    </div>
  );
}

/** An assistant message: avatar (DiceBear by speaker) + thinking + text + tools. */
const AssistantMessage = observer(function AssistantMessage({ message, session }) {
  const speaker = message.speaker || "assistant";
  const seed = speakerSeed(speaker, session);
  const label = speakerLabel(speaker, session);
  const text = extractText(message);
  const tools = extractToolCalls(message);
  const thinking = message.thinking || "";
  const streaming = message.status === "streaming";
  const onlyThinking = streaming && !text && tools.length === 0;
  return (
    <div className="anim-rise mb-5 flex gap-3">
      <div className="mt-0.5 shrink-0">
        <Avatar seed={seed} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
          {label}
          {streaming && (
            <span className="ml-1.5 inline-flex items-center gap-1 text-accent">
              <Loader2 className="size-3 animate-spin" />
            </span>
          )}
        </p>
        {thinking && <ThinkingBlock text={thinking} live={onlyThinking || (!text && streaming)} />}
        {onlyThinking && !thinking && (
          <p className="text-[13px] text-muted-foreground">thinking…</p>
        )}
        {text && (
          <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground">
            {text}
          </p>
        )}
        {tools.map((t) => (
          <ToolFence key={t.toolCallId} tool={t} />
        ))}
      </div>
    </div>
  );
});

/**
 * A collapsible reasoning/thinking region shown above the answer.
 * Live (streaming) → expanded by default with a spinner; finished → collapsible,
 * collapsed by default so past reasoning stays reviewable but out of the way.
 */
const ThinkingBlock = observer(function ThinkingBlock({ text, live }) {
  const [open, setOpen] = useState(live);
  if (live && !open) setOpen(true);
  return (
    <div className="mb-2 rounded-md border border-border/40 bg-sidebar/30">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground/80 transition hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3 text-muted-foreground/60" />
        <span>{live ? "思考中" : "思考过程"}</span>
        {live && <Loader2 className="ml-1 size-3 animate-spin text-muted-foreground/50" />}
      </button>
      {open && (
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-border/40 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground/70">
          {text}
        </p>
      )}
    </div>
  );
});

/** A tool-call rendered as a collapsible fence (name + args + result). */
const ToolFence = observer(function ToolFence({ tool }) {
  const [open, setOpen] = useState(false);
  const running = tool && tool.result == null && !tool.isError && tool._streaming;
  return (
    <div className="my-1.5">
      <div className="rounded-md border border-border/60 bg-card/60">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <Wrench className="size-3 text-accent" />
          <span className="font-mono">{tool?.toolName || "tool"}</span>
          {running ? (
            <Loader2 className="ml-auto size-3 animate-spin text-accent" />
          ) : tool?.result != null ? (
            <span className="ml-auto size-1.5 rounded-full bg-accent ring-2 ring-accent/20" />
          ) : null}
        </button>
        {open && (
          <pre className="max-h-60 overflow-auto border-t border-border/60 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            {tool?.args || "(no args)"}
            {tool?.result != null && (
              <span className="mt-1 block border-t border-border/40 pt-1 text-foreground/70">
                {String(tool.result)}
              </span>
            )}
          </pre>
        )}
      </div>
    </div>
  );
});

// ─── pure helpers ───────────────────────────────────────────────────────────

/** Concatenated text from a message's text parts. */
function extractText(message) {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p?.type === "text").map((p) => p.text || "").join("");
  }
  return "";
}

/** Tool-call parts from a message. */
function extractToolCalls(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content.filter((p) => p?.type === "tool-call");
}

/** DiceBear seed for the speaker, consistent with SessionList. */
function speakerSeed(speaker, session) {
  if (!session) return "manus-open";
  if (session.id === "default") return "manus-open";
  return speaker || session.id;
}

/** Display label for the speaker. */
function speakerLabel(speaker, session) {
  if (speaker && speaker.startsWith("agent:")) return speaker.slice(6);
  if (session?.kind === "subagent") return session.name || "agent";
  if (session?.kind === "team") return speaker || "team";
  return speaker || "Manus";
}
