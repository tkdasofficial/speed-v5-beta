import { ChatInput } from "@/components/ChatInput";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  Database,
  ExternalLink,
  FileCode2,
  FileSpreadsheet,
  FolderGit2,
  Gauge,
  Image,
  Globe2,
  Import,
  Layers3,
  Lightbulb,
  Library,
  Menu,
  Mic,
  MoreHorizontal,
  Pin,
  Presentation,
  PanelLeft,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  ListChecks,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@realtime/store";
import type { Project } from "@realtime/events";
import { trackJob } from "@/lib/tasks";
import { startProject } from "@/lib/api/tasks";
import { AppDrawer, DesktopSidebar } from "@/components/AppDrawer";
import { projectSlug } from "@/lib/projects";
import { useProjects } from "@/lib/sync";
import { useAiMode } from "@/lib/ai-mode";
import "@/style/Dashboard/index.css";


type PreviewKind = "copilot" | "analytics" | "store" | "developer";

function ProjectPreview({ type }: { type: PreviewKind }) {
  return <span className={`project-thumb preview-${type}`} aria-hidden="true">
    <span className="preview-window">
      <span className="preview-top"><i /><i /><i /><em /></span>
      <span className="preview-body">
        <span className="preview-rail"><i /><i /><i /><i /></span>
        <span className="preview-content">
          <i className="preview-heading" />
          <span className="preview-feature"><i /><i /></span>
          <span className="preview-tiles"><i /><i /><i /></span>
          <i className="preview-line" />
        </span>
      </span>
    </span>
  </span>;
}

export function EvoAgent() {
  const [drawer, setDrawer] = useState(false);
  const navigate = useNavigate();
  const openProject = (name: string) => void navigate({ to: "/project/$projectId", params: { projectId: projectSlug(name) } });
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiMode] = useAiMode();
  const qc = useQueryClient();
  // One creation action = one requestId; reused on retry so the server never creates a second project or task.
  const pending = useRef<{ prompt: string; requestId: string } | null>(null);
  const inFlight = useRef(false);

  const beginTask = async () => {
    const text = prompt;
    if (!text.trim() || inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    if (pending.current?.prompt !== text) pending.current = { prompt: text, requestId: crypto.randomUUID() };
    try {
      const r = await startProject({ data: { requestId: pending.current.requestId, prompt: text, model: aiMode.model, depth: aiMode.depth, plan: !!aiMode.plan } });
      qc.setQueryData<Project[]>(keys.projects, (l) => [r.project, ...(l ?? []).filter((p) => p.id !== r.project.id)]);
      if (r.job) trackJob(r.job);
      pending.current = null;
      setPrompt("");
      void navigate({ to: "/project/$projectId", params: { projectId: r.project.slug } });
    } catch (e) {
      setError(e instanceof Error ? `Couldn't create the project: ${e.message}` : "Couldn't create the project. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  return (
    <div className="app-shell">
      <DesktopSidebar onNew={() => { setPrompt(""); setRunning(false); }} onOpenProject={openProject} />

      <div className="main-frame">

        <Home openProject={openProject} openDrawer={() => setDrawer(true)} prompt={prompt} setPrompt={setPrompt} beginTask={() => void beginTask()} busy={running} error={error} />
      </div>

      <AppDrawer open={drawer} onClose={() => setDrawer(false)} onOpenProject={openProject} onNew={() => { setPrompt(""); setRunning(false); }} />
    </div>
  );
}

function Home({ openProject, openDrawer, prompt, setPrompt, beginTask, busy, error }: { openProject: (name: string) => void; openDrawer: () => void; prompt: string; setPrompt: (v: string) => void; beginTask: () => void; busy: boolean; error: string | null }) {
  const dashboardProjects = (useProjects() ?? []).map((p) => ({ name: p.name, slug: p.slug, kind: "Agent project", preview: "copilot" as PreviewKind }));
  return (
    <main className="home-page">
      <div className="home-inner">
         <div className="dashboard-mobile-head"><button onClick={openDrawer} aria-label="Open sidebar"><PanelLeft /></button><div className="mobile-brand"><b>SPEED</b></div><Link to="/faq" className="faq-lamp" aria-label="FAQ"><Lightbulb /></Link></div>

        <div className="ap-glow ap-glow-home" aria-hidden="true" />
        <h1>What are we working<br /><span className="ap-muted">on today?</span></h1>
        {dashboardProjects.length > 0 && <section className="projects-section" aria-labelledby="projects-heading">
          <div className="projects-head"><span id="projects-heading">Projects</span><button>Show all <ChevronRight /></button></div>
          <div className="project-scroll">
            {dashboardProjects.map((project) => (
              <button className="project-card" key={project.name} onClick={() => openProject(project.slug)}>
                 <ProjectPreview type={project.preview} />
                <span className="project-meta"><b>{project.name}</b><small>{project.kind}</small></span>
              </button>
            ))}
          </div>
        </section>}
        <div className="idea-list">
          <button onClick={() => setPrompt("Turn my notes into slides")}><Presentation className="coral" /> Turn my notes into slides</button>
          <button onClick={() => setPrompt("Analyze a Google Sheet")}><FileSpreadsheet className="green" /> Analyze a Google Sheet</button>
          <button onClick={() => setPrompt("Find three directions")}><Sparkles className="orange" /> Find three directions</button>
          <button onClick={() => setPrompt("Turn a sheet into a dashboard")}><BarChart3 className="blue" /> Turn a sheet into a dashboard</button>
        </div>
      </div>
      <div className="composer-wrap">{error && <p role="alert" className="mb-2 text-[13px] font-medium text-destructive">{error}</p>}<ChatInput value={prompt} onChange={setPrompt} onSend={() => beginTask()} busy={busy} onStop={() => {}} placeholder="Start chatting or describe a task..." /></div>
    </main>
  );
}


