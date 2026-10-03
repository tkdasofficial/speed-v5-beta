import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, Eye, Rocket, Zap } from "lucide-react";
import { AppIcon } from "@/components/AppIcon";
import "@/style/auth/index.css";

const POINTS = [
  { icon: Bot, title: "An agent that builds", text: "Describe it. Speed plans, codes and fixes it." },
  { icon: Eye, title: "Live preview", text: "Watch every change appear as it happens." },
  { icon: Rocket, title: "Ship in one tap", text: "Publish to the web when you're ready." },
];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="au-shell">
      <aside className="au-aside" aria-hidden="true">
        <div className="au-aside-glow" />
        <Link to="/" className="au-brand" aria-label="Speed home"><AppIcon /></Link>
        <div className="au-aside-body">
          <span className="au-badge"><i />Agent is online</span>
          <h2 className="au-aside-title">Build apps at the<br /><span>speed of thought.</span></h2>
          <ul className="au-points">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title}><span className="au-ico"><Icon /></span><div><b>{title}</b><p>{text}</p></div></li>
            ))}
          </ul>
        </div>
        <div className="au-quote"><Zap /><p>From idea to working app in minutes.</p></div>
      </aside>
      <section className="au-main">
        <div className="au-main-glow" />
        <div className="au-top"><Link to="/" className="au-brand" aria-label="Speed home"><AppIcon /></Link></div>
        <div className="au-panel">{children}</div>
        <p className="au-legal">© Speed · <Link to="/terms-service">Terms</Link> · <Link to="/privacy-policy">Privacy</Link></p>
      </section>
    </main>
  );
}
