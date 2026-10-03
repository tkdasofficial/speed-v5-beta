import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronLeft, ChevronRight, Code2, File, FileCode2, Folder, FolderGit2, Github, GitBranch, GitCommitHorizontal, MoreHorizontal, Search } from "lucide-react";
import { useRef, useState } from "react";
import type { ChangedFile, FileNode } from "@/lib/workspace-types";

const changedFiles: ChangedFile[] = [];
const fileContents: Record<string, string> = {};
const fileTree: FileNode[] = [];

export type Category = "git" | "code" | "files";
const cats: { id: Category; label: string; icon: typeof Code2; desc: string }[] = [
  { id: "git", label: "Git", icon: FolderGit2, desc: "Repository, branches, commits and GitHub" },
  { id: "code", label: "Code", icon: Code2, desc: "Browse and edit project source" },
  { id: "files", label: "Files", icon: Folder, desc: "Project file tree and file actions" },
];
const order: Category[] = ["git", "code", "files"];

export function Categories({ onClose, code }: { onClose: () => void; code?: React.ReactNode }) {
  const [active, setActive] = useState<Category | null>(null);
  const [openFile, setOpenFile] = useState("src/App.tsx");
  const touch = useRef<{ x: number; y: number } | null>(null);

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!touch.current) return;
    const t0 = e.changedTouches[0]; if (!t0) return;
    const dx = t0.clientX - touch.current.x;
    const dy = t0.clientY - touch.current.y;
    touch.current = null;
    if (dy < -90 && Math.abs(dy) > Math.abs(dx)) { if (active) setActive(null); else onClose(); return; }
    if (active && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
      const i = order.indexOf(active);
      setActive(order[(i + (dx < 0 ? 1 : -1) + order.length) % order.length] ?? null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]" onTouchStart={(e) => { const t = e.touches[0]; if (t) touch.current = { x: t.clientX, y: t.clientY }; }} onTouchEnd={onTouchEnd}>
      <div className="grid h-12 shrink-0 grid-cols-[40px_minmax(0,1fr)_40px] items-center border-b border-border px-2">
        {active ? (
          <button type="button" aria-label="Back to categories" onClick={() => setActive(null)} className="grid h-9 w-9 place-items-center rounded-[12px] hover:bg-accent"><ChevronLeft className="!h-5 !w-5" /></button>
        ) : (
          <button type="button" aria-label="Close tools" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-[12px] hover:bg-accent"><ChevronLeft className="!h-5 !w-5" /></button>
        )}
        <div className="truncate text-center text-[15px] font-semibold capitalize">{active ?? "Tools"}</div>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!active && (
          <div className="mx-auto grid max-w-2xl gap-1.5 p-3">
            {cats.map((c) => (
               <button key={c.id} type="button" onClick={() => setActive(c.id)} className="flex min-h-14 items-center gap-3 rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-3 text-left">
                <c.icon className="!h-5 !w-5 shrink-0" />
                <span className="min-w-0 flex-1"><b className="block text-[14px] font-semibold">{c.label}</b><small className="block truncate text-[12px] text-muted-foreground">{c.desc}</small></span>
                 <ChevronRight className="!h-4 !w-4 text-muted-foreground" />
              </button>
            ))}
            <p className="mt-2 text-center text-[12px] text-muted-foreground">Swipe up to close</p>
          </div>
        )}
        {active === "git" && <GitPanel />}
        {active === "code" && (code ?? <CodePanel file={openFile} setFile={setOpenFile} />)}
        {active === "files" && <FilesPanel onOpen={(p) => { setOpenFile(p); setActive("code"); }} />}
      </div>
    </div>
  );
}

