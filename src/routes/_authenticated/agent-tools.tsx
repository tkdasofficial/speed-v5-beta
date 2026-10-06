import { createFileRoute } from "@tanstack/react-router";
import { AgentToolsPage } from "@/pages/AgentTools";

export const Route = createFileRoute("/_authenticated/agent-tools")({
  head: () => ({ meta: [
    { title: "Agent tools — Speed Agent" },
    { name: "description", content: "Inspect every tool the Speed agent can use, with status, permissions and risk." },
    { property: "og:title", content: "Agent tools — Speed Agent" },
    { property: "og:description", content: "Inspect every tool the Speed agent can use, with status, permissions and risk." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: AgentToolsPage,
});
