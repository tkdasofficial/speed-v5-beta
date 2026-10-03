import { isActive, useTasks } from "@/lib/tasks";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Bot, ChevronDown, Loader2, CircleHelp, FolderGit2, Import, Layers3, Library, LogOut, MoreHorizontal, PanelLeft, Pin, Plus, Search, Settings, X } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProfile, useProjects } from "@/lib/sync";
import { deleteProject } from "@/lib/api/sync";
import { signOut } from "@/lib/api/auth";
import { teardownShell } from "@shell/index";
import { BrandLogo } from "@/components/BrandLogo";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import "@/style/AppDrawer/index.css";

function BrandMark() {
  return <div className="speed-sidebar__brand"><BrandLogo /><b>SPEED</b></div>;
}

const workspaces = ["Personal workspace", "Team workspace"];

type SidebarPanelProps = {
  mobile?: boolean;
  close: () => void;
  setWorkspace: (name: string) => void;
  goHome: () => void;
};

function SidebarPanel({ mobile = false, close, setWorkspace, goHome }: SidebarPanelProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const live = useProjects() ?? [];
  const projects = live.map((p) => ({ id: p.id, slug: p.slug, name: p.name, chat: true }));
  const profile = useProfile();
  const qc = useQueryClient();
  const removeProject = deleteProject;
  const doSignOut = signOut;
  const displayName = profile?.displayName || profile?.email || "Account";
  const initials = displayName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const logout = async () => { await doSignOut(); teardownShell(qc); qc.removeQueries({ queryKey: ["me"] }); void navigate({ to: "/auth/login" }); };
  const [pinned, setPinned] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [ws, setWs] = useState(workspaces[0]);
  const [wsOpen, setWsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  const go = (to: "/import" | "/library" | "/integrations" | "/dashboard" | "/faq" | "/settings") => { close(); void navigate({ to }); };
  const list = projects
    .filter((p) => !search || p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => Number(pinned.includes(b.name)) - Number(pinned.includes(a.name)));
  const togglePin = (name: string) => setPinned((p) => (p.includes(name) ? p.filter((n) => n !== name) : [...p, name]));

  const panel = <aside className={`speed-sidebar speed-sidebar--${mobile ? "mobile" : "desktop"}`} aria-label="App navigation" onClick={(event) => event.stopPropagation()}>
    {search === null
      ? <div className="speed-sidebar__header"><Button variant="ghost" className="speed-sidebar__brand" onClick={() => go("/dashboard")} aria-label="Dashboard"><BrandMark /></Button><div className="speed-sidebar__header-actions"><Button variant="ghost" size="icon" className="speed-sidebar__icon" aria-label="Search projects" title="Search projects" onClick={() => setSearch("")}><Search /></Button>{mobile && <Button variant="ghost" size="icon" className="speed-sidebar__icon" aria-label="Close navigation" title="Close navigation" onClick={close}><PanelLeft /></Button>}</div></div>
      : <div className="speed-sidebar__search-row"><Search /><input autoFocus placeholder="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} /><Button variant="ghost" size="icon" className="speed-sidebar__icon" aria-label="Close search" title="Close search" onClick={() => setSearch(null)}><X /></Button></div>}
    <div className="speed-sidebar__workspace-wrap">
      <Button variant="ghost" className="speed-sidebar__workspace" onClick={() => setWsOpen(!wsOpen)} aria-expanded={wsOpen} aria-label={`Workspace: ${ws}`}><span className="speed-sidebar__avatar">{ws === workspaces[0] ? "TK" : "TM"}</span><span className="speed-sidebar__workspace-name">{ws}</span><ChevronDown /></Button>
      {wsOpen && <div className="speed-sidebar__menu">{workspaces.map((workspace) => <Button variant="ghost" key={workspace} onClick={() => { setWs(workspace); setWsOpen(false); }}>{workspace}{workspace === ws && <span className="model-check">✓</span>}</Button>)}</div>}
    </div>
    <Button className="speed-sidebar__new" onClick={() => { goHome(); close(); }}><Plus /> New project</Button>
    <nav className="speed-sidebar__nav" aria-label="Main navigation">
      <Button variant="ghost" className={`speed-sidebar__nav-button ${pathname === "/library" ? "is-active" : ""}`} onClick={() => go("/library")}><Library /> Library</Button>
      <Button variant="ghost" className={`speed-sidebar__nav-button ${pathname === "/import" ? "is-active" : ""}`} onClick={() => go("/import")}><Import /> Import</Button>
      <Button variant="ghost" className={`speed-sidebar__nav-button ${pathname === "/integrations" ? "is-active" : ""}`} onClick={() => go("/integrations")}><Layers3 /> Integrations</Button>
    </nav>
    <RunningTasks />
    <div className="speed-sidebar__section-head"><span>Recent</span><span>{list.length}</span></div>
    <div className="speed-sidebar__projects">{list.length === 0 && <p className="speed-sidebar__empty">No projects found</p>}{list.map((project) => <div key={project.name} className="speed-sidebar__project">
      <Button variant="ghost" className="speed-sidebar__project-open" onClick={() => setWorkspace(project.slug)}>{project.chat ? <Bot /> : <FolderGit2 />}<span>{project.name}</span></Button>
      <Button variant="ghost" size="icon" className={`speed-sidebar__icon speed-sidebar__project-actions ${pinned.includes(project.name) ? "is-pinned" : ""}`} aria-label={`${pinned.includes(project.name) ? "Unpin" : "Pin"} ${project.name}`} title={pinned.includes(project.name) ? "Unpin project" : "Pin project"} onClick={() => togglePin(project.name)}><Pin /></Button>
      <Button variant="ghost" size="icon" className="speed-sidebar__icon speed-sidebar__project-actions" aria-label={`More options for ${project.name}`} aria-expanded={menuFor === project.name} title="Project options" onClick={() => setMenuFor(menuFor === project.name ? null : project.name)}><MoreHorizontal /></Button>
      {menuFor === project.name && <div className="speed-sidebar__menu is-project"><Button variant="ghost" onClick={() => setWorkspace(project.slug)}>Open</Button><Button variant="ghost" onClick={() => { togglePin(project.name); setMenuFor(null); }}>{pinned.includes(project.name) ? "Unpin" : "Pin"}</Button><Button variant="ghost" onClick={() => { void removeProject({ data: { id: project.id } }); setMenuFor(null); }}>Remove</Button></div>}
    </div>)}</div>
    <div className="speed-sidebar__account-wrap">
      {settingsOpen && <div className="speed-sidebar__menu is-up" aria-label="Account menu">
        <Button variant="ghost" onClick={() => go("/faq")}><CircleHelp /> Help</Button>
        <Button variant="ghost" onClick={() => go("/settings")}><Settings /> Settings</Button>
        <Button variant="ghost" asChild><Link to="/account" onClick={close}>Account</Link></Button>
        <Button variant="ghost" asChild><Link to="/terms-service" onClick={close}>Terms of Service</Link></Button>
        <Button variant="ghost" asChild><Link to="/privacy-policy" onClick={close}>Privacy Policy</Link></Button>
        <Button variant="ghost" onClick={() => { setSettingsOpen(false); setLogoutOpen(true); }}><LogOut /> Log Out</Button>
      </div>}
      <div className="speed-sidebar__account"><Button variant="ghost" className="speed-sidebar__account-main" aria-label="Open account menu" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><span className="speed-sidebar__avatar">{initials}</span><span className="speed-sidebar__account-copy"><b>{displayName}</b><small>Personal workspace</small></span><ChevronDown className={settingsOpen ? "is-open" : ""} /></Button></div>
    </div>
    <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Log out?</AlertDialogTitle><AlertDialogDescription>You will need to sign in again to open your projects.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogAction onClick={() => void logout()}>Log out</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </aside>;

  return mobile ? <div className="speed-sidebar-backdrop" onClick={close}>{panel}</div> : panel;
}
export function AppDrawer({ open, onClose, onNew, onOpenProject }: { open: boolean; onClose: () => void; onNew: () => void; onOpenProject: (name: string) => void }) {
  if (!open) return null;
  return <SidebarPanel mobile close={onClose} setWorkspace={(name) => { onOpenProject(name); onClose(); }} goHome={onNew} />;
}

export function DesktopSidebar({ onNew, onOpenProject }: { onNew: () => void; onOpenProject: (name: string) => void }) {
  return <SidebarPanel close={() => {}} setWorkspace={onOpenProject} goHome={onNew} />;
}

/** App-wide view of background work still running on the server (survives reloads and closed tabs). */
function RunningTasks() {
  const active = useTasks().filter(isActive);
  if (!active.length) return null;
  const label = (t: { type: string }) => (t.type === "ai_agent" ? "AI agent" : t.type === "file_operation" ? "File changes" : t.type.replace(/_/g, " "));
  return <div className="speed-sidebar__tasks" aria-live="polite">
    <div className="speed-sidebar__section-head"><span>Running</span><span>{active.length}</span></div>
    {active.slice(0, 4).map((t) => <p key={t.id} className="speed-sidebar__empty"><Loader2 className="inline size-3.5 animate-spin mr-1.5" />{label(t)}{t.currentStep ? ` · ${t.currentStep}` : ""}{t.status === "retrying" ? " · retrying" : ""}</p>)}
  </div>;
}