function GitPanel() {
  const [connected, setConnected] = useState(false);
  const [msg, setMsg] = useState("");
  const [committed, setCommitted] = useState(false);
  const [pushed, setPushed] = useState(false);
  if (!connected) {
    return (
      <div className="mx-auto grid max-w-2xl gap-3 p-4">
        <div className="rounded-[14px] border border-border bg-gradient-to-b from-card to-background p-4">
          <Github className="!h-6 !w-6" />
          <h3 className="mb-1 mt-3 text-[15px] font-semibold">Connect GitHub</h3>
          <p className="m-0 text-[13px] text-muted-foreground">Sync this project with a repository to track changes, commit and push.</p>
          <button type="button" onClick={() => setConnected(true)} className="mt-4 h-9 w-full rounded-[12px] bg-cta text-[14px] font-semibold text-cta-foreground">Connect GitHub</button>
        </div>
        <button type="button" onClick={() => setConnected(true)} className="h-10 rounded-[12px] border border-border text-[14px] font-medium">Create new repository</button>
        <button type="button" onClick={() => setConnected(true)} className="h-10 rounded-[12px] border border-border text-[14px] font-medium">Import existing repository</button>
      </div>
    );
  }
  const files = committed ? [] : changedFiles;
  return (
    <div className="mx-auto grid max-w-2xl gap-3 p-3">
      <div className="grid gap-2 rounded-[16px] border border-border bg-gradient-to-b from-card to-background p-4 transition hover:border-foreground/25">
        <div className="flex items-center gap-2 text-[14px] font-semibold"><Github className="!h-4 !w-4" /> Repository</div>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><GitBranch className="!h-4 !w-4" /> main <ChevronDown className="!h-3.5 !w-3.5" /><span className="ml-auto">{pushed ? "Up to date" : committed ? "1 commit to push" : "Up to date"}</span></div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="flex h-8 items-center justify-center gap-1.5 rounded-[12px] border border-border text-[13px] font-medium"><ArrowDownToLine className="!h-4 !w-4" /> Pull</button>
          <button type="button" disabled={!committed || pushed} onClick={() => setPushed(true)} className="flex h-8 items-center justify-center gap-1.5 rounded-[12px] border border-border text-[13px] font-medium disabled:opacity-40"><ArrowUpFromLine className="!h-4 !w-4" /> Push</button>
        </div>
      </div>
      <h4 className="m-0 px-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">Changes ({files.length})</h4>
      {files.length === 0 ? <p className="m-0 rounded-[12px] border border-border p-3 text-[13px] text-muted-foreground">No uncommitted changes.</p> : files.map((f) => (
        <div key={f.path} className="flex h-9 items-center gap-2 rounded-[12px] border border-border px-2.5 text-[13px]"><FileCode2 className="!h-4 !w-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{f.path}</span><b className={f.change === "A" ? "text-primary" : "text-muted-foreground"}>{f.change}</b></div>
      ))}
      {files.length > 0 && (
        <div className="grid gap-2">
          <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message" className="h-10 rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-3 text-[14px] outline-none focus:border-primary" />
          <button type="button" disabled={!msg.trim()} onClick={() => { setCommitted(true); setPushed(false); }} className="flex h-10 items-center justify-center gap-2 rounded-[12px] bg-cta text-[14px] font-semibold text-cta-foreground disabled:bg-accent disabled:text-muted-foreground"><GitCommitHorizontal className="!h-4 !w-4" /> Commit {files.length} files</button>
        </div>
      )}
    </div>
  );
}

