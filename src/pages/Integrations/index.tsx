import { CalendarDays, Database, FileText, Github, HardDrive, Loader2, Mail, Plus, RefreshCw, Sheet as SheetIcon, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc, oauthStartUrl } from "@/lib/api";
import { PageShell, StateBox } from "@/components/PageShell";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import "@/style/Integrations/index.css";

type Conn = { id: string; integration: string; account: string; status: "connected" | "reconnect_required"; scopes: string[]; connectedAt: string; lastUsedAt: string | null; metadata: Record<string, unknown> | null };
type Def = { id: string; name: string; desc: string; icon: typeof Github; multi: boolean };
type Check = { ok: boolean; summary: string; reconnect?: boolean };

const DEFS: Def[] = [
  { id: "github", name: "GitHub", desc: "Import repositories and sync code", icon: Github, multi: false },
  { id: "supabase", name: "Supabase", desc: "Manage organizations and projects", icon: Database, multi: true },
  { id: "google_drive", name: "Google Drive", desc: "Browse and attach Drive files", icon: HardDrive, multi: true },
  { id: "google_gmail", name: "Gmail", desc: "Search, read and send email", icon: Mail, multi: true },
  { id: "google_sheets", name: "Google Sheets", desc: "Read and update spreadsheets", icon: SheetIcon, multi: true },
  { id: "google_docs", name: "Google Docs", desc: "Read, create and edit documents", icon: FileText, multi: true },
  { id: "google_calendar", name: "Google Calendar", desc: "View and schedule events", icon: CalendarDays, multi: true },
];
const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/drive.readonly": "Read your Drive files",
  "https://www.googleapis.com/auth/drive.metadata.readonly": "See file names in Drive",
  "https://www.googleapis.com/auth/gmail.readonly": "Read email",
  "https://www.googleapis.com/auth/gmail.send": "Send email",
  "https://www.googleapis.com/auth/spreadsheets": "Read and edit spreadsheets",
  "https://www.googleapis.com/auth/documents": "Read and edit documents",
  "https://www.googleapis.com/auth/calendar.readonly": "See calendars",
  "https://www.googleapis.com/auth/calendar.events": "Manage events",
  repo: "Repositories", "read:user": "Profile", "user:email": "Email address",
};
const scopeText = (s: string[]) => s.map((x) => SCOPE_LABELS[x]).filter(Boolean);
const when = (d: string | null) => (d ? new Date(d.replace(" ", "T") + (d.includes("Z") ? "" : "Z")).toLocaleString() : "—");

