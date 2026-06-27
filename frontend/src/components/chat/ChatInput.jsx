import { useState } from "react";
import { Send, Paperclip, Cpu, Square } from "lucide-react";

import { cn } from "@/lib/utils";

// Quick suggestion chips shown above the input when empty.
const SUGGESTIONS = [
  "List files in the current directory",
  "Explain this project",
  "Delegate a research task to a team",
];

/**
 * ChatInput — multi-function input area (replaces CopilotChat's input).
 *
 * Layout: suggestion chips (when empty) + a rounded input row with attachment
 * toggle, model picker (placeholder), and send/stop button.
 */
export function ChatInput({ onSend, isLoading, onStop }) {
  const [value, setValue] = useState("");

  const submit = () => {
    const text = value.trim();
    if (!text || isLoading) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="px-2 pb-3 pt-2">
      <div className="content-narrow">
        {/* suggestions when empty */}
        {!value && !isLoading && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setValue(s)}
                className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-accent/40 hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* input row */}
        <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-card px-3 py-2 transition focus-within:border-accent/40">
          {/* attachment (placeholder) */}
          <button
            className="mb-0.5 rounded-md p-1 text-muted-foreground transition hover:text-foreground"
            title="Attach (coming soon)"
          >
            <Paperclip className="size-4" />
          </button>

          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Message deepopen…"
            className="max-h-40 flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
          />

          {/* model picker (placeholder) */}
          <button
            className="mb-0.5 rounded-md p-1 text-muted-foreground transition hover:text-foreground"
            title="Model (coming soon)"
          >
            <Cpu className="size-4" />
          </button>

          {/* send / stop */}
          {isLoading ? (
            <button
              onClick={onStop}
              className="mb-0.5 flex size-7 items-center justify-center rounded-md bg-destructive/15 text-destructive transition hover:bg-destructive/25"
              title="Stop"
            >
              <Square className="size-3.5" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!value.trim()}
              className={cn(
                "mb-0.5 flex size-7 items-center justify-center rounded-md transition",
                value.trim()
                  ? "bg-accent/15 text-accent hover:bg-accent/25"
                  : "bg-muted/30 text-muted-foreground/40",
              )}
              title="Send"
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
