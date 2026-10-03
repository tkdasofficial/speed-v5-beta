import { Check, BookOpen, Brain, ChevronUp, FilePen, FilePlus, FlaskConical, Image, Loader2, Play, ScanEye, Search, Wrench, X, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ActionKind, AgentAction } from "@/lib/workspace-types";

export const actionIcon: Record<ActionKind, LucideIcon> = {
  read: BookOpen, search: Search, edit: FilePen, create: FilePlus, run: Play, asset: Image,
  test: FlaskConical, inspect: ScanEye, fix: Wrench, think: Brain,
};

export function ActionRow({ action }: { action: AgentAction }) {
  const Icon = action.status === "running" ? Loader2 : action.status === "failed" || action.status === "cancelled" ? X : actionIcon[action.kind];
  const tone = action.status === "running" ? "text-foreground/85" : action.status === "failed" ? "text-destructive" : action.status === "pending" ? "text-muted-foreground/70" : "text-muted-foreground";
  const row = (
    <div className={`flex h-9 min-w-0 items-center gap-2.5 rounded-[6px] border px-2.5 ${action.status === "failed" ? "border-destructive/40" : action.status === "running" ? "border-primary/60" : "border-border"} bg-card`}>
      <Icon className={`!h-4 !w-4 shrink-0 ${tone} ${action.status === "running" ? "animate-spin" : ""}`} />
      {action.status === "running" && <span className="shrink-0 text-[12px] font-semibold text-primary">Processing…</span>}
      <span className={`min-w-0 truncate text-[13px] font-medium ${action.status === "pending" ? "text-muted-foreground/60" : ""}`}>{action.title}</span>
      {action.status === "done" && <Check className="ml-auto !h-3.5 !w-3.5 shrink-0 text-primary" aria-label="Completed" />}
      {action.target && <span className="min-w-0 truncate text-[12px] text-muted-foreground">{action.target}</span>}
      {action.status === "failed" && <span className="ml-auto shrink-0 text-[11px] font-bold text-destructive">{action.fixed ? "Fixed" : "Failed"}</span>}
      {action.status === "cancelled" && <span className="ml-auto shrink-0 text-[11px] font-bold text-muted-foreground">Cancelled</span>}
      {action.status === "pending" && <span className="ml-auto shrink-0 text-[11px] font-bold text-muted-foreground">Queued</span>}
    </div>
  );
  if (!action.detail) return row;
  return <div className="grid gap-1">{row}<p className={`m-0 break-words px-2.5 text-[12px] leading-5 ${action.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{action.detail}</p></div>;
}

export function ActionGroup({ actions }: { actions: AgentAction[] }) {
  const [userOpen, setOpen] = useState<boolean | null>(null);
  const running = actions.some((a) => a.status === "running");
  // Live rounds stay expanded so each action's Processing → completed state is visible.
  const open = userOpen ?? running;
  const fixed = actions.filter((a) => a.status === "failed" && a.fixed).length;
  const failed = actions.filter((a) => a.status === "failed" && !a.fixed).length;
  const chips = actions.length > 6 ? [...actions.slice(0, 4), null, actions[actions.length - 1]] : actions;
  if (open) {
    return (
      <div className="grid gap-1.5">
        <button type="button" onClick={() => setOpen(false)} aria-expanded className="flex h-8 w-fit items-center gap-2 rounded-[6px] px-1 text-[13px] font-medium text-muted-foreground hover:text-foreground">
          <ChevronUp className="!h-4 !w-4" /> Show less
        </button>
        {actions.map((a) => <ActionRow key={a.id} action={a} />)}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => setOpen(true)} aria-expanded={false} className="flex h-9 w-fit max-w-full items-center gap-2.5 rounded-[6px] text-[13px] font-medium text-muted-foreground hover:text-foreground">
      <span className="flex items-center gap-1">
        {chips.map((a, i) => {
          const Icon = a ? (a.status === "running" ? Loader2 : actionIcon[a.kind]) : null;
          return (
            <i key={a?.id ?? `more${i}`} className={`grid h-7 w-7 place-items-center rounded-[5px] border ${a?.status === "failed" ? "border-destructive/50 text-destructive" : a?.status === "running" ? "border-primary text-primary" : "border-border"}`}>
              {Icon ? <Icon className={`!h-3.5 !w-3.5 ${a?.status === "running" ? "animate-spin" : ""}`} /> : <span className="text-[11px] leading-none">•••</span>}
            </i>
          );
        })}
      </span>
      <span className="whitespace-nowrap">{actions.length} actions{fixed > 0 ? <span className="text-destructive"> · {fixed} fixed</span> : null}{failed > 0 && !running ? <span className="text-destructive"> · {failed} failed</span> : null}</span>
    </button>
  );
}