export function IntegrationsPage() {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [manage, setManage] = useState<Conn | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [confirm, setConfirm] = useState<Conn | null>(null);

  const load = useCallback(() => rpc<Conn[]>("listIntegrations").then((c) => { setConns(c); setLoadErr(null); }).catch((e: Error) => setLoadErr(e.message)), []);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const name = DEFS.find((d) => d.id === sp.get("integration"))?.name ?? "Integration";
    if (sp.get("connected")) setNotice({ ok: true, text: `${name} connected as ${sp.get("connected")}` });
    else if (sp.get("error")) setNotice({ ok: false, text: sp.get("error")! });
    if (sp.toString()) window.history.replaceState(null, "", window.location.pathname);
    void load();
  }, [load]);

  const connect = (id: string) => {
    if (id === "github") { window.location.href = oauthStartUrl("github"); return; }
    setBusy(`connect:${id}`);
    rpc<{ url: string }>("integrationConnect", { integration: id, origin: window.location.origin })
      .then(({ url }) => { window.location.href = url; })
      .catch((e: Error) => { setBusy(null); setNotice({ ok: false, text: e.message }); });
  };
  const target = (c: Conn) => (c.integration === "github" ? { integration: "github" } : { connectionId: c.id });
  const test = (c: Conn) => {
    setBusy(`test:${c.id}`); setCheck(null);
    rpc<Check>("integrationTest", target(c)).then((r) => { setCheck(r); if (r.reconnect) void load(); })
      .catch((e: Error) => setCheck({ ok: false, summary: e.message })).finally(() => setBusy(null));
  };
  const disconnect = (c: Conn) => {
    setBusy(`disc:${c.id}`);
    rpc("integrationDisconnect", target(c))
      .then(() => { setConns((l) => l?.filter((x) => x.id !== c.id) ?? l); setManage(null); setNotice({ ok: true, text: `${c.account} disconnected` }); })
      .catch((e: Error) => setNotice({ ok: false, text: e.message }))
      .finally(() => { setBusy(null); setConfirm(null); void load(); });
  };

  const defs = useMemo(() => { const s = q.trim().toLowerCase(); return DEFS.filter((d) => !s || `${d.name} ${d.desc}`.toLowerCase().includes(s)); }, [q]);
  const def = (id: string) => DEFS.find((d) => d.id === id)!;
  const meta = manage?.metadata;

  return (
    <PageShell title="Integrations" search={q} onSearch={setQ}>
      {notice && <p className={notice.ok ? "sp-ok" : "sp-err"} role="status">{notice.text}</p>}
      {loadErr ? (
        <StateBox tone="error" title="Couldn't load integrations" text={loadErr}><button className="sp-btn" onClick={() => void load()}>Retry</button></StateBox>
      ) : defs.length === 0 ? (
        <StateBox title="No matching integration" text={`Nothing matches "${q}".`}><button className="sp-btn" onClick={() => setQ("")}>Show all</button></StateBox>
      ) : (
        <ul className="ig-grid">
          {defs.map((d) => {
            const mine = conns?.filter((c) => c.integration === d.id) ?? [];
            const I = d.icon;
            const connecting = busy === `connect:${d.id}`;
            return (
              <li key={d.id} className="ig-card">
                <div className="ig-head">
                  <span className="sp-ico"><I /></span>
                  <span className="ig-title"><b>{d.name}</b><span>{d.desc}</span></span>
                  {conns === null ? <Loader2 className="ig-spin animate-spin" aria-label="Loading" />
                    : mine.length === 0 && <button className="sp-btn is-primary" disabled={connecting} onClick={() => connect(d.id)}>{connecting ? <><Loader2 className="animate-spin" /> Redirecting</> : "Connect"}</button>}
                </div>
                {mine.length > 0 && (
                  <ul className="ig-accounts">
                    {mine.map((c) => (
                      <li key={c.id} className="ig-account">
                        <span className="ig-acc-text"><b>{c.account}</b><i className={`sp-status ${c.status === "connected" ? "st-connected" : "st-auth"}`}>{c.status === "connected" ? "Connected" : "Reconnect required"}</i></span>
                        <span className="ig-acc-actions">
                          {c.status === "reconnect_required"
                            ? <button className="sp-btn is-primary" disabled={!!busy} onClick={() => connect(d.id)}><RefreshCw /> Reconnect</button>
                            : <button className="sp-btn" onClick={() => { setCheck(null); setManage(c); }}>Manage</button>}
                          <button className="sp-btn is-danger" disabled={busy === `disc:${c.id}`} onClick={() => setConfirm(c)}>Disconnect</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {mine.length > 0 && d.multi && (
                  <button className="ig-add" disabled={connecting} onClick={() => connect(d.id)}>{connecting ? <Loader2 className="animate-spin" /> : <Plus />} Connect another account</button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={!!manage} onOpenChange={(o) => !o && setManage(null)}>
        <SheetContent side="bottom" className="sp-sheet">
          {manage && (() => { const d = def(manage.integration); const scopes = scopeText(manage.scopes); return (<>
            <SheetHeader className="text-left">
              <div className="flex items-center gap-3"><span className="sp-ico"><d.icon /></span><div><SheetTitle>{d.name}</SheetTitle><SheetDescription>{manage.account}</SheetDescription></div></div>
            </SheetHeader>
            <dl className="sp-dl">
              <dt>Status</dt><dd><i className={`sp-status ${manage.status === "connected" ? "st-connected" : "st-auth"}`}>{manage.status === "connected" ? "Connected" : "Reconnect required"}</i></dd>
              <dt>Connected</dt><dd>{when(manage.connectedAt)}</dd>
              {manage.lastUsedAt && (<><dt>Last used</dt><dd>{when(manage.lastUsedAt)}</dd></>)}
              {scopes.length > 0 && (<><dt>Access</dt><dd>{scopes.join(" · ")}</dd></>)}
              {Array.isArray(meta?.["organizations"]) && (<><dt>Organizations</dt><dd>{(meta["organizations"] as string[]).join(", ")}</dd></>)}
              {Array.isArray(meta?.["projects"]) && (<><dt>Projects</dt><dd>{(meta["projects"] as { name: string; region: string }[]).map((p) => `${p.name} (${p.region})`).join(", ") || "None yet"}</dd></>)}
              {Array.isArray(meta?.["calendars"]) && (<><dt>Calendars</dt><dd>{(meta["calendars"] as string[]).join(", ")}</dd></>)}
              {Array.isArray(meta?.["recent"]) && (meta["recent"] as string[]).length > 0 && (<><dt>Recent</dt><dd>{(meta["recent"] as string[]).slice(0, 5).join(", ")}</dd></>)}
            </dl>
            {check && <p className={check.ok ? "sp-ok" : "sp-err"} role="status">{check.ok && <ShieldCheck className="ig-inline" />} {check.summary}</p>}
            <div className="sp-state-actions">
              <button className="sp-btn is-primary" disabled={busy === `test:${manage.id}`} onClick={() => test(manage)}>{busy === `test:${manage.id}` ? <><Loader2 className="animate-spin" /> Testing</> : "Test connection"}</button>
              {check?.reconnect && <button className="sp-btn" onClick={() => connect(manage.integration)}><RefreshCw /> Reconnect</button>}
              <button className="sp-btn is-danger" onClick={() => setConfirm(manage)}>Disconnect</button>
            </div>
          </>); })()}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {confirm ? def(confirm.integration).name : ""}?</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.account} will be disconnected and Speed will no longer be able to use this account.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); if (confirm) disconnect(confirm); }} disabled={!!confirm && busy === `disc:${confirm.id}`}>
              {confirm && busy === `disc:${confirm.id}` ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
