import { createFileRoute } from "@tanstack/react-router";
import { Workspace } from "@/pages/Workspace";

export const Route = createFileRoute("/_authenticated/project/$projectId")({
  head: () => ({ meta: [
    { title: "Project workspace — Speed Agent" },
    { name: "description", content: "Chat with the agent, preview your app and manage Git, code and files from one mobile workspace." },
    { property: "og:title", content: "Project workspace — Speed Agent" },
    { property: "og:description", content: "Chat with the agent, preview your app and manage Git, code and files from one mobile workspace." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ]}),
  component: Workspace,
});