function CodePanel({ file, setFile }: { file: string; setFile: (f: string) => void }) {
  const [code, setCode] = useState<Record<string, string>>(fileContents);
  const recent = Object.keys(fileContents);
  const src = code[file] ?? `// ${file}\n`;
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {recent.map((f) => <button key={f} type="button" onClick={() => setFile(f)} className={`h-7 shrink-0 rounded-[9px] px-2 text-[12px] font-medium ${f === file ? "bg-card text-foreground" : "text-muted-foreground"}`}>{f.split("/").pop()}</button>)}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground"><FileCode2 className="!h-4 !w-4" /><span className="min-w-0 flex-1 truncate">{file}</span><button type="button" aria-label="Search in file"><Search className="!h-4 !w-4" /></button><button type="button" aria-label="File actions"><MoreHorizontal className="!h-4 !w-4" /></button></div>
      <div className="mx-3 mb-3 flex min-h-[320px] flex-1 overflow-hidden rounded-[14px] border border-border bg-gradient-to-b from-card to-background font-mono text-[12.5px] leading-6">
        <pre className="m-0 select-none border-r border-border px-2 py-2 text-right text-muted-foreground">{src.split("\n").map((_, i) => `${i + 1}\n`).join("")}</pre>
        <textarea spellCheck={false} value={src} onChange={(e) => setCode({ ...code, [file]: e.target.value })} aria-label={`Edit ${file}`} className="min-w-0 flex-1 resize-none whitespace-pre bg-transparent px-3 py-2 text-foreground outline-none" />
      </div>
    </div>
  );
}

function FilesPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({ src: true });
  const [menu, setMenu] = useState<string | null>(null);
  const flat = (nodes: FileNode[]): FileNode[] => nodes.flatMap((n) => (n.children ? flat(n.children) : [n]));
  const render = (nodes: FileNode[], depth: number): React.ReactNode => nodes.map((n) => (
    <div key={n.path}>
      <div className="relative flex h-9 items-center gap-2 rounded-[9px] pr-1 hover:bg-card" style={{ paddingLeft: 8 + depth * 16 }}>
        <button type="button" onClick={() => (n.type === "folder" ? setOpen({ ...open, [n.path]: !open[n.path] }) : onOpen(n.path))} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px]">
          {n.type === "folder" ? <ChevronRight className={`!h-3.5 !w-3.5 text-muted-foreground transition-transform ${open[n.path] ? "rotate-90" : ""}`} /> : <span className="w-3.5" />}
          {n.type === "folder" ? <Folder className="!h-4 !w-4 text-muted-foreground" /> : <File className="!h-4 !w-4 text-muted-foreground" />}
          <span className="truncate">{n.name}</span>
        </button>
        <button type="button" aria-label={`Actions for ${n.name}`} onClick={() => setMenu(menu === n.path ? null : n.path)} className="grid h-7 w-7 place-items-center rounded-[9px] text-muted-foreground"><MoreHorizontal className="!h-4 !w-4" /></button>
        {menu === n.path && (
          <div className="absolute right-1 top-9 z-10 w-36 rounded-[14px] border border-border bg-gradient-to-b from-card to-background p-1">
            {["Open", "Rename", "Duplicate", "Delete"].map((a) => <button key={a} type="button" onClick={() => { setMenu(null); if (a === "Open" && n.type === "file") onOpen(n.path); }} className={`flex h-8 w-full items-center rounded-[9px] px-2 text-[13px] hover:bg-accent ${a === "Delete" ? "text-destructive" : ""}`}>{a}</button>)}
          </div>
        )}
      </div>
      {n.children && open[n.path] && render(n.children, depth + 1)}
    </div>
  ));
  const results = q ? flat(fileTree).filter((f) => f.path.toLowerCase().includes(q.toLowerCase())) : null;
  return (
    <div className="mx-auto max-w-2xl p-3">
      <div className="mb-2 flex gap-2">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-2.5"><Search className="!h-4 !w-4 text-muted-foreground" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" /></label>
        <button type="button" className="h-9 rounded-[12px] border border-border px-3 text-[13px] font-medium">Upload</button>
      </div>
      {results ? (results.length ? results.map((f) => <button key={f.path} type="button" onClick={() => onOpen(f.path)} className="flex h-9 w-full items-center gap-2 rounded-[9px] px-2 text-left text-[13px] hover:bg-card"><File className="!h-4 !w-4 text-muted-foreground" /><span className="truncate">{f.path}</span></button>) : <p className="p-3 text-[13px] text-muted-foreground">No files match.</p>) : render(fileTree, 0)}
    </div>
  );
}
