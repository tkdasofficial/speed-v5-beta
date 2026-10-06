import { useEffect, useMemo, useState } from "react";
import { PageShell, StateBox } from "@/components/PageShell";
import { agentTools } from "@/lib/api/agent";
import "@/style/AgentTools/index.css";

type Data = Awaited<ReturnType<typeof agentTools>>;

export function AgentToolsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { agentTools().then(setData, (e: Error) => setError(e.message)); }, []);
  const list = useMemo(() => (data?.tools ?? []).filter((t) => !q || `${t.tool_name} ${t.category} ${t.description}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  if (error) return <PageShell title="Agent tools"><StateBox title="Couldn't load tools" text={error} tone="error" /></PageShell>;
  if (!data) return <PageShell title="Agent tools"><StateBox title="Loading tools…" /></PageShell>;
  return (
    <PageShell title="Agent tools">
      <div className="at-summary">
        <span><b>{data.validation.tools}</b> tools</span>
        <span><b>{data.validation.aliases}</b> aliases</span>
        <span className={data.validation.ok ? "at-ok" : "at-bad"}>{data.validation.ok ? "Registry valid" : `${data.validation.errors.length} problems`}</span>
      </div>
      <input className="at-search" placeholder="Search tools" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tools" />
      <ul className="at-list">
        {list.map((t) => (
          <li key={t.tool_id} className="at-item">
            <div className="at-row"><b>{t.tool_name}</b><span className={t.enabled ? "at-ok" : "at-bad"}>{t.enabled ? "Enabled" : "Disabled"}</span></div>
            <p>{t.description}</p>
            <dl>
              <dt>ID</dt><dd>{t.tool_id}</dd>
              <dt>Category</dt><dd>{t.category}</dd>
              <dt>Version</dt><dd>{t.version}</dd>
              <dt>Risk</dt><dd>{t.risk_level}</dd>
              <dt>Permissions</dt><dd>{t.permissions.join(", ") || "none"}</dd>
              <dt>Handler</dt><dd>{t.handler}</dd>
              <dt>Status</dt><dd>{t.status}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
