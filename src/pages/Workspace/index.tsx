import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ListChecks, MoreHorizontal, PanelLeft, RotateCw, Shapes } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppDrawer, DesktopSidebar } from "@/components/AppDrawer";
import { Header, HeaderIcon } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Categories } from "@/components/workspace/Categories";
import { ChatView } from "@/components/workspace/ChatView";
import { PromptCard } from "@/components/workspace/PromptCard";
import { RemotePreview, isRuntimeProject } from "@/components/workspace/RemotePreview";
import { PreviewView, SettingsView, TasksSheet } from "@/components/workspace/Panels";
import { FilesView } from "@/components/workspace/Files";
import { useWorkspace } from "@/lib/workspace";
import type { WorkspaceAction } from "@/lib/workspace";
import { ProjectMenu } from "@/components/workspace/ProjectMenu";
import { projectSlug } from "@/lib/projects";
import { useMessages, useProjects } from "@/lib/sync";
import { updateProject } from "@/lib/api/sync";
import { decideAgentPlan } from "@/lib/api/tasks";
import { rollbackToRevision, startAgentTask, stopAgentTask } from "@/lib/agent";
import type { ActionKind, AgentAction, ChatItem } from "@/lib/workspace-types";
import { useAiMode } from "@/lib/ai-mode";
import { isActive, trackJob, useTasks } from "@/lib/tasks";
import "@/style/Workspace/index.css";

const KIND: Record<WorkspaceAction["type"], ActionKind> = {
  "file.create": "create", "folder.create": "create", "file.save": "edit", "path.delete": "fix", "path.rename": "edit",
  "path.move": "edit", "path.copy": "create", "snapshot.create": "asset", "snapshot.restore": "fix", "snapshot.delete": "fix",
  "output.generate": "run", prompt: "think", agent: "think",
};
const AGENT_KIND: Record<string, ActionKind> = { read: "read", create: "create", edit: "edit", delete: "fix", think: "think", check: "test", search: "search", inspect: "inspect", fix: "fix" };
const toAgentAction = (a: WorkspaceAction): AgentAction => ({
  id: a.id, kind: (a.agentKind && AGENT_KIND[a.agentKind]) || KIND[a.type], fixed: a.fixed, title: a.description, target: a.path,
  status: a.status === "completed" ? "done" : a.status === "queued" ? "pending" : a.status,
  detail: a.error ?? (a.changes && a.changes.length > 1 ? `${a.changes.length} paths changed` : undefined),
});


type Mode = "chat" | "preview" | "settings";

export function Workspace() {
  const { projectId } = useParams({ from: "/_authenticated/project/$projectId" });
  return <WorkspaceInner key={projectId} projectId={projectId} />;
}

function WorkspaceInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const project = projects?.find((p) => p.slug === projectId);
  const name = project?.name ?? (projects ? "Project not found" : "");
  const rename = updateProject;
  const setName = (n: string) => { if (project && n.trim()) void rename({ data: { id: project.id, name: n.trim() } }); };
  // The one authoritative original prompt, persisted with the project at creation.
  const originalPrompt = typeof project?.settings?.["originalPrompt"] === "string" ? (project.settings["originalPrompt"] as string) : null;
  const allMessages = useMessages(project?.id);
  const firstPromptId = originalPrompt ? allMessages.find((m) => m.role === "user" && m.content === originalPrompt)?.id : undefined;
  const messages = firstPromptId ? allMessages.filter((m) => m.id !== firstPromptId) : allMessages;
  const { store, view } = useWorkspace(project?.id);
  const pkgFile = view ? store?.sandbox.workspace.files.get("package.json") : undefined;
  const pkgJson = pkgFile && pkgFile.encoding !== "base64" ? pkgFile.content : undefined;
  // One timeline: conversation messages, agent rounds (message → actions → message), checkpoints.
  const runs = view?.runs ?? [];
  const localAt = new Map(runs.flatMap((r) => r.messages.map((m) => [m.id, m.at] as const)));
  const runSnaps = new Set(runs.map((r) => r.snapshotId).filter(Boolean));
  const timeline: { at: number; item: ChatItem }[] = [
    ...messages.map((m) => {
      const at = localAt.get(m.id) ?? new Date(`${m.createdAt.replace(" ", "T")}Z`).getTime();
      const item: ChatItem = m.role === "user"
        ? { id: m.id, type: "user", text: m.content, time: new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }
        : { id: m.id, type: "ai", text: m.content };
      return { at, item };
    }),
    ...(view?.snapshots ?? []).filter((sn) => !runSnaps.has(sn.id)).map((sn) => ({ at: sn.createdAt + 1, item: { id: sn.id, type: "checkpoint", text: `Snapshot · ${sn.label}`, snapshotId: sn.id } as ChatItem })),
  ];
  for (const r of runs) {
    if (!r.endedAt) continue;
    const lastMsg = r.messages[r.messages.length - 1]?.at ?? r.endedAt;
    const mins = Math.max(1, Math.round((r.endedAt - r.startedAt) / 60000));
    const secs = Math.round((r.endedAt - r.startedAt) / 1000);
    const took = secs < 60 ? `${secs} seconds` : `${mins} minute${mins > 1 ? "s" : ""}`;
    const text = r.status === "done" ? `Worked for ${took}` : r.status === "stopped" ? `Task Cancelled · after ${took}` : r.status === "denied" ? "Plan denied" : `Failed after ${took}${r.error ? ` · ${r.error}` : ""}`;
    timeline.push({ at: r.status === "done" && r.messages.length > 1 ? lastMsg - 1 : r.endedAt, item: { id: `w-${r.id}`, type: "status", text, state: r.status === "failed" ? "failed" : "done" } });
    if (r.snapshotId && r.status !== "failed" && r.mutated !== false) timeline.push({ at: r.endedAt + 2, item: { id: `c-${r.id}`, type: "checkpoint", text: "Checkpoint saved", snapshotId: r.snapshotId } });
  }
  // Agent actions group by round; other workspace actions group while consecutive.
  const rounds = new Map<string, AgentAction[]>();
  let group: AgentAction[] | null = null;
  for (const a of view?.actions ?? []) {
    if (a.type === "prompt") continue;
    if (a.round) {
      const g = rounds.get(a.round);
      if (g) { g.push(toAgentAction(a)); continue; }
      const ng = [toAgentAction(a)];
      rounds.set(a.round, ng); group = null;
      timeline.push({ at: a.createdAt, item: { id: `g-${a.id}`, type: "actions", actions: ng } });
      continue;
    }
    const last = timeline[timeline.length - 1];
    if (group && last?.item.type === "actions" && last.item.actions === group) { group.push(toAgentAction(a)); continue; }
    group = [toAgentAction(a)];
    timeline.push({ at: a.createdAt, item: { id: `g-${a.id}`, type: "actions", actions: group } });
  }
  const items = timeline.sort((x, y) => x.at - y.at).map((t) => t.item);
  const [aiMode] = useAiMode();
  const qc = useQueryClient();
  const onSend = async (text: string) => {
    if (!project || !store) return;
    try { trackJob(await startAgentTask({ qc, projectId: project.id, prompt: text, mode: { ...aiMode, plan: !!aiMode.plan } })); }
    catch (e) { store.reportRemoteError(e instanceof Error ? e.message : "Couldn't start the agent"); }
  };
  // Processing state comes only from the real server task: its persisted step events, else its live status/current step.
  const jobs = useTasks();
  const activeJob = project ? jobs.find((j) => j.projectId === project.id && j.type === "ai_agent" && isActive(j)) : undefined;
  const activeRun = runs.find((x) => x.status === "running" && (!activeJob || x.id === activeJob.id));
  const activeStep = activeJob ? (activeRun?.step ?? activeJob.currentStep ?? (activeJob.status === "queued" ? "Queued" : "Thinking")) : activeRun?.step ? activeRun.step : null;
  // A plan waiting for a decision comes from the persisted `plan` event of a run parked in awaiting_approval.
  const awaiting = runs.find((x) => x.status === "running" && x.phase === "awaiting_approval" && x.plan);
  const planView = awaiting && !activeJob ? { plan: awaiting.plan!, version: awaiting.planVersion ?? 1 } : undefined;
  const onPlanDecision = async (decision: "approve" | "deny" | "edit", feedback?: string) => {
    if (!awaiting) return;
    try { trackJob(await decideAgentPlan({ data: { id: awaiting.id, decision, ...(feedback ? { feedback } : {}) } })); }
    catch (e) { store?.reportRemoteError(e instanceof Error ? e.message : "Couldn't send your decision"); throw e; }
  };
  const onStop = () => { const id = activeJob?.id ?? activeRun?.id; if (id) void stopAgentTask(id).catch(() => undefined); };
  const onRollback = (id: string) => {
    if (id.startsWith("rev:") && project) void rollbackToRevision(project.id, Number(id.slice(4))).catch((e: unknown) => store?.reportRemoteError(e instanceof Error ? e.message : "Rollback failed"));
    else store?.restoreSnapshot(id);
  };
  const [mode, setMode] = useState<Mode>("chat");
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tools, setTools] = useState(false);
  const [tasks, setTasks] = useState(false);
  const openProject = (projectName: string) => void navigate({ to: "/project/$projectId", params: { projectId: projectSlug(projectName) } });

  return (
    <div className="speed-workspace-shell text-foreground">
      <DesktopSidebar onNew={() => void navigate({ to: "/dashboard" })} onOpenProject={openProject} />
      <div className="speed-workspace-main">
      <AppDrawer open={drawer} onClose={() => setDrawer(false)} onNew={() => void navigate({ to: "/dashboard" })} onOpenProject={openProject} />
      <Header
        left={<HeaderIcon label="Open navigation" onClick={() => setDrawer(true)}><PanelLeft /></HeaderIcon>}
        title={name}
        onTitleClick={() => setMenu(!menu)}
        titleExpanded={menu}
        right={mode === "preview"
          ? <HeaderIcon label="Back to chat" onClick={() => setMode("chat")}><ArrowLeft /></HeaderIcon>
          : <HeaderIcon label="Back" onClick={() => void navigate({ to: "/dashboard" })}><ArrowLeft /></HeaderIcon>}
      />

      <main className="flex min-h-0 flex-1 flex-col">
        {mode === "chat" && <ChatView header={originalPrompt ? <PromptCard prompt={originalPrompt} /> : undefined} items={items} activeStep={activeStep} plan={planView} onPlanDecision={onPlanDecision} onSend={onSend} onStop={onStop} onRollback={onRollback} />}
        {mode === "preview" && project && isRuntimeProject(project.settings, pkgJson) && <RemotePreview projectId={project.id} settings={project.settings} />}
        {mode === "preview" && !(project && isRuntimeProject(project.settings, pkgJson)) && store && view && <PreviewView store={store} view={view} projectName={name} onBack={() => setMode("chat")} />}
        {mode === "settings" && <SettingsView projectId={project?.id} name={name} setName={setName} settings={project?.settings ?? {}} onSettings={(s) => { if (project) void rename({ data: { id: project.id, settings: s } }); }} />}
      </main>

       <footer className={`grid shrink-0 gap-2 px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-1 ${mode === "preview" ? "grid-cols-[minmax(0,1fr)_40px_40px]" : "grid-cols-[40px_minmax(0,1fr)_40px]"}`}>
          {mode === "preview" ? <>
            <select value={view?.preview.page ?? ""} disabled={!view?.previewPages.length} onChange={(e) => store?.setPreviewPage(e.target.value)} aria-label="Preview page" className="h-10 min-w-0 rounded-[12px] border border-border bg-card px-3 text-[13px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {view?.previewPages.length ? view.previewPages.map((p) => <option key={p} value={p}>/{p}</option>) : <option value="">No output</option>}
            </select>
            <Button type="button" variant="outline" size="icon" aria-label="Reload preview" title="Reload preview" disabled={!view?.preview.outputId} onClick={() => store?.reloadPreview()} className="h-10 w-10 rounded-[12px] bg-card font-semibold"><RotateCw className="!h-4 !w-4" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" variant="outline" size="icon" aria-label="More preview options" title="More preview options" className="h-10 w-10 rounded-[12px] bg-card font-semibold"><MoreHorizontal className="!h-4 !w-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="border-border bg-card text-foreground">
                <DropdownMenuItem onSelect={() => store?.generateOutput()}>Generate output</DropdownMenuItem>
                {view?.previewPages.includes("index.html") && <DropdownMenuItem onSelect={() => store?.setPreviewPage("index.html")}>Go to home</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setMode("chat")}>Back to chat</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </> : <>
            <Button type="button" variant="outline" size="icon" aria-label="Tools" title="Tools" onClick={() => setTools(true)} className="h-10 w-10 rounded-[12px] bg-card font-semibold"><Shapes className="!h-4 !w-4" /></Button>
            <Button type="button" variant="outline" onClick={() => setMode("preview")} className="workspace-preview-button h-10 min-w-0 truncate rounded-[10px] px-3 text-[14px] font-bold">Open Preview</Button>
            <Button type="button" variant="outline" size="icon" aria-label="Tasks" title="Tasks" onClick={() => setTasks(true)} className="h-10 w-10 rounded-[12px] bg-card font-semibold"><ListChecks className="!h-4 !w-4" /></Button>
          </>}
      </footer>

       {menu && <ProjectMenu name={name} setName={setName} onClose={() => setMenu(false)} onSettings={() => { setMenu(false); setMode("settings"); }} />}
       {tools && <Categories onClose={() => setTools(false)} code={store && view ? <FilesView store={store} view={view} /> : undefined} />}
      {tasks && <TasksSheet projectId={project?.id} onClose={() => setTasks(false)} />}
      </div>
    </div>
  );
}
