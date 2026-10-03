import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, Search, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Header, HeaderIcon } from "@/components/Header";
import "@/style/PageShell/index.css";

/** Shared mobile-first shell for Library / Integrations / Import. */
export function PageShell({ title, sub, search, onSearch, actions, children }: {
  title: string; sub?: string | undefined; search?: string; onSearch?: (v: string) => void; actions?: ReactNode; children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const back = () => (window.history.length > 1 ? router.history.back() : router.navigate({ to: "/dashboard" }));
  return (
    <main className="sp-page" style={{ paddingTop: 0 }}>
      <Header
        left={<HeaderIcon label="Back" onClick={back}><ArrowLeft /></HeaderIcon>}
        title={title}
        align="start"
        center={open && onSearch ? (
          <label className="sp-search w-full" style={{ height: 36 }}>
            <Search />
            <input autoFocus value={search} onChange={(e) => onSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}`} aria-label={`Search ${title}`} />
            <button onClick={() => { onSearch(""); setOpen(false); }} aria-label="Close search"><X /></button>
          </label>
        ) : undefined}
        right={<>{onSearch && !open && <HeaderIcon label="Search" onClick={() => setOpen(true)}><Search /></HeaderIcon>}{actions}</>}
      />
      <div className="sp-body">
        {sub && <p className="ap-intro">{sub}</p>}
        {children}
      </div>
    </main>
  );
}

export function StateBox({ title, text, children, tone }: { title: string; text?: string; children?: ReactNode; tone?: "error" }) {
  return (
    <div className={`sp-state ${tone === "error" ? "is-error" : ""}`} role="status">
      <b>{title}</b>
      {text && <p>{text}</p>}
      {children && <div className="sp-state-actions">{children}</div>}
    </div>
  );
}

export function SkeletonRows({ n = 5 }: { n?: number }) {
  return <div className="sp-list" aria-busy="true">{Array.from({ length: n }, (_, i) => <div key={i} className="sp-row sp-skel"><span /><div><i /><i /></div></div>)}</div>;
}
