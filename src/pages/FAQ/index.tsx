import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, Search, MessageCircle } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import "@/style/FAQ/index.css";

type Faq = { c: string; q: string; a: string };

const faqs: Faq[] = [
  { c: "Getting started", q: "What is Speed Agent?", a: "Speed Agent is an AI workspace that turns your ideas into working apps. Describe what you want in the chat, and the agent plans, builds, previews and refines it with you." },
  { c: "Getting started", q: "Do I need to know how to code?", a: "No. You can build entirely by chatting. If you do code, you can open Tools to view files, edit code and commit to Git." },
  { c: "Getting started", q: "How do I create a new project?", a: "Tap New in the drawer or type an idea into the dashboard chat box. Your project opens in the workspace with the agent ready." },
  { c: "Building", q: "How does the agent work?", a: "The agent replies in rounds: a short message, then a card of actions it took (editing files, running checks), repeating until your request is done. Each finished run saves a checkpoint." },
  { c: "Building", q: "How does Preview work?", a: "Open Preview from the workspace bottom bar to see your app running. Use Reload to refresh and More options for extra controls. Tap Back to return to the chat." },
  { c: "Building", q: "Can I import an existing project?", a: "Yes. Open Import and choose GitHub, Bitbucket, Figma or upload files. The project appears in your Library when the import finishes." },
  { c: "Integrations", q: "Which services can I connect?", a: "Open Integrations to connect services like GitHub, Firebase and more. Connected services show a green Connected status and can be disconnected any time." },
  { c: "Integrations", q: "Is my code synced to GitHub?", a: "When GitHub is connected, you can commit and push from Tools → Git. Changes stay in sync with your repository." },
  { c: "Account", q: "Where do I manage my account?", a: "Tap your account chip at the bottom of the drawer to open Account, Terms of Service, Privacy Policy or Settings." },
  { c: "Account", q: "How do I delete my account?", a: "Go to Settings → Delete account. This permanently removes your projects and data." },
];

const cats = ["All", ...Array.from(new Set(faqs.map((f) => f.c)))];

export function FaqPage() {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const list = useMemo(() => faqs.filter((f) => (cat === "All" || f.c === cat) && (f.q + f.a).toLowerCase().includes(q.trim().toLowerCase())), [q, cat]);
  const groups = Array.from(new Set(list.map((f) => f.c)));

  return (
    <PageShell title="FAQ">
      <div className="faq-wrap">
        <section className="faq-hero">
          <p>Everything you need to know about building with Speed.</p>
          <label className="faq-search">
            <Search />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions" aria-label="Search questions" />
          </label>
        </section>

        <div className="faq-tabs" role="tablist">
          {cats.map((c) => (
            <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? "is-on" : ""} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>

        {groups.length === 0 && <p className="faq-empty">No questions match “{q}”.</p>}

        {groups.map((g) => (
          <section key={g} className="faq-group">
            <h2>{g}</h2>
            <div className="faq-list">
              {list.filter((f) => f.c === g).map((item) => (
                <details className="faq-item" key={item.q}>
                  <summary>{item.q}<ChevronDown /></summary>
                  <p className="faq-a">{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        ))}

        <section className="faq-contact">
          <MessageCircle />
          <div>
            <b>Still have questions?</b>
            <p>Report an issue and our team will get back to you.</p>
          </div>
          <Link to="/settings" className="faq-contact-btn">Contact</Link>
        </section>
      </div>
    </PageShell>
  );
}
