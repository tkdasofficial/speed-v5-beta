// Runtime-built preview for React + Vite projects. Opening it never builds anything locally:
// it opens a temporary preview session for the stored artifact, closes it on leave/switch, and only
// "Rebuild" asks the server to build again.
import { useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, Loader2, RotateCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { closePreviewSession, openPreviewSession, previewBuildStatus, startPreviewBuild } from "@/lib/api/tasks";

type S = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Server-built preview: a build already exists/ran, or the source is a React + Vite project (package.json lists vite). */
export function isRuntimeProject(settings: S | undefined, packageJson?: string) {
  if (packageJson && /"vite"\s*:/.test(packageJson)) return true;
  return !!settings && (!!str(settings["staticFileId"]) || !!str(settings["buildStatus"]));
}

export function RemotePreview({ projectId, settings }: { projectId: string; settings: S }) {
  const hasArtifact = !!str(settings["staticFileId"]);
  const artifact = str(settings["staticHash"]);
  // Bumped when a build finishes so a fresh session (and the new version) loads even if project data is stale.
  const [fresh, setFresh] = useState(0);
  const [session, setSession] = useState<{ url: string; expiresAt: number; token: string; projectId: string } | null>(null);
  // One session per project + artifact; renewed shortly before expiry, closed on unmount or project switch.
  useEffect(() => {
    if (!hasArtifact && !fresh) { setSession(null); return; }
    let cur: { token: string } | null = null, timer: ReturnType<typeof setTimeout> | undefined, dead = false;
    const open = async () => {
      try {
        const r = await openPreviewSession({ data: { projectId } });
        if (dead || !r.url || !r.expiresAt) return;
        const token = r.url.split("/preview/s/")[1]!.replace(/\/$/, "");
        if (cur) void closePreviewSession({ data: { token: cur.token } }).catch(() => undefined);
        cur = { token };
        setSession({ url: r.url, expiresAt: r.expiresAt, token, projectId });
        timer = setTimeout(() => void open(), Math.max(60_000, r.expiresAt - Date.now() - 2 * 60_000));
      } catch (e) { if (!dead) toast.error(e instanceof Error ? e.message : "Could not open the preview."); }
    };
    void open();
    return () => {
      dead = true; if (timer) clearTimeout(timer);
      if (cur) void closePreviewSession({ data: { token: cur.token } }).catch(() => undefined);
      setSession(null);
    };
  }, [projectId, hasArtifact, artifact, fresh]);
  const url = session && session.projectId === projectId ? session.url : null;
  const raw = str(settings["buildStatus"]) ?? "idle";
  // A build that never reported back before its window closed counts as failed, so Rebuild is usable again.
  const expired = (raw === "queued" || raw === "building") && Number(settings["buildExpires"] ?? 0) < Date.now();
  const qc = useQueryClient();
  // Live status from the server while a build runs, so the screen updates without a reload.
  const [live, setLive] = useState<{ status: string; error: string | null } | null>(null);
  useEffect(() => { setLive(null); }, [projectId]);
  const status = live?.status ?? (expired ? "failed" : raw);
  const error = live ? live.error : str(settings["buildError"]) ?? (expired ? "The build didn't finish in time. Tap Rebuild to try again." : null);
  const polling = status === "queued" || status === "building";
  useEffect(() => {
    if (!polling) return;
    let dead = false;
    const t = setInterval(() => {
      void previewBuildStatus({ data: { projectId } }).then((r) => {
        if (dead) return;
        if (r.status !== "queued" && r.status !== "building") {
          setLive({ status: r.status, error: r.error ?? null });
          if (r.status === "ready") setFresh((n) => n + 1);
          void qc.invalidateQueries();
        }
        else setLive({ status: r.status, error: null });
      }).catch(() => undefined);
    }, 5000);
    return () => { dead = true; clearInterval(t); };
  }, [polling, projectId, qc]);
  const version = settings["buildVersion"] ?? 0;
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const building = status === "queued" || status === "building";
  const rebuild = async () => {
    setBusy(true);
    try {
      const r = await startPreviewBuild({ data: { projectId } });
      if (r.status === "unchanged") toast.success("Nothing changed — the current preview is up to date.");
      else if (r.status === "queued" || r.status === "building") setLive({ status: r.status, error: null });
      else void qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not start the build."); }
    finally { setBusy(false); }
  };
  const copy = () => { if (url) void navigator.clipboard.writeText(url).then(() => toast.success("Preview link copied (works for 30 minutes)")); };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {building ? "Building a new version…" : status === "failed" ? <span className="text-destructive">Latest build failed{hasArtifact ? " — showing the last working version." : "."}</span> : url ? "Live preview" : hasArtifact ? "Opening preview…" : "No preview yet"}
        </span>
        {url && <button type="button" aria-label="Copy preview link" title="Copy link" onClick={copy} className="grid h-7 w-7 place-items-center rounded-[6px] border border-border text-foreground"><Copy className="!h-3.5 !w-3.5" /></button>}
        {url && <a aria-label="Open preview in a new tab" title="Open in new tab" href={url} target="_blank" rel="noreferrer" className="grid h-7 w-7 place-items-center rounded-[6px] border border-border text-foreground"><ExternalLink className="!h-3.5 !w-3.5" /></a>}
        {url && <button type="button" aria-label="Reload preview" title="Reload" onClick={() => setReload((n) => n + 1)} className="grid h-7 w-7 place-items-center rounded-[6px] border border-border text-foreground"><RotateCw className="!h-3.5 !w-3.5" /></button>}
        <button type="button" disabled={busy || building} onClick={() => void rebuild()} className="h-7 shrink-0 rounded-[6px] border border-border px-2.5 font-medium text-foreground disabled:opacity-50">Rebuild</button>
      </div>
      {status === "failed" && error && <p className="m-0 max-h-24 overflow-auto whitespace-pre-wrap border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-[12px] text-destructive">{error}</p>}
      <div className="relative min-h-0 flex-1">
        {url
          ? <iframe key={`${url}-${String(version)}-${reload}`} title="Project preview" src={url} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" className="h-full w-full border-0" />
          : <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-[12px] border border-primary/45 bg-primary/20">{building ? <Loader2 className="!h-5 !w-5 animate-spin" /> : status === "failed" ? <AlertTriangle className="!h-5 !w-5" /> : <Smartphone className="!h-5 !w-5" />}</span>
              <h3 className="mb-2 mt-5 text-[24px] font-extrabold tracking-[-0.03em]">{building ? "Building preview" : "No preview yet"}</h3>
              <p className="m-0 max-w-xs text-[13px] text-muted-foreground">{building ? "This usually takes about a minute. The preview appears here automatically." : "Build this project to get a shareable preview link."}</p>
            </div>}
        {building && url && <div className="absolute right-3 top-3 flex items-center gap-2 rounded-[10px] border border-border bg-card px-2.5 py-1 text-[12px]"><Loader2 className="!h-3.5 !w-3.5 animate-spin text-primary" /> Building</div>}
      </div>
    </div>
  );
}
