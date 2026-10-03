import type React from "react";
import { ArrowDown, Bot, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionGroup } from "@/components/workspace/ActionGroup";
import { ChatInput } from "@/components/ChatInput";
import type { ChatItem } from "@/lib/workspace-types";
import type { AgentPlan } from "@/lib/workspace";
import { PlanCard } from "@/components/workspace/PlanCard";

export function ChatView({ header, items, onSend, onRollback, onStop, activeStep, plan, onPlanDecision }: { header?: React.ReactNode; plan?: { plan: AgentPlan; version: number } | undefined; onPlanDecision?: ((d: "approve" | "deny" | "edit", feedback?: string) => Promise<void>) | undefined; activeStep?: string | null | undefined; items: ChatItem[]; onSend: (text: string) => Promise<void> | void; onRollback?: (snapshotId: string) => void; onStop?: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [busy, setBusy] = useState(false);
  const timers = useRef<number[]>([]);

  const toBottom = useCallback((smooth = true) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => { toBottom(false); }, [toBottom]);
  useEffect(() => { if (atBottom) toBottom(); }, [items, atBottom, toBottom]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

  const [failed, setFailed] = useState<{ text: string; error: string } | null>(null);
  const send = async (text: string) => {
    setAtBottom(true);
    setFailed(null);
    setBusy(true);
    try { await onSend(text); }
    catch (e) { setFailed({ text, error: e instanceof Error ? e.message : "The AI couldn't answer. Try again." }); }
    finally { setBusy(false); }
  };

  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [plan?.version]);
  const sendOrEdit = (text: string) => {
    if (plan && editing && onPlanDecision) { setAtBottom(true); void onPlanDecision("edit", text).then(() => setEditing(false)).catch((e: unknown) => setFailed({ text, error: e instanceof Error ? e.message : "Couldn't update the plan" })); return; }
    void send(text);
  };
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    onStop?.();
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items.length === 0 && !header ? <EmptyChat /> : (
          <div className="mx-auto grid w-full min-w-0 max-w-2xl gap-3 px-4 pb-6 pt-4">
            {header}
            {items.map((item) => <Item key={item.id} item={item} onRollback={onRollback} />)}
            {(busy || activeStep) && <Item item={{ id: "thinking", type: "status", text: activeStep ? `${activeStep}…` : "Starting…", state: "running" }} />}
            {failed && !busy && (
              <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-destructive">
                <XCircle className="!h-4 !w-4" /> {failed.error}
                <button type="button" onClick={() => void send(failed.text)} className="h-7 rounded-[6px] border border-border px-2.5 text-foreground">Retry</button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="relative shrink-0 px-3 pb-2 pt-1">
        {!atBottom && items.length > 0 && (
          <button type="button" onClick={() => { toBottom(); setAtBottom(true); }} className="absolute -top-11 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3.5 text-[13px] font-semibold shadow-lg">
            <ArrowDown className="!h-4 !w-4" /> Scroll to latest
          </button>
        )}
        <div className="mx-auto max-w-2xl">
          {plan && onPlanDecision && !activeStep && <PlanCard plan={plan.plan} version={plan.version} editing={editing} onEdit={() => setEditing(true)} onDecide={(d) => onPlanDecision(d)} />}
          <ChatInput onSend={sendOrEdit} busy={busy || !!activeStep} onStop={stop} {...(plan && editing ? { placeholder: "Describe what to change in the plan…" } : {})} />
        </div>
      </div>
    </div>
  );
}

function Item({ item, onRollback }: { item: ChatItem; onRollback?: ((snapshotId: string) => void) | undefined }) {
  switch (item.type) {
    case "user":
      return (
        <div className="grid justify-items-end gap-1">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-[16px] rounded-br-[6px] bg-primary px-4 py-2.5 shadow-[0_16px_40px_-22px_var(--primary)] text-[15px] leading-6 text-primary-foreground">{item.text}</div>
          <span className="text-[11px] text-muted-foreground">{item.time}</span>
        </div>
      );
    case "ai":
      return <p className="m-0 text-[15px] leading-6 text-foreground">{item.text}</p>;
    case "actions":
      return <ActionGroup actions={item.actions} />;
    case "status": {
      const Icon = item.state === "running" ? Loader2 : item.state === "failed" ? XCircle : Clock;
      return (
        <div className={`flex items-center gap-2 text-[13px] font-medium ${item.state === "running" ? "text-foreground/85" : item.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
          <Icon className={`!h-4 !w-4 ${item.state === "running" ? "animate-spin" : ""}`} /> {item.text}
        </div>
      );
    }
    case "checkpoint":
      return (
        <div className="flex h-10 items-center gap-2 rounded-[12px] border border-border bg-gradient-to-b from-card to-background px-3 text-[13px] text-muted-foreground">
          <CheckCircle2 className="!h-4 !w-4" /> {item.text}
          {item.snapshotId && onRollback && <button type="button" onClick={() => { if (item.snapshotId && window.confirm("Restore this snapshot? Current files will be replaced.")) onRollback(item.snapshotId); }} className="ml-auto text-[12px] font-semibold text-foreground hover:underline">Rollback</button>}
        </div>
      );
  }
}

function EmptyChat() {
  return (
    <div className="relative mx-auto flex min-h-full max-w-md flex-col items-center justify-center overflow-hidden px-6 py-10 text-center">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[10%] h-[320px] w-[140%] -translate-x-1/2 bg-[radial-gradient(50%_50%_at_50%_50%,color-mix(in_oklab,var(--primary)_30%,transparent),transparent_70%)] blur-[10px]" />
      <div className="relative grid h-12 w-12 place-items-center rounded-[12px] border border-primary/45 bg-primary/20"><Bot className="!h-5 !w-5" /></div>
      <h2 className="relative mb-2 mt-5 text-[26px] font-extrabold leading-tight tracking-[-0.03em]">New chat with Agent</h2>
      <p className="relative m-0 text-[15px] leading-relaxed text-muted-foreground">Describe what to build or change. The agent reads your project, makes edits and tests them.</p>
    </div>
  );
}
