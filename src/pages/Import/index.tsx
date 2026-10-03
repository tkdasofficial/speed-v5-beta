import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, FileText, FolderUp, Github, Gitlab, Globe, Loader2, Lock, X, FileArchive } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageShell, StateBox, SkeletonRows } from "@/components/PageShell";
import { oauthStartUrl } from "@/lib/api";
import { getGithubConnection } from "@/lib/api/auth";
import { githubRepos } from "@/lib/api/github";
import { importFromUrl, importGithubRepo, importLocalAbort, importLocalBatch, importLocalFinish, importLocalStart } from "@/lib/api/imports";
import { buildTree, type ProjectTree } from "../../../cloudflare/functions/import/normalize";
import { unzipEntries } from "../../../cloudflare/functions/import/zip";
import "@/style/Import/index.css";

function Bitbucket() {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 3.5a.7.7 0 0 0-.7.8l2.7 16.4a1 1 0 0 0 1 .8h12.1a.7.7 0 0 0 .7-.6l2.9-16.6a.7.7 0 0 0-.7-.8zm11.2 11.6H9.9L8.8 8.9h6.5z" /></svg>;
}

type SourceId = "github" | "gitlab" | "bitbucket" | "local";
type RemoteId = Exclude<SourceId, "local">;
const sources: { id: SourceId; name: string; desc: string; icon: typeof Github }[] = [
  { id: "github", name: "GitHub", desc: "Your repositories or any public repository URL.", icon: Github },
  { id: "gitlab", name: "GitLab", desc: "Import a public GitLab repository by URL.", icon: Gitlab },
  { id: "bitbucket", name: "Bitbucket", desc: "Import a public Bitbucket repository by URL.", icon: Bitbucket as unknown as typeof Github },
  { id: "local", name: "Local Directory", desc: "Upload a ZIP or choose a project folder.", icon: FolderUp },
];
const placeholders: Record<RemoteId, string> = { github: "https://github.com/owner/repo", gitlab: "https://gitlab.com/group/project", bitbucket: "https://bitbucket.org/workspace/repo" };

type Repo = Awaited<ReturnType<typeof githubRepos>>[number];
type Done = { slug: string; name: string; files: number; skipped: number };
type Step = "sources" | "select" | "importing" | "success" | "error";
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

export function ImportPage() {
  const nav = useNavigate();
  const [src, setSrc] = useState<SourceId | null>(null);
  const [step, setStep] = useState<Step>("sources");
  const [label, setLabel] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [err, setErr] = useState("");
  const retry = useRef<(() => void) | null>(null);
  const source = sources.find((s) => s.id === src);

  const choose = (id: SourceId) => { setSrc(id); setStep("select"); setErr(""); };
  const reset = () => { setSrc(null); setStep("sources"); setProgress(null); setDone(null); };
  const run = async (name: string, job: () => Promise<Done>) => {
    retry.current = () => void run(name, job);
    setLabel(name); setProgress(null); setStep("importing");
    try { setDone(await job()); setStep("success"); }
    catch (e) { setErr(msg(e)); setStep("error"); }
  };

  return (
    <PageShell title="Import" sub={step === "sources" ? "Bring an existing project into Speed." : source ? `From ${source.name}` : undefined}>
      {step === "sources" && (
        <ul className="sp-list">
          {sources.map((s) => { const I = s.icon; return (
            <li key={s.id} className="sp-row">
              <button className="sp-row-main" onClick={() => choose(s.id)}>
                <span className="sp-ico"><I /></span>
                <span className="sp-row-text"><b>{s.name}</b><span>{s.desc}</span></span>
              </button>
              <div className="sp-row-action"><button className="sp-btn" onClick={() => choose(s.id)}>Continue <ArrowRight /></button></div>
            </li>
          ); })}
        </ul>
      )}

      {step === "select" && src === "github" && <GithubSource run={run} back={reset} />}
      {step === "select" && (src === "gitlab" || src === "bitbucket") && (<>
        <UrlImport provider={src} run={run} />
        <div className="ip-soon"><Lock /> Authorize {src === "gitlab" ? "GitLab" : "Bitbucket"} — Coming Soon</div>
        <div className="sp-footer"><button className="sp-btn" onClick={reset}>Back</button></div>
      </>)}
      {step === "select" && src === "local" && <LocalSource run={run} back={reset} setProgress={setProgress} />}

      {step === "importing" && (
        <div className="sp-state" role="status">
          <b>Importing {label}</b>
          {progress
            ? <><p>Saved {progress.done} of {progress.total} files</p><div className="sp-progress"><span style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div></>
            : <p className="ip-busy"><Loader2 className="animate-spin" /> Downloading and saving files… this can take a minute for large repositories.</p>}
        </div>
      )}
      {step === "success" && done && (
        <StateBox title="Import complete" text={`${done.name} was saved with ${done.files} file${done.files === 1 ? "" : "s"}${done.skipped ? ` (${done.skipped} skipped)` : ""}.`}>
          <button className="sp-btn" onClick={reset}>Import another</button>
          <button className="sp-btn is-primary" onClick={() => nav({ to: "/project/$projectId", params: { projectId: done.slug } })}>Open Project</button>
        </StateBox>
      )}
      {step === "error" && (
        <StateBox tone="error" title="Import failed" text={err}>
          <button className="sp-btn" onClick={() => setStep("select")}>Back</button>
          <button className="sp-btn is-primary" onClick={() => retry.current?.()}>Retry</button>
        </StateBox>
      )}
    </PageShell>
  );
}

