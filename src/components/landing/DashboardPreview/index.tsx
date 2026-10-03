import { Blocks, FolderGit2, Library, PanelsTopLeft, Send } from "lucide-react";

const sideNav = [
  { icon: PanelsTopLeft, label: "Projects", active: true },
  { icon: Library, label: "Library" },
  { icon: FolderGit2, label: "Import" },
  { icon: Blocks, label: "Integrations" },
];

const projects = [
  { name: "Hyper Copilot", kind: "Agent workspace", status: "Live" },
  { name: "Stellar Dashboard", kind: "Analytics", status: "Live" },
  { name: "Pulse Commerce", kind: "Storefront", status: "Building" },
  { name: "Nexus API", kind: "Developer tools", status: "Live" },
];

export function DashboardPreview() {
  return (
    <section className="lp-preview-wrap" aria-label="Dashboard preview">
      <div className="lp-preview">
        <div className="lp-preview-bar">
          <i /><i /><i />
          <span className="lp-preview-url">speed.dev/dashboard</span>
        </div>
        <div className="lp-preview-body">
          <aside className="lp-preview-side">
            {sideNav.map((n) => (
              <span key={n.label} className={`lp-side-item${n.active ? " active" : ""}`}>
                <n.icon />{n.label}
              </span>
            ))}
          </aside>
          <div className="lp-preview-main">
            <div className="lp-preview-head">
              <b>Projects</b>
              <span>4 projects · 3 live</span>
            </div>
            <div className="lp-cards">
              {projects.map((p, i) => (
                <div key={p.name} className="lp-mini-card">
                  <div className={`lp-mini-thumb t${i}`} />
                  <b>{p.name}</b>
                  <small>{p.kind}</small>
                  <span className={`lp-status${p.status === "Building" ? " build" : ""}`}>{p.status}</span>
                </div>
              ))}
            </div>
            <div className="lp-composer-mock">
              <span className="lp-composer-text">Ask Speed Agent to build anything…</span>
              <span className="lp-composer-send"><Send /></span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
