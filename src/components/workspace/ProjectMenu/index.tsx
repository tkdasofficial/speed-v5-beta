import { useNavigate } from "@tanstack/react-router";
import { Check, Download, FolderOpen, Lock, MoreHorizontal, Pencil, Plug, Plus, Repeat, Settings, Shield, X } from "lucide-react";
import { useState } from "react";
import { useProjects } from "@/lib/sync";
import { Button } from "@/components/ui/button";


export function ProjectMenu({ name, setName, onClose, onSettings }: { name: string; setName: (n: string) => void; onClose: () => void; onSettings: () => void }) {
  const navigate = useNavigate();
  const recent = (useProjects() ?? []).slice(0, 6);
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  const go = (to: "/dashboard" | "/import" | "/library" | "/integrations") => { onClose(); void navigate({ to }); };
  const nav = [
    { icon: Plus, label: "New project", to: "/dashboard" as const },
    { icon: Download, label: "Import", to: "/import" as const },
    { icon: FolderOpen, label: "Library", to: "/library" as const },
    { icon: Repeat, label: "Routines" },
    { icon: Plug, label: "Integrations", to: "/integrations" as const },
    { icon: Shield, label: "Security" },
  ];
  const save = () => { if (val.trim()) setName(val.trim()); setEditing(false); };

  return (
    <>
      <button type="button" aria-label="Close menu" className="fixed inset-0 z-30 bg-background/60" onClick={onClose} />
      <div className="fixed inset-x-2 top-[calc(52px+env(safe-area-inset-top))] z-40 mx-auto max-h-[75dvh] max-w-md overflow-y-auto rounded-[8px] border border-border bg-card p-2">
        <div className="flex items-center gap-2 rounded-[6px] p-2">
          {editing ? (
            <form className="flex flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} aria-label="Project name" className="h-9 min-w-0 flex-1 rounded-[6px] border border-primary bg-background px-2.5 text-[14px] outline-none" />
              <button type="submit" aria-label="Save name" className="grid h-9 w-9 place-items-center rounded-[6px] bg-cta text-cta-foreground"><Check className="!h-4 !w-4" /></button>
              <button type="button" aria-label="Cancel rename" onClick={() => { setVal(name); setEditing(false); }} className="grid h-9 w-9 place-items-center rounded-[6px] border border-border"><X className="!h-4 !w-4" /></button>
            </form>
          ) : (
            <>
              <div className="min-w-0 flex-1"><small className="block text-[11px] text-muted-foreground">Current project · Personal workspace</small><b className="block truncate text-[15px] font-semibold">{name}</b></div>
              <button type="button" onClick={() => setEditing(true)} className="flex h-8 items-center gap-1.5 rounded-[6px] border border-border px-2.5 text-[12px] font-medium"><Pencil className="!h-3.5 !w-3.5" /> Rename</button>
            </>
          )}
        </div>
        <div className="my-1 h-px bg-border" />
        <div className="grid">
          <Button type="button" variant="ghost" onClick={onSettings} className="flex h-10 justify-start gap-3 rounded-[6px] px-2 text-left text-[14px]"><Settings className="!h-4 !w-4 text-muted-foreground" /> Settings</Button>
          {nav.map((n) => (
            <button key={n.label} type="button" onClick={() => (n.to ? go(n.to) : onClose())} className="flex h-10 items-center gap-3 rounded-[6px] px-2 text-left text-[14px] hover:bg-accent">
              <n.icon className="!h-4 !w-4 text-muted-foreground" /> {n.label}
              {!n.to && <span className="ml-auto text-[11px] text-muted-foreground">Soon</span>}
            </button>
          ))}
        </div>
        <div className="my-1 h-px bg-border" />
        <h4 className="m-0 px-2 py-1.5 text-[11px] font-bold uppercase text-muted-foreground">Recent projects</h4>
        {recent.map(({ name: p, slug }) => (
          <div key={slug} className="flex h-10 items-center gap-2 rounded-[6px] px-2 hover:bg-accent">
            <button type="button" onClick={() => { onClose(); void navigate({ to: "/project/$projectId", params: { projectId: slug } }); }} className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[14px]">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px] border border-border text-[11px] font-bold">{p[0]}</span>
              <span className="truncate">{p}</span><Lock className="!h-3 !w-3 shrink-0 text-muted-foreground" />
            </button>
            <button type="button" aria-label={`More for ${p}`} className="grid h-7 w-7 place-items-center rounded-[5px] text-muted-foreground"><MoreHorizontal className="!h-4 !w-4" /></button>
          </div>
        ))}
        <div className="mt-2 grid gap-2 rounded-[6px] border border-border p-3">
          <div className="flex items-center justify-between text-[13px]"><b className="font-semibold">Model usage</b><span className="text-muted-foreground">38% this month</span></div>
          <div className="h-1 overflow-hidden rounded-[2px] bg-accent"><div className="h-full w-[38%] bg-primary" /></div>
          <button type="button" className="h-8 rounded-[6px] border border-border text-[13px] font-semibold">Use smarter models</button>
        </div>
      </div>
    </>
  );
}
