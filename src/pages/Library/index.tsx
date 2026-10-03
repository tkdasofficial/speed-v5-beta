import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ArrowDownUp, FolderArchive, FolderOpen, Github, GitBranch, Lock, MoreVertical, Plus, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { PageShell, SkeletonRows, StateBox } from "@/components/PageShell";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProjects } from "@/lib/sync";
import { deleteWorkspaceData } from "@/lib/workspace";
import { sbCopyProject } from "@/lib/api/tasks";
import { createProject, deleteProject, getSnapshot, updateProject } from "@/lib/api/sync";
import { githubRepos } from "@/lib/api/github";
import { applySnapshot } from "@realtime/store";
import "@/style/Library/index.css";

type Source = "speed" | "github" | "gitlab" | "bitbucket" | "zip" | "directory";
type Item = { id: string; slug: string; name: string; source: Source; repo: string | null; branch: string | null; status: string | null; updated: number; created: number };
const SOURCE_LABEL: Record<Source, string> = { speed: "Speed", github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", zip: "ZIP import", directory: "Folder import" };
const SOURCE_ICON: Record<Source, typeof AppWindow> = { speed: AppWindow, github: Github, gitlab: GitBranch, bitbucket: GitBranch, zip: FolderArchive, directory: FolderOpen };
const ts = (s: string | undefined) => (s ? Date.parse(`${s.replace(" ", "T")}Z`) : 0);
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); if (m < 60) return `${Math.max(m, 1)}m ago`; const h = Math.round(m / 60); if (h < 24) return `${h}h ago`; const d = Math.round(h / 24); return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString(); };
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
type Sort = "updated" | "created" | "az" | "za";

