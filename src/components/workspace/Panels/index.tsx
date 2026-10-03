import { AlertTriangle, Check, ChevronLeft, FileText, Folder, Github, Globe, Loader2, Lock, Smartphone, X } from "lucide-react";
import { oauthStartUrl } from "@/lib/api";
import { getGithubConnection } from "@/lib/api/auth";
import { getProjectFile, listProjectFiles } from "@/lib/api/imports";
import { getProjectRepo, githubFile, githubRepos, githubTree, linkProjectRepo, unlinkProjectRepo, verifyProjectRepo } from "@/lib/api/github";
import { useEffect, useState } from "react";
import type { Task } from "@/lib/workspace-types";
import type { WorkspaceStore, WorkspaceView } from "@/lib/workspace";
import { useTasks } from "@/lib/sync";
import { createTask, deleteTask, updateTask } from "@/lib/api/sync";

export function PreviewView({ store, view, projectName, onBack }: { store: WorkspaceStore; view: WorkspaceView; projectName: string; onBack: () => void }) {
  const p = view.preview;
  const html = p.outputId ? store.renderPreview() : null;
  const [notice, setNotice] = useState<string | null>(null);
  // Opening the preview with changed files rebuilds the static output automatically.
  useEffect(() => { if (p.stale && !p.error) store.generateOutput(); }, [p.stale, p.error, store]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const d = e.data as { __speedPreview?: string; path?: string; message?: string } | null;
      if (!d || !d.__speedPreview) return;
      if (d.__speedPreview === "navigate" && typeof d.path === "string") setNotice(store.navigatePreview(d.path) ? null : `Page not found: /${d.path}`);
      if (d.__speedPreview === "error" && typeof d.message === "string") store.reportPreviewError(`${p.page}: ${d.message}`), setNotice(`Script error: ${d.message}`);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [store]);
  useEffect(() => setNotice(null), [p.page, p.outputId]);
  if (!p.outputId) {
    if (p.status === "error") return <Empty icon={AlertTriangle} tone="destructive" title="No preview output" body={p.error ?? "Output generation failed."} action="Try again" onAction={() => store.generateOutput()} />;
    return <Empty icon={Smartphone} title="No preview yet" body={`${projectName || "This project"} has no successful output. Add an index.html to the project and generate output.`} action="Generate output" onAction={() => store.generateOutput()} />;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {(p.stale || p.error) && (
        <div className={`flex items-center gap-2 border-b px-3 py-1.5 text-[12px] ${p.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border text-muted-foreground"}`}>
          <span className="min-w-0 flex-1 break-words">{p.error ? `Latest output failed — showing the previous successful output. ${p.error}` : "Files changed since this output was generated."}</span>
          <button type="button" onClick={() => store.generateOutput()} className="h-7 shrink-0 rounded-[6px] border border-border px-2.5 text-foreground">Regenerate</button>
        </div>
      )}
      {notice && (
        <div className="flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">
          <span className="min-w-0 flex-1 break-words">{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0"><X className="!h-3.5 !w-3.5" /></button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {html === null
          ? <Empty icon={AlertTriangle} tone="destructive" title="Page not found" body={`${p.page} is not part of the current output.`} action="Back to chat" onAction={onBack} />
          : <iframe key={`${p.outputId}-${p.reloadKey}-${p.page}`} title="Project preview" srcDoc={html} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" onLoad={() => store.previewLoaded()} className="h-full w-full border-0" />}
        {p.status === "loading" && <div className="absolute inset-0 grid place-items-center bg-background/70 text-[13px] text-muted-foreground"><span className="flex items-center gap-2"><Loader2 className="!h-4 !w-4 animate-spin text-primary" /> Loading preview…</span></div>}
      </div>
    </div>
  );
}

export function SettingsView({ projectId, name, setName, settings, onSettings }: { projectId?: string | undefined; name: string; setName: (n: string) => void; settings: Record<string, unknown>; onSettings: (s: Record<string, string | boolean>) => void }) {
  const [draftName, setDraftName] = useState(name);
  useEffect(() => setDraftName(name), [name]);
  const model = typeof settings["model"] === "string" ? (settings["model"] as string) : "Free";
  const autoCheck = typeof settings["autoCheck"] === "boolean" ? (settings["autoCheck"] as boolean) : true;
  const plan = settings["planMode"] === true;
  const vis = typeof settings["visibility"] === "string" ? (settings["visibility"] as string) : "Private";
  const setModel = (v: string) => onSettings({ model: v });
  const setAutoCheck = (v: boolean) => onSettings({ autoCheck: v });
  const setPlan = (v: boolean) => onSettings({ planMode: v });
  const setVis = (v: string) => onSettings({ visibility: v });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-2xl gap-5 p-4">
        <Section title="Project">
          <label className="grid gap-1 text-[12px] text-muted-foreground">Name<input value={draftName} onChange={(e) => setDraftName(e.target.value)} onBlur={() => { if (draftName.trim() && draftName !== name) setName(draftName); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} className="h-10 rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-3 text-[14px] text-foreground outline-none focus:border-primary" /></label>
          <Seg label="Visibility" value={vis} options={["Private", "Public"]} onChange={setVis} />
        </Section>
        {projectId && settings["importStatus"] === "ready" && <Section title="Imported files"><ImportedFiles projectId={projectId} settings={settings} /></Section>}
        {projectId && <Section title="GitHub repository"><RepoPicker projectId={projectId} /></Section>}
        <Section title="Model">
          <Seg label="Default model" value={model} options={["Free", "Balanced", "Power"]} onChange={setModel} />
        </Section>
        <Section title="Build preferences">
          <Toggle label="Run checks after every change" on={autoCheck} set={setAutoCheck} />
          <Toggle label="Start in Plan mode" on={plan} set={setPlan} />
        </Section>
        <Section title="Danger zone">
          <button type="button" className="h-10 rounded-[12px] border border-destructive/50 text-[14px] font-semibold text-destructive">Delete project</button>
        </Section>
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="grid gap-2"><h3 className="m-0 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>{children}</section>
);
function Seg({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[14px] border border-border bg-gradient-to-b from-card to-background p-2 pl-3">
      <span className="text-[14px]">{label}</span>
      <div className="flex gap-1">{options.map((o) => <button key={o} type="button" onClick={() => onChange(o)} className={`h-7 rounded-[9px] px-2.5 text-[12px] font-medium ${o === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{o}</button>)}</div>
    </div>
  );
}
function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)} className="flex h-11 items-center justify-between rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-3 text-left text-[14px]">
      {label}<span className={`flex h-5 w-9 items-center rounded-full p-0.5 ${on ? "justify-end bg-primary" : "justify-start bg-accent"}`}><i className="h-4 w-4 rounded-full bg-foreground" /></span>
    </button>
  );
}

function Empty({ icon: Icon, title, body, action, onAction, tone }: { icon: typeof Check; title: string; body: string; action: string; onAction: () => void; tone?: "destructive" }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <span className={`grid h-12 w-12 place-items-center rounded-[12px] border ${tone ? "border-destructive/50 bg-destructive/15 text-destructive" : "border-primary/45 bg-primary/20"}`}><Icon className="!h-5 !w-5" /></span>
      <h3 className="mb-2 mt-5 text-[24px] font-extrabold tracking-[-0.03em]">{title}</h3>
      <p className="m-0 max-w-xs text-[13px] text-muted-foreground">{body}</p>
      <button type="button" onClick={onAction} className="mt-4 h-9 rounded-[12px] border border-border px-4 text-[13px] font-semibold">{action}</button>
    </div>
  );
}

export function TasksSheet({ onClose, projectId }: { onClose: () => void; projectId: string | undefined }) {
  const live = useTasks(projectId);
  const tasks: Task[] = live.map((t) => ({ id: t.id, title: t.title, desc: t.description, status: t.status as Task["status"] }));
  const add = createTask;
  const upd = updateTask;
  const del = deleteTask;
  const [draft, setDraft] = useState("");
  const move = (id: string, status: Task["status"] | null) => void (status ? upd({ data: { id, status } }) : del({ data: { id } }));
  const groups: { key: Task["status"]; label: string; empty: string }[] = [
    { key: "ready", label: "Ready", empty: "No tasks waiting for review" },
    { key: "active", label: "Active", empty: "No running tasks" },
    { key: "draft", label: "Draft", empty: "No planned tasks" },
  ];
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)]">
      <div className="grid h-12 shrink-0 grid-cols-[40px_1fr_40px] items-center border-b border-border px-2">
        <span /><b className="text-center text-[15px] font-bold">Tasks</b>
        <button type="button" aria-label="Close tasks" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-[12px] hover:bg-accent"><X className="!h-5 !w-5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-2xl gap-5 p-3">
          {groups.map((g) => {
            const list = tasks.filter((t) => t.status === g.key);
            return (
              <section key={g.key} className="grid gap-1.5">
                <h3 className="m-0 px-1 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{g.label} · {list.length}</h3>
                {list.length === 0 && <p className="m-0 rounded-[14px] border border-dashed border-border p-3 text-[13px] text-muted-foreground">{g.empty}</p>}
                {list.map((t) => (
                  <div key={t.id} className="grid gap-2 rounded-[16px] border border-border bg-gradient-to-b from-card to-background p-4 transition hover:border-foreground/25">
                    <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><b className="block text-[14px] font-semibold">{t.title}</b><small className="block text-[12px] text-muted-foreground">{t.desc}</small></div>
                      {g.key === "active" && <Loader2 className="!h-4 !w-4 animate-spin text-primary" />}</div>
                    {t.progress !== undefined && <div className="h-1 overflow-hidden rounded-[2px] bg-accent"><div className="h-full bg-primary" style={{ width: `${t.progress}%` }} /></div>}
                    <div className="flex gap-1.5">
                      {g.key === "ready" && <><Btn primary onClick={() => move(t.id, null)}>Apply</Btn><Btn onClick={() => {}}>Review</Btn></>}
                      {g.key === "active" && <Btn danger onClick={() => move(t.id, "draft")}>Cancel</Btn>}
                      {g.key === "draft" && <Btn primary onClick={() => move(t.id, "active")}>Start</Btn>}
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (!draft.trim() || !projectId) return; void add({ data: { projectId, title: draft.trim(), description: "New draft task" } }); setDraft(""); }} className="flex shrink-0 gap-2 border-t border-border p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New task…" className="h-10 min-w-0 flex-1 rounded-[14px] border border-border bg-gradient-to-b from-card to-background px-3 text-[14px] outline-none focus:border-primary" />
        <button type="submit" disabled={!draft.trim()} className="h-10 rounded-[12px] bg-cta px-4 text-[14px] font-semibold text-cta-foreground disabled:bg-accent disabled:text-muted-foreground">Add</button>
      </form>
    </div>
  );
}
const Btn = ({ children, onClick, primary, danger }: { children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean }) => (
  <button type="button" onClick={onClick} className={`h-8 rounded-[12px] px-3 text-[13px] font-semibold ${primary ? "bg-cta text-cta-foreground" : danger ? "border border-destructive/50 text-destructive" : "border border-border"}`}>{children}</button>
);

type Repo = Awaited<ReturnType<typeof githubRepos>>[number];
type Linked = Awaited<ReturnType<typeof getProjectRepo>>;
const card = "rounded-[14px] border border-border bg-gradient-to-b from-card to-background";

function RepoPicker({ projectId }: { projectId: string }) {
  const [conn, setConn] = useState<Awaited<ReturnType<typeof getGithubConnection>> | null>(null);
  const [linked, setLinked] = useState<Linked>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : "Something went wrong" });

  useEffect(() => {
    void getGithubConnection().then(setConn).catch(fail);
    void getProjectRepo({ data: { projectId } }).then(setLinked).catch(fail);
  }, [projectId]);

  const load = async () => { setBusy("load"); setMsg(null); try { setRepos(await githubRepos()); } catch (e) { fail(e); } setBusy(null); };
  const pick = async (id: number) => { setBusy(`pick${id}`); setMsg(null); try { setLinked(await linkProjectRepo({ data: { projectId, repoId: id } })); setRepos(null); setMsg({ ok: true, text: "Repository connected" }); } catch (e) { fail(e); } setBusy(null); };
  const verify = async () => {
    setBusy("verify"); setMsg(null);
    try { const r = await verifyProjectRepo({ data: { projectId } }); setMsg(r.ok ? { ok: true, text: `Access confirmed${r.canPush ? " — read & write" : " — read only"}` } : { ok: false, text: r.error }); }
    catch (e) { fail(e); }
    setBusy(null);
  };
  const unlink = async () => { setBusy("unlink"); try { await unlinkProjectRepo({ data: { projectId } }); setLinked(null); setMsg(null); } catch (e) { fail(e); } setBusy(null); };

  if (!conn) return <div className={`${card} flex h-11 items-center gap-2 px-3 text-[13px] text-muted-foreground`}><Loader2 className="!h-4 !w-4 animate-spin" /> Checking GitHub…</div>;
  if (!conn.connected) {
    return (
      <div className={`${card} grid gap-2 p-3`}>
        <span className="text-[13px] text-muted-foreground">{conn.reconnectRequired ? "Your GitHub access expired. Reconnect to keep using your repositories." : "Connect GitHub to link a repository to this project."}</span>
        <button type="button" onClick={() => { window.location.href = oauthStartUrl("github"); }} className="flex h-10 items-center justify-center gap-2 rounded-[12px] bg-primary text-[14px] font-semibold text-primary-foreground"><Github className="!h-4 !w-4" />{conn.reconnectRequired ? "Reconnect GitHub" : "Connect GitHub"}</button>
      </div>
    );
  }
  const shown = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="grid gap-2">
      <div className={`${card} flex items-center gap-2 px-3 py-2.5 text-[14px]`}>
        <Github className="!h-4 !w-4 shrink-0" />
        {linked ? <span className="min-w-0 flex-1 truncate font-semibold">{linked.fullName}<span className="ml-2 text-[12px] font-medium text-muted-foreground">{linked.private ? "Private" : "Public"} · {linked.defaultBranch}</span></span>
          : <span className="min-w-0 flex-1 truncate text-muted-foreground">Signed in as {conn.login} · no repository linked</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void load()} disabled={!!busy} className="h-9 rounded-[11px] border border-border px-3 text-[13px] font-medium">{busy === "load" ? "Loading…" : linked ? "Change repository" : "Choose repository"}</button>
        {linked && <button type="button" onClick={() => void verify()} disabled={!!busy} className="h-9 rounded-[11px] border border-border px-3 text-[13px] font-medium">{busy === "verify" ? "Checking…" : "Test access"}</button>}
        {linked && <button type="button" onClick={() => void unlink()} disabled={!!busy} className="h-9 rounded-[11px] border border-destructive/50 px-3 text-[13px] font-medium text-destructive">Disconnect</button>}
      </div>
      {msg && <p className={`m-0 flex items-center gap-1.5 text-[13px] ${msg.ok ? "text-foreground" : "text-destructive"}`}>{msg.ok ? <Check className="!h-4 !w-4 text-primary" /> : <AlertTriangle className="!h-4 !w-4" />}{msg.text}</p>}
      {repos && (
        <div className={`${card} grid gap-1 p-2`}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" className="h-9 rounded-[10px] border border-border bg-background px-3 text-[14px] text-foreground outline-none focus:border-primary" />
          <div className="grid max-h-72 gap-0.5 overflow-y-auto">
            {shown.length === 0 && <p className="m-0 p-3 text-center text-[13px] text-muted-foreground">No repositories found</p>}
            {shown.map((r) => (
              <button key={r.id} type="button" onClick={() => void pick(r.id)} disabled={!!busy} className="flex items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-accent">
                {r.private ? <Lock className="!h-3.5 !w-3.5 shrink-0 text-muted-foreground" /> : <Globe className="!h-3.5 !w-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-medium">{r.fullName}</span>{r.description && <span className="block truncate text-[12px] text-muted-foreground">{r.description}</span>}</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{busy === `pick${r.id}` ? "…" : r.private ? "Private" : "Public"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {linked && <RepoBrowser key={linked.id} projectId={projectId} />}
    </div>
  );
}

type Tree = Awaited<ReturnType<typeof githubTree>>;
type OpenFile = Awaited<ReturnType<typeof githubFile>>;

function RepoBrowser({ projectId }: { projectId: string }) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<OpenFile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : "Something went wrong");

  const loadTree = async () => { setBusy("tree"); setErr(null); try { setTree(await githubTree({ data: { projectId } })); } catch (e) { fail(e); } setBusy(null); };
  const open = async (path: string) => { setBusy(path); setErr(null); try { setFile(await githubFile({ data: { projectId, path } })); } catch (e) { fail(e); } setBusy(null); };

  if (!tree) return (
    <div className="grid gap-1">
      <button type="button" onClick={() => void loadTree()} disabled={!!busy} className="h-9 justify-self-start rounded-[11px] border border-border px-3 text-[13px] font-medium">{busy ? "Loading files…" : "Browse files"}</button>
      {err && <p className="m-0 flex items-center gap-1.5 text-[13px] text-destructive"><AlertTriangle className="!h-4 !w-4" />{err}</p>}
    </div>
  );

  const prefix = dir ? `${dir}/` : "";
  const items = tree.entries.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/"));
  const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";

  if (file) return (
    <div className={`${card} grid gap-2 p-2`}>
      <div className="flex items-center gap-2 px-1 text-[13px]">
        <button type="button" onClick={() => setFile(null)} className="flex h-8 items-center gap-1 rounded-[10px] border border-border px-2 font-medium"><ChevronLeft className="!h-4 !w-4" />Files</button>
        <span className="min-w-0 flex-1 truncate font-semibold">{file.path}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">{file.size.toLocaleString()} B · {file.branch}</span>
      </div>
      {file.kind === "text"
        ? <pre className="m-0 max-h-[60vh] overflow-auto rounded-[10px] border border-border bg-background p-3 text-[12px] leading-5"><code>{file.content}</code></pre>
        : <p className="m-0 p-3 text-center text-[13px] text-muted-foreground">{file.kind === "binary" ? "This is a binary file and can't be shown as text." : file.kind === "too_large" ? "This file is too large to preview." : "This item can't be previewed."}</p>}
    </div>
  );

  return (
    <div className={`${card} grid gap-1 p-2`}>
      <div className="flex items-center gap-2 px-1 text-[13px]">
        {dir && <button type="button" onClick={() => setDir(up)} aria-label="Up one folder" className="grid h-8 w-8 place-items-center rounded-[10px] border border-border"><ChevronLeft className="!h-4 !w-4" /></button>}
        <span className="min-w-0 flex-1 truncate font-semibold">{tree.repo}{dir ? ` / ${dir}` : ""}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">{tree.branch}</span>
      </div>
      {tree.truncated && <p className="m-0 px-1 text-[12px] text-muted-foreground">This repository is very large; some files aren't listed.</p>}
      {err && <p className="m-0 flex items-center gap-1.5 px-1 text-[13px] text-destructive"><AlertTriangle className="!h-4 !w-4" />{err}</p>}
      <div className="grid max-h-80 gap-0.5 overflow-y-auto">
        {items.length === 0 && <p className="m-0 p-3 text-center text-[13px] text-muted-foreground">This folder is empty</p>}
        {items.map((e) => (
          <button key={e.path} type="button" disabled={!!busy} onClick={() => (e.type === "dir" ? setDir(e.path) : void open(e.path))} className="flex items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-accent">
            {e.type === "dir" ? <Folder className="!h-4 !w-4 shrink-0 text-primary" /> : <FileText className="!h-4 !w-4 shrink-0 text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate text-[14px]">{e.name}</span>
            {busy === e.path ? <Loader2 className="!h-3.5 !w-3.5 animate-spin" /> : e.size != null && <span className="text-[11px] text-muted-foreground">{e.size.toLocaleString()} B</span>}
          </button>
        ))}
      </div>
    </div>
  );
}


type IFile = Awaited<ReturnType<typeof listProjectFiles>>[number];
type IOpen = Awaited<ReturnType<typeof getProjectFile>>;
const SOURCE_LABEL: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", zip: "ZIP upload", directory: "Local folder" };

/** Files saved by an import, read back from the backend. */
function ImportedFiles({ projectId, settings }: { projectId: string; settings: Record<string, unknown> }) {
  const [files, setFiles] = useState<IFile[] | null>(null);
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<IOpen | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fail = (e: unknown) => setErr(e instanceof Error ? e.message : "Something went wrong");
  const src = String(settings["source"] ?? "");
  const repo = typeof settings["sourceRepo"] === "string" ? ` · ${settings["sourceRepo"] as string}${settings["sourceBranch"] && settings["sourceBranch"] !== "HEAD" ? ` @ ${settings["sourceBranch"] as string}` : ""}` : "";
  const header = <p className="m-0 text-[13px] text-muted-foreground">From {SOURCE_LABEL[src] ?? src}{repo} · {String(settings["importedFiles"] ?? 0)} files</p>;
  const load = async () => { setBusy("list"); setErr(null); try { setFiles(await listProjectFiles({ data: { projectId } })); } catch (e) { fail(e); } setBusy(null); };
  const open = async (path: string) => { setBusy(path); setErr(null); try { setFile(await getProjectFile({ data: { projectId, path } })); } catch (e) { fail(e); } setBusy(null); };

  if (!files) return (
    <div className="grid gap-2">{header}
      <button type="button" onClick={() => void load()} disabled={!!busy} className="h-9 justify-self-start rounded-[11px] border border-border px-3 text-[13px] font-medium">{busy ? "Loading files…" : "Browse files"}</button>
      {err && <p className="m-0 flex items-center gap-1.5 text-[13px] text-destructive"><AlertTriangle className="!h-4 !w-4" />{err}</p>}
    </div>
  );
  if (file) return (
    <div className={`${card} grid gap-2 p-2`}>
      <div className="flex items-center gap-2 px-1 text-[13px]">
        <button type="button" onClick={() => setFile(null)} className="flex h-8 items-center gap-1 rounded-[10px] border border-border px-2 font-medium"><ChevronLeft className="!h-4 !w-4" />Files</button>
        <span className="min-w-0 flex-1 truncate font-semibold">{file.path}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">{file.size.toLocaleString()} B</span>
      </div>
      {file.kind === "text"
        ? <pre className="m-0 max-h-[60vh] overflow-auto rounded-[10px] border border-border bg-background p-3 text-[12px] leading-5"><code>{file.content}</code></pre>
        : <p className="m-0 p-3 text-center text-[13px] text-muted-foreground">{file.kind === "binary" ? "This is a binary file and can't be shown as text." : "This file was too large to store; only its name was imported."}</p>}
    </div>
  );
  const prefix = dir ? `${dir}/` : "";
  const under = files.filter((f) => f.path.startsWith(prefix));
  const subdirs = [...new Set(under.map((f) => f.path.slice(prefix.length)).filter((r) => r.includes("/")).map((r) => r.split("/")[0]!))].sort();
  const here = under.filter((f) => !f.path.slice(prefix.length).includes("/"));
  const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  return (
    <div className={`${card} grid gap-1 p-2`}>
      <div className="flex items-center gap-2 px-1 text-[13px]">
        {dir && <button type="button" onClick={() => setDir(up)} aria-label="Up one folder" className="grid h-8 w-8 place-items-center rounded-[10px] border border-border"><ChevronLeft className="!h-4 !w-4" /></button>}
        <span className="min-w-0 flex-1 truncate font-semibold">{dir || "Project root"}</span>
      </div>
      {err && <p className="m-0 flex items-center gap-1.5 px-1 text-[13px] text-destructive"><AlertTriangle className="!h-4 !w-4" />{err}</p>}
      <div className="grid max-h-80 gap-0.5 overflow-y-auto">
        {subdirs.map((d) => <button key={d} type="button" onClick={() => setDir(prefix + d)} className="flex items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-accent"><Folder className="!h-4 !w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate text-[14px]">{d}</span></button>)}
        {here.map((f) => (
          <button key={f.path} type="button" disabled={!!busy} onClick={() => void open(f.path)} className="flex items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-accent">
            <FileText className="!h-4 !w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-[14px]">{f.name}</span>
            {busy === f.path ? <Loader2 className="!h-3.5 !w-3.5 animate-spin" /> : <span className="text-[11px] text-muted-foreground">{f.size.toLocaleString()} B</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