type Run = (name: string, job: () => Promise<Done>) => Promise<void>;

function UrlImport({ provider, run }: { provider: RemoteId; run: Run }) {
  const [url, setUrl] = useState("");
  const [bad, setBad] = useState("");
  const submit = () => {
    const u = url.trim();
    if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+/.test(u)) return setBad("Enter a full repository URL, like " + placeholders[provider]);
    setBad("");
    const name = u.replace(/\/+$/, "").replace(/\.git$/, "").split("/").pop() ?? "repository";
    void run(name, async () => { const r = await importFromUrl({ data: { url: u, provider } }); return { slug: r.project.slug, name: r.project.name, files: r.files, skipped: r.skipped.length }; });
  };
  return (
    <section className="ip-block">
      <h3>Public repository URL</h3>
      <div className="ip-url">
        <input className="sp-input" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder={placeholders[provider]} aria-label="Repository URL" inputMode="url" autoCapitalize="off" spellCheck={false} />
        <button className="sp-btn is-primary" disabled={!url.trim()} onClick={submit}>Import</button>
      </div>
      {bad && <p className="sp-err">{bad}</p>}
    </section>
  );
}

function GithubSource({ run, back }: { run: Run; back: () => void }) {
  const [conn, setConn] = useState<Awaited<ReturnType<typeof getGithubConnection>> | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Repo | null>(null);

  useEffect(() => {
    getGithubConnection().then((c) => {
      setConn(c);
      if (c.connected) githubRepos().then(setRepos).catch((e) => { setErr(msg(e)); if (/reconnect/i.test(msg(e))) setConn({ ...c, connected: false, reconnectRequired: true }); });
    }).catch((e) => setErr(msg(e)));
  }, []);
  const list = useMemo(() => (repos ?? []).filter((r) => `${r.fullName}`.toLowerCase().includes(q.toLowerCase())), [repos, q]);

  return (<>
    <section className="ip-block">
      <h3>Your repositories</h3>
      {!conn && !err && <SkeletonRows n={3} />}
      {conn && !conn.connected && (
        <StateBox title={conn.reconnectRequired ? "Reconnect GitHub" : "Connect GitHub"} text={conn.reconnectRequired ? "Your GitHub access expired or was revoked. Reconnect to see your repositories." : "Authorize Speed to read your repositories, including private ones."}>
          <button className="sp-btn is-primary" onClick={() => { window.location.href = oauthStartUrl("github"); }}><Github /> {conn.reconnectRequired ? "Reconnect GitHub" : "Connect GitHub"}</button>
        </StateBox>
      )}
      {conn?.connected && !repos && !err && <SkeletonRows n={4} />}
      {err && <p className="sp-err">{err}</p>}
      {conn?.connected && repos && (<>
        <label className="sp-search is-inline"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" /></label>
        {list.length === 0 ? <StateBox title="No repositories found" text={repos.length ? `Nothing matches "${q}".` : "This GitHub account has no repositories."} /> : (
          <ul className="sp-list ip-scroll">
            {list.map((r) => (
              <li key={r.id} className={`sp-row ${pick?.id === r.id ? "is-picked" : ""}`}>
                <button className="sp-row-main" onClick={() => setPick(r)} aria-pressed={pick?.id === r.id}>
                  <span className="sp-ico">{r.private ? <Lock /> : <Globe />}</span>
                  <span className="sp-row-text"><b>{r.name}</b><em>{r.owner} · {r.private ? "Private" : "Public"} · {r.defaultBranch}</em></span>
                  {pick?.id === r.id && <Check className="sp-check" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="sp-footer"><button className="sp-btn is-primary" disabled={!pick} onClick={() => pick && void run(pick.name, async () => { const r = await importGithubRepo({ data: { repoId: pick.id } }); return { slug: r.project.slug, name: r.project.name, files: r.files, skipped: r.skipped.length }; })}>Import selected</button></div>
      </>)}
    </section>
    <UrlImport provider="github" run={run} />
    <div className="sp-footer"><button className="sp-btn" onClick={back}>Back</button></div>
  </>);
}

type Local = { name: string; source: "zip" | "directory"; tree: ProjectTree };
const dirSupported = () => typeof document !== "undefined" && "webkitdirectory" in document.createElement("input");

function LocalSource({ run, back, setProgress }: { run: Run; back: () => void; setProgress: (p: { done: number; total: number } | null) => void }) {
  const zip = useRef<HTMLInputElement>(null);
  const dir = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<Local | null>(null);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState("");
  const [canDir, setCanDir] = useState(true);
  useEffect(() => setCanDir(dirSupported()), []);

  const load = async (f: () => Promise<Local>) => {
    setErr(""); setReading(true); setLocal(null);
    try { const l = await f(); if (!l.tree.files.length) throw new Error("No importable files were found"); setLocal(l); }
    catch (e) { setErr(msg(e)); }
    setReading(false);
  };
  const onZip = (file: File) => load(async () => {
    if (!/\.zip$/i.test(file.name)) throw new Error("Choose a .zip file");
    if (file.size > 50 * 1024 * 1024) throw new Error("ZIP is larger than 50 MB");
    return { name: file.name.replace(/\.zip$/i, ""), source: "zip", tree: buildTree(unzipEntries(new Uint8Array(await file.arrayBuffer())), "zip") };
  });
  const onDir = (files: File[]) => load(async () => {
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > 200 * 1024 * 1024) throw new Error("This folder is larger than 200 MB");
    const kept = files.filter((f) => !/(^|\/)(node_modules|\.git)\//.test(f.webkitRelativePath));
    const entries = await Promise.all(kept.map(async (f) => ({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    return { name: files[0]?.webkitRelativePath.split("/")[0] || "project", source: "directory", tree: buildTree(entries, "directory") };
  });

  const start = (l: Local) => run(l.name, async () => {
    const files = l.tree.files;
    const p = await importLocalStart({ data: { name: l.name, source: l.source, files: files.length } });
    setProgress({ done: 0, total: files.length });
    try {
      let i = 0;
      while (i < files.length) {
        const batch = []; let bytes = 0;
        while (i < files.length && batch.length < 150 && bytes < 3_000_000) { const f = files[i++]!; bytes += f.content?.length ?? 0; batch.push({ path: f.path, size: f.size, kind: f.kind, content: f.content }); }
        await importLocalBatch({ data: { projectId: p.id, source: l.source, files: batch } });
        setProgress({ done: i, total: files.length });
      }
      const r = await importLocalFinish({ data: { projectId: p.id, expected: files.length } });
      return { slug: r.project.slug, name: r.project.name, files: r.files, skipped: l.tree.skipped.length };
    } catch (e) {
      await importLocalAbort({ data: { projectId: p.id } }).catch(() => undefined);
      throw e;
    }
  });

  return (<>
    <div className="sp-drop">
      {local ? (<>
        <div className="sp-file"><span className="sp-ico">{local.source === "zip" ? <FileArchive /> : <FolderUp />}</span><span className="sp-row-text"><b>{local.name}</b><em>{local.tree.files.length} file{local.tree.files.length === 1 ? "" : "s"} · {local.tree.dirs.length} folders · {kb(local.tree.totalBytes)}</em></span><button className="sp-icon-btn" onClick={() => setLocal(null)} aria-label="Remove"><X /></button></div>
        <ul className="ip-tree" aria-label="Files to import">
          {local.tree.files.slice(0, 200).map((f) => <li key={f.path}><FileText /><span>{f.path}</span>{f.kind !== "text" && <em>{f.kind === "binary" ? "binary" : "too large, name only"}</em>}</li>)}
          {local.tree.files.length > 200 && <li className="ip-more">and {local.tree.files.length - 200} more</li>}
        </ul>
        {local.tree.skipped.length > 0 && <p className="ip-note">{local.tree.skipped.length} skipped: {local.tree.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join(", ")}{local.tree.skipped.length > 3 ? "…" : ""}</p>}
      </>) : reading ? <p className="ip-busy"><Loader2 className="animate-spin" /> Reading files…</p> : (<>
        <b>Select a project to import</b>
        <p>Upload a ZIP archive, or choose a project folder on this device.</p>
        <div className="sp-state-actions">
          <button className="sp-btn" onClick={() => zip.current?.click()}><FileArchive /> Upload ZIP</button>
          <button className="sp-btn" disabled={!canDir} onClick={() => dir.current?.click()}><FolderUp /> Import Directory</button>
        </div>
        {!canDir && <p className="ip-note">This browser can't pick folders. Upload a ZIP instead.</p>}
      </>)}
      {err && <p className="sp-err">{err}</p>}
    </div>
    <div className="sp-footer"><button className="sp-btn" onClick={back}>Back</button><button className="sp-btn is-primary" disabled={!local} onClick={() => local && void start(local)}>Import</button></div>
    <input ref={zip} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onZip(f); }} />
    <input ref={dir} type="file" hidden multiple {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ""; if (fs.length) void onDir(fs); else setErr("That folder is empty"); }} />
  </>);
}
