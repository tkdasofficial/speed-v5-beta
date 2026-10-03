import { ArrowLeft, Camera, ChevronDown, ChevronRight, Copy, File, FileCode, FileJson, FilePlus, FileText, Folder, FolderInput, FolderOpen, FolderPlus, History, MoreHorizontal, Pencil, RefreshCw, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { TreeNode } from "@sandbox/types/filesystem";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { WorkspaceStore, WorkspaceView } from "@/lib/workspace";

type Ask = { title: string; label: string; initial: string; submit: string; danger?: boolean; confirmOnly?: boolean; onSubmit: (v: string) => boolean | void };

const iconFor = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "html", "css"].includes(ext)) return FileCode;
  if (ext === "json") return FileJson;
  if (["md", "txt"].includes(ext)) return FileText;
  return File;
};
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

export function FilesView({ store, view }: { store: WorkspaceStore; view: WorkspaceView }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [snaps, setSnaps] = useState(false);
  const [showTree, setShowTree] = useState(!view.active);
  const dirty = new Set(view.openFiles.filter((f) => f.dirty).map((f) => f.path));
  const baseDir = view.selected && store.sandbox.isFolder(view.selected) ? view.selected : view.selected ? parentOf(view.selected) : "";

  const newFile = (dir = baseDir) => setAsk({ title: "New file", label: "Path", initial: dir ? `${dir}/` : "", submit: "Create", onSubmit: (v) => { const ok = store.createFile(v.trim()); if (ok) setShowTree(false); return ok; } });
  const newFolder = (dir = baseDir) => setAsk({ title: "New folder", label: "Path", initial: dir ? `${dir}/` : "", submit: "Create", onSubmit: (v) => store.createFolder(v.trim()) });
  const rowMenu = (n: TreeNode) => [
    ...(n.type === "folder" ? [
      { icon: FilePlus, label: "New file here", run: () => newFile(n.path) },
      { icon: FolderPlus, label: "New folder here", run: () => newFolder(n.path) },
    ] : []),
    { icon: Pencil, label: "Rename", run: () => setAsk({ title: `Rename ${n.type}`, label: "New name", initial: n.name, submit: "Rename", onSubmit: (v) => store.rename(n.path, v.trim()) }) },
    { icon: FolderInput, label: "Move", run: () => setAsk({ title: `Move ${n.type}`, label: "New path", initial: n.path, submit: "Move", onSubmit: (v) => store.move(n.path, v.trim()) }) },
    { icon: Copy, label: "Copy", run: () => setAsk({ title: `Copy ${n.type}`, label: "Copy to", initial: `${n.path}-copy`, submit: "Copy", onSubmit: (v) => store.copy(n.path, v.trim()) }) },
    { icon: Trash2, label: "Delete", run: () => setAsk({ title: `Delete ${n.name}?`, label: n.type === "folder" ? "Everything inside this folder will be deleted." : "This file will be deleted.", initial: "", submit: "Delete", danger: true, confirmOnly: true, onSubmit: () => store.remove(n.path) }) },
  ];

  const renderTree = (nodes: TreeNode[], depth: number): React.ReactNode => nodes.map((n) => {
    const open = view.expanded.includes(n.path);
    const Icon = n.type === "folder" ? (open ? FolderOpen : Folder) : iconFor(n.name);
    const isActive = view.active?.path === n.path;
    return (
      <div key={n.path}>
        <div className={`group flex h-8 items-center rounded-[6px] pr-1 ${isActive ? "bg-primary/20" : view.selected === n.path ? "bg-accent" : "hover:bg-accent"}`}>
          <button type="button" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => { if (n.type === "folder") store.toggleFolder(n.path); else { store.open(n.path); setShowTree(false); } }} className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[13px]">
            {n.type === "folder" ? (open ? <ChevronDown className="!h-3.5 !w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="!h-3.5 !w-3.5 shrink-0 text-muted-foreground" />) : <span className="w-3.5 shrink-0" />}
            <Icon className="!h-4 !w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{n.name}</span>
            {dirty.has(n.path) && <span aria-label="Unsaved changes" className="ml-1 h-2 w-2 shrink-0 rounded-full bg-primary" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label={`Actions for ${n.name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:text-foreground"><MoreHorizontal className="!h-4 !w-4" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-card text-foreground">
              {rowMenu(n).map((m) => <DropdownMenuItem key={m.label} onSelect={m.run} className={m.label === "Delete" ? "text-destructive" : ""}><m.icon className="!h-4 !w-4" /> {m.label}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {n.type === "folder" && open && n.children && (n.children.length ? renderTree(n.children, depth + 1) : <p style={{ paddingLeft: 34 + depth * 14 }} className="m-0 py-1 text-[12px] text-muted-foreground">Empty folder</p>)}
      </div>
    );
  });

  const tool = "h-8 w-8 rounded-[8px] bg-card";
  const explorer = (
    <aside className={`${showTree ? "flex" : "hidden"} min-h-0 w-full flex-col border-border md:flex md:w-[260px] md:shrink-0 md:border-r`}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <b className="mr-auto pl-1 text-[12px] font-bold uppercase text-muted-foreground">Files</b>
        <Button type="button" variant="outline" size="icon" aria-label="New file" title="New file" onClick={() => newFile()} className={tool}><FilePlus className="!h-4 !w-4" /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="New folder" title="New folder" onClick={() => newFolder()} className={tool}><FolderPlus className="!h-4 !w-4" /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="Refresh files" title="Refresh files" onClick={() => store.refresh()} className={tool}><RefreshCw className="!h-4 !w-4" /></Button>
        <Button type="button" variant="outline" size="icon" aria-label="Snapshots" title="Snapshots" onClick={() => setSnaps(true)} className={tool}><History className="!h-4 !w-4" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" onClick={(e) => { if (e.target === e.currentTarget) store.select(null); }}>
        {view.tree.length ? renderTree(view.tree, 0) : (
          <div className="grid gap-3 p-4 text-center text-[13px] text-muted-foreground">
            <p className="m-0">This project has no files yet.</p>
            <Button type="button" variant="outline" onClick={() => newFile("")} className="mx-auto h-9 rounded-[8px]"><FilePlus className="!h-4 !w-4" /> Create a file</Button>
          </div>
        )}
      </div>
    </aside>
  );

  const a = view.active;
  const editor = (
    <section className={`${showTree ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col md:flex`}>
      <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-1">
        <Button type="button" variant="ghost" size="icon" aria-label="Show files" onClick={() => setShowTree(true)} className="h-8 w-8 shrink-0 md:hidden"><ArrowLeft className="!h-4 !w-4" /></Button>
        {view.openFiles.map((f) => (
          <div key={f.path} className={`flex h-8 shrink-0 items-center rounded-[6px] border text-[12px] ${f.path === a?.path ? "border-primary/60 bg-card" : "border-transparent text-muted-foreground"}`}>
            <button type="button" onClick={() => store.setActive(f.path)} className="flex h-full items-center gap-1.5 pl-2.5 pr-1">{f.path.split("/").pop()}{f.dirty && <span aria-label="Unsaved" className="h-1.5 w-1.5 rounded-full bg-primary" />}</button>
            <button type="button" aria-label={`Close ${f.path}`} onClick={() => { if (!f.dirty || window.confirm(`Close ${f.path} and lose unsaved changes?`)) store.close(f.path); }} className="grid h-full w-6 place-items-center"><X className="!h-3 !w-3" /></button>
          </div>
        ))}
      </div>
      {a ? (
        <>
          {a.conflict && (
            <div className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px]">
              <span className="mr-auto font-medium text-destructive">{a.conflict.kind === "deleted" ? "This file was deleted. Save to recreate it, or discard to close." : "This file changed on disk while you had unsaved edits."}</span>
              {a.conflict.kind === "changed" && <>
                <button type="button" onClick={() => store.acceptDisk(a.path)} className="h-7 rounded-[6px] border border-border px-2.5">Load disk version</button>
                <button type="button" onClick={() => store.save(a.path, true)} className="h-7 rounded-[6px] border border-border px-2.5">Keep mine</button>
              </>}
            </div>
          )}
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-[12px] text-muted-foreground">
            <span className="min-w-0 truncate">{a.path}</span><span>· {a.language}</span>
            <span className="ml-auto">{a.dirty ? "Unsaved" : "Saved"}</span>
            <button type="button" disabled={!a.dirty} onClick={() => store.discard(a.path)} className="flex h-7 items-center gap-1 rounded-[6px] border border-border px-2 text-foreground disabled:opacity-40"><RotateCcw className="!h-3.5 !w-3.5" /> Discard</button>
            <button type="button" disabled={!a.dirty} onClick={() => store.save(a.path)} className="flex h-7 items-center gap-1 rounded-[6px] bg-primary px-2 font-semibold text-primary-foreground disabled:opacity-40"><Save className="!h-3.5 !w-3.5" /> Save</button>
          </div>
          <textarea
            key={a.path}
            aria-label={`Editing ${a.path}`}
            spellCheck={false}
            value={a.content}
            onChange={(e) => store.edit(a.path, e.target.value, { start: e.target.selectionStart, end: e.target.selectionEnd })}
            onSelect={(e) => store.edit(a.path, e.currentTarget.value, { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); store.save(a.path); } }}
            ref={(el) => { if (el && document.activeElement !== el) el.setSelectionRange(a.selection.start, a.selection.end); }}
            className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-[13px] leading-6 text-foreground outline-none"
          />
        </>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-muted-foreground">Open a file from the list to edit it.</div>
      )}
    </section>
  );

  return (
    <div className="flex min-h-0 flex-1">
      {explorer}{editor}
      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} />}
      {snaps && <SnapshotsDialog store={store} view={view} onClose={() => setSnaps(false)} />}
    </div>
  );
}

function AskDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const [v, setV] = useState(ask.initial);
  const submit = () => { if (!ask.confirmOnly && !v.trim()) return; if (ask.onSubmit(v) !== false) onClose(); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader><DialogTitle>{ask.title}</DialogTitle></DialogHeader>
        {ask.confirmOnly ? <p className="m-0 text-[14px] text-muted-foreground">{ask.label}</p> : (
          <label className="grid gap-1 text-[12px] text-muted-foreground">{ask.label}
            <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} className="h-10 rounded-[8px] border border-border bg-background px-3 text-[14px] text-foreground outline-none focus:border-primary" />
          </label>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="button" onClick={submit} className={ask.danger ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}>{ask.submit}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnapshotsDialog({ store, view, onClose }: { store: WorkspaceStore; view: WorkspaceView; onClose: () => void }) {
  const [label, setLabel] = useState("");
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="border-border bg-card text-foreground">
        <DialogHeader><DialogTitle>Snapshots</DialogTitle></DialogHeader>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (store.createSnapshot(label.trim() || new Date().toLocaleString())) setLabel(""); }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Snapshot name (optional)" aria-label="Snapshot name" className="h-9 min-w-0 flex-1 rounded-[8px] border border-border bg-background px-3 text-[14px] outline-none focus:border-primary" />
          <Button type="submit" className="h-9"><Camera className="!h-4 !w-4" /> Save</Button>
        </form>
        <div className="grid max-h-[50dvh] gap-1.5 overflow-y-auto">
          {view.snapshots.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">No snapshots yet. A snapshot saves every file and your open editors so you can return to this point.</p>}
          {view.snapshots.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-[8px] border border-border p-2 text-[13px]">
              <div className="min-w-0 flex-1"><b className="block truncate font-semibold">{s.label}</b><small className="text-muted-foreground">{new Date(s.createdAt).toLocaleString()} · {s.fileCount} files</small></div>
              <button type="button" onClick={() => { if (window.confirm("Restore this snapshot? Current files will be replaced.")) store.restoreSnapshot(s.id); }} className="h-7 rounded-[6px] border border-border px-2.5">Restore</button>
              <button type="button" aria-label="Delete snapshot" onClick={() => store.deleteSnapshot(s.id)} className="grid h-7 w-7 place-items-center rounded-[6px] border border-border text-destructive"><Trash2 className="!h-3.5 !w-3.5" /></button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