export function LibraryPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const live = useProjects();
  // Fallback load: if the live cache isn't ready, fetch the snapshot directly so failures surface with a retry.
  const check = useQuery({ queryKey: ["library-snapshot"], queryFn: async () => { const s = await getSnapshot(); applySnapshot(qc, s); return true; }, enabled: !live, retry: 1, staleTime: Infinity });
  const repos = useQuery({ queryKey: ["library-github-repos"], queryFn: () => githubRepos(), retry: false, staleTime: 5 * 60_000 });

  const items = useMemo<Item[]>(() => (live ?? []).map((p) => {
    const s = p.settings ?? {};
    const src = (str(s['source']) ?? "speed") as Source;
    const imp = str(s['importStatus']);
    return { id: p.id, slug: p.slug, name: p.name, source: SOURCE_LABEL[src] ? src : "speed", repo: str(s['sourceRepo']), branch: str(s['sourceBranch']), status: imp === "importing" ? "Importing" : imp === "failed" ? "Import failed" : null, updated: ts(p.updatedAt), created: ts(p.createdAt ?? p.updatedAt) };
  }), [live]);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [rename, setRename] = useState<Item | null>(null);
  const [draft, setDraft] = useState("");
  const [del, setDel] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const cmp: Record<Sort, (a: Item, b: Item) => number> = { updated: (a, b) => b.updated - a.updated, created: (a, b) => b.created - a.created, az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name) };
    return items.filter((p) => !s || `${p.name} ${SOURCE_LABEL[p.source]} ${p.repo ?? ""} ${p.branch ?? ""} ${p.status ?? ""}`.toLowerCase().includes(s)).sort(cmp[sort]);
  }, [items, q, sort]);

  const imported = useMemo(() => new Set(items.map((p) => p.repo?.toLowerCase()).filter(Boolean)), [items]);
  const notImported = (repos.data ?? []).filter((r) => !imported.has(r.fullName.toLowerCase()));
  const repoMatches = q.trim() ? notImported.filter((r) => `${r.fullName} ${r.description ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())) : notImported;

  const run = (p: Promise<unknown>) => { setErr(null); p.catch((e: unknown) => setErr(e instanceof Error ? e.message : "Something went wrong")); };
  const open = (p: Item) => nav({ to: "/project/$projectId", params: { projectId: p.slug } });
  const create = () => { const n = newName.trim(); if (!n) return; run(createProject({ data: { name: n } })); setNewName(""); setCreating(false); };

  const sortMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger className="sp-icon-btn" aria-label="Sort projects"><ArrowDownUp /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <DropdownMenuRadioItem value="updated">Recently updated</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">Recently created</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="az">Name A–Z</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="za">Name Z–A</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const phase = live ? "ready" : check.isError ? "error" : "loading";

  return (
    <PageShell title="Library" search={q} onSearch={setQ} actions={sortMenu}>
      {phase === "loading" && <SkeletonRows />}
      {phase === "error" && <StateBox tone="error" title="Couldn't load your projects" text={check.error instanceof Error ? check.error.message : "Check your connection and try again."}><button className="sp-btn lb-btn" onClick={() => void check.refetch()}><RefreshCw /> Retry</button></StateBox>}
      {err && <StateBox tone="error" title="Action failed" text={err}><button className="sp-btn lb-btn" onClick={() => setErr(null)}>Dismiss</button></StateBox>}

      {phase === "ready" && items.length > 0 && (
        <div className="sp-toolbar">
          <span>{q ? `${list.length} results` : `${items.length} projects`}</span>
          <div className="lb-actions">
            <button className="sp-btn lb-btn" onClick={() => nav({ to: "/import" })}>Import</button>
            <button className="sp-btn lb-btn is-primary" onClick={() => setCreating(true)}><Plus /> New</button>
          </div>
        </div>
      )}
      {phase === "ready" && items.length === 0 && (
        <StateBox title="No projects yet" text="Create a project or import an existing one to get started.">
          <button className="sp-btn lb-btn is-primary" onClick={() => setCreating(true)}><Plus /> New Project</button>
          <button className="sp-btn lb-btn" onClick={() => nav({ to: "/import" })}>Import</button>
        </StateBox>
      )}
      {phase === "ready" && items.length > 0 && list.length === 0 && <StateBox title="No matching projects" text={`Nothing matches "${q}".`}><button className="sp-btn lb-btn" onClick={() => setQ("")}>Clear search</button></StateBox>}
      {phase === "ready" && list.length > 0 && (
        <ul className="sp-list">
          {list.map((p) => { const I = SOURCE_ICON[p.source]; return (
            <li key={p.id} className="sp-row">
              <button className="sp-row-main" onClick={() => open(p)}>
                <span className="sp-ico"><I /></span>
                <span className="sp-row-text">
                  <b>{p.name}</b>
                  <em>{SOURCE_LABEL[p.source]}{p.repo ? ` · ${p.repo}` : ""}{p.branch ? `@${p.branch}` : ""} · {ago(p.updated)}</em>
                </span>
                {p.status && <span className={`lb-status${p.status === "Import failed" ? " is-bad" : ""}`}>{p.status}</span>}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger className="sp-icon-btn" aria-label={`Actions for ${p.name}`}><MoreVertical /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => open(p)}>Open</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setRename(p); setDraft(p.name); }}>Rename</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => run(createProject({ data: { name: `${p.name} copy`.slice(0, 80) } }).then((r) => sbCopyProject({ data: { fromId: p.id, toId: r.id } })))}>Duplicate</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => setDel(p)}>Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ); })}
        </ul>
      )}

      {phase === "ready" && repos.isSuccess && (
        <section className="lb-repos">
          <div className="sp-toolbar"><span>GitHub repositories</span><span className="lb-count">{repoMatches.length} not imported</span></div>
          {repoMatches.length === 0 ? <p className="lb-note">{q ? "No repositories match your search." : "Every accessible repository is already in your Library."}</p> : (
            <ul className="sp-list">
              {repoMatches.slice(0, 20).map((r) => (
                <li key={r.id} className="sp-row">
                  <div className="sp-row-main">
                    <span className="sp-ico"><Github /></span>
                    <span className="sp-row-text"><b>{r.name}{r.private && <Lock className="lb-lock" aria-label="Private" />}</b><em>{r.fullName} · {r.defaultBranch}</em></span>
                  </div>
                  <button className="sp-btn lb-btn" onClick={() => nav({ to: "/import" })}>Import</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Dialog open={!!rename} onOpenChange={(o) => !o && setRename(null)}>
        <DialogContent className="sp-dialog">
          <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
          <input className="sp-input" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Project name" />
          <DialogFooter className="gap-2"><button className="sp-btn" onClick={() => setRename(null)}>Cancel</button><button className="sp-btn is-primary" disabled={!draft.trim()} onClick={() => { if (rename) run(updateProject({ data: { id: rename.id, name: draft.trim() } })); setRename(null); }}>Save</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sp-dialog">
          <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
          <input className="sp-input" autoFocus placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} aria-label="New project name" />
          <DialogFooter className="gap-2"><button className="sp-btn" onClick={() => setCreating(false)}>Cancel</button><button className="sp-btn is-primary" disabled={!newName.trim()} onClick={create}>Create</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent className="sp-dialog">
          <AlertDialogHeader><AlertDialogTitle>Delete {del?.name}?</AlertDialogTitle><AlertDialogDescription>This removes the project and its files. This can't be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (del) { const id = del.id; run(deleteProject({ data: { id } }).then(() => deleteWorkspaceData(id))); }; }}>Delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
