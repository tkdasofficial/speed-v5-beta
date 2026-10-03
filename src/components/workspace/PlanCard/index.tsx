// Compact plan approval card shown above the prompt box while the server task awaits a decision.
// Expand opens the full plan; Deny / Edit / Approve send the decision to the real server task.
import { Maximize2, Minimize2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentPlan } from "@/lib/workspace";

type Decision = "approve" | "deny" | "edit";

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="grid gap-1.5">
      <h3 className="m-0 text-[12px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
      <ul className="m-0 grid gap-1 pl-4 text-[14px] leading-6">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </section>
  );
}

export function PlanBody({ plan }: { plan: AgentPlan }) {
  return (
    <div className="grid gap-4">
      {plan.summary && <p className="m-0 text-[15px] leading-6">{plan.summary}</p>}
      <Section title="Create" items={plan.create} />
      <Section title="Modify" items={plan.modify} />
      <Section title="Pages & components" items={plan.pages} />
      <Section title="Design" items={plan.design} />
      <Section title="Functionality" items={plan.functional} />
      <Section title="Validation" items={plan.validation} />
    </div>
  );
}

export function PlanCard({ plan, version, editing, onEdit, onDecide }: { plan: AgentPlan; version: number; editing: boolean; onEdit: () => void; onDecide: (d: Exclude<Decision, "edit">) => Promise<void> }) {
  const [full, setFull] = useState(false);
  const [sending, setSending] = useState<Decision | null>(null);
  useEffect(() => { setSending(null); }, [version]);
  const decide = async (d: Exclude<Decision, "edit">) => {
    setSending(d);
    try { await onDecide(d); } catch { setSending(null); }
  };
  const files = [...plan.create, ...plan.modify];
  const actions = (
    <div className="flex items-center gap-2">
      <button type="button" disabled={!!sending} onClick={() => void decide("deny")} className="h-8 rounded-[6px] border border-border px-3 text-[13px] font-semibold text-muted-foreground hover:text-destructive disabled:opacity-50">
        {sending === "deny" ? <Loader2 className="!h-4 !w-4 animate-spin" /> : "Deny"}
      </button>
      <span className="flex-1" />
      <button type="button" disabled={!!sending} onClick={() => { setFull(false); onEdit(); }} className={`h-8 rounded-[6px] border px-3 text-[13px] font-semibold disabled:opacity-50 ${editing ? "border-primary text-primary" : "border-border"}`}>Edit</button>
      <button type="button" disabled={!!sending} onClick={() => void decide("approve")} className="flex h-8 items-center rounded-[6px] bg-primary px-3.5 text-[13px] font-bold text-primary-foreground disabled:opacity-50">
        {sending === "approve" ? <Loader2 className="!h-4 !w-4 animate-spin" /> : "Approve"}
      </button>
    </div>
  );

  return (
    <>
      <div className="mb-2 grid gap-2 rounded-[12px] border border-border bg-card p-2.5 shadow-[0_18px_40px_-28px_var(--primary)]">
        <div className="relative aspect-video max-h-44 w-full overflow-hidden rounded-[8px] border border-border bg-background p-3">
          <button type="button" aria-label="Expand plan" onClick={() => setFull(true)} className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-[6px] border border-border bg-card text-muted-foreground hover:text-foreground">
            <Maximize2 className="!h-3.5 !w-3.5" />
          </button>
          <p className="m-0 pr-9 text-[11px] font-bold uppercase tracking-[0.08em] text-primary">Plan{version > 1 ? ` · v${version}` : ""}</p>
          <h3 className="m-0 mt-1 pr-9 text-[15px] font-semibold leading-5">{plan.title}</h3>
          {plan.summary && <p className="m-0 mt-1.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{plan.summary}</p>}
          {files.length > 0 && <p className="m-0 mt-2 truncate text-[12px] text-muted-foreground">Files: {files.join(", ")}</p>}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background to-transparent" />
        </div>
        {editing && <p className="m-0 px-1 text-[13px] font-medium">What would you like to change in this plan?</p>}
        {actions}
      </div>
      {full && (
        <div role="dialog" aria-modal="true" aria-label="Full plan" className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <h2 className="m-0 min-w-0 flex-1 truncate text-[16px] font-semibold">{plan.title}</h2>
            <button type="button" aria-label="Close plan" onClick={() => setFull(false)} className="grid h-9 w-9 place-items-center rounded-[6px] border border-border text-muted-foreground hover:text-foreground">
              <Minimize2 className="!h-4 !w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-2xl px-5 py-5"><PlanBody plan={plan} /></div></div>
          <div className="shrink-0 border-t border-border px-4 py-3"><div className="mx-auto max-w-2xl">{actions}</div></div>
        </div>
      )}
    </>
  );
}
