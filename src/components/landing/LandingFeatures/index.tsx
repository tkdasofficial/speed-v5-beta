import { Blocks, Bot, CheckCircle2, FolderGit2, Library, Loader2, Sparkles } from "lucide-react";

const features = [
  {
    icon: Bot,
    title: "An agent that builds",
    desc: "It plans, writes and fixes code in a loop until your app works.",
    rows: [
      { i: Sparkles, t: "Planning changes…", s: "run" },
      { i: CheckCircle2, t: "Wrote 4 files", s: "done" },
      { i: CheckCircle2, t: "Tests passed", s: "done" },
    ],
  },
  {
    icon: Library,
    title: "Project library",
    desc: "Every app in one place — open, rename or duplicate anytime.",
    rows: [
      { i: Library, t: "Hyper Copilot", s: "done", tag: "Live" },
      { i: Library, t: "Pulse Commerce", s: "run", tag: "Building" },
    ],
  },
  {
    icon: FolderGit2,
    title: "Import & GitHub",
    desc: "Bring a repo, a Figma file or a folder and keep going.",
    rows: [{ i: FolderGit2, t: "github.com/you/app", s: "" }],
    bar: 72,
  },
  {
    icon: Blocks,
    title: "Integrations",
    desc: "Auth, database, payments and more — without leaving the workspace.",
    rows: [
      { i: CheckCircle2, t: "Database — Connected", s: "done" },
      { i: Loader2, t: "Payments — Connecting…", s: "run" },
    ],
  },
];

export function LandingFeatures() {
  return (
    <section className="lp-section" id="features">
      <div className="lp-section-head">
        <span className="lp-eyebrow">Features</span>
        <h2>Everything you need to ship</h2>
        <p>From the first message to a live app — one workspace, zero setup.</p>
      </div>
      <div className="lp-feature-grid">
        {features.map((f) => (
          <article key={f.title} className="lp-feature">
            <span className="lp-feature-ico"><f.icon /></span>
            <h3>{f.title}</h3>
            <p>{f.desc}</p>
            <div className="lp-feature-shot">
              {f.rows.map((r) => (
                <div key={r.t} className={`lp-shot-row ${r.s}`}>
                  <r.i /><span>{r.t}</span>
                  {"tag" in r && r.tag ? <em>{r.tag}</em> : null}
                </div>
              ))}
              {f.bar ? <div className="lp-shot-bar"><i style={{ width: `${f.bar}%` }} /></div> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
