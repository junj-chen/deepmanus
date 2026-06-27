import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { Plus, MessageSquare, Users, Trash2, Loader2 } from "lucide-react";

import { useStore } from "@/hooks/useStore";
import { cn } from "@/lib/utils";

/**
 * SessionList — left rail with "Running | History" tabs.
 *
 * - Running: sessions whose status is "running" (live teams / active work).
 * - History: everything else (past chats & finished teams).
 * Single-agent chats and teams are mixed within each tab, distinguished by a
 * small icon (chat bubble vs users) + a status dot.
 */
export const SessionList = observer(function SessionList() {
  const { sessions } = useStore();
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("running");

  useEffect(() => {
    sessions.load();
  }, [sessions]);

  const handleNew = async () => {
    setCreating(true);
    try {
      await sessions.create();
    } finally {
      setCreating(false);
    }
  };

  const running = sessions.sessions.filter((s) => s.status === "running");
  const history = sessions.sessions.filter((s) => s.status !== "running");
  const list = tab === "running" ? running : history;

  return (
    <div className="flex h-full flex-col bg-card">
      {/* New chat */}
      <div className="px-2.5 pb-2 pt-3">
        <button
          onClick={handleNew}
          disabled={creating}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border/60 py-1.5 text-[13px] text-foreground/80 transition hover:border-accent/40 hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-3.5 text-accent" />
          New chat
        </button>
      </div>

      {/* Running | History tabs */}
      <div className="flex gap-1 px-2.5 pb-2">
        {[
          { key: "running", label: "Running", count: running.length },
          { key: "history", label: "History", count: history.length },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition",
              tab === t.key
                ? "bg-sidebar text-foreground"
                : "text-muted-foreground hover:text-foreground/70",
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className="text-[9px] text-muted-foreground/60">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.loading && (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">Loading…</p>
        )}
        {sessions.error && (
          <p className="px-2.5 py-2 text-xs text-destructive">{sessions.error}</p>
        )}
        {!sessions.loading && list.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            {tab === "running" ? "No active sessions." : "No history yet."}
          </p>
        )}

        <ul className="space-y-0.5">
          {list.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === sessions.activeId}
              onSelect={() => sessions.select(s.id)}
              onDelete={() => sessions.remove(s.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
});

function SessionItem({ session, active, onSelect, onDelete }) {
  const isTeam = session.kind === "team";
  const isRunning = session.status === "running";
  return (
    <li>
      <button
        onClick={onSelect}
        className={cn(
          "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition",
          active
            ? "bg-sidebar text-foreground"
            : "text-muted-foreground hover:bg-sidebar/50 hover:text-foreground/80",
        )}
      >
        {active && (
          <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-accent" />
        )}
        {isRunning ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : isTeam ? (
          <Users className="size-3.5 shrink-0 text-accent/60" />
        ) : (
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground/60" />
        )}
        <span className="flex-1 truncate">
          {session.title || session.id.slice(0, 12)}
        </span>
        <Trash2
          className="size-3 shrink-0 opacity-0 transition group-hover:opacity-60 hover:!opacity-100 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        />
      </button>
    </li>
  );
}
