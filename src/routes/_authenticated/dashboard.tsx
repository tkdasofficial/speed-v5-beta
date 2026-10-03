import { createFileRoute } from "@tanstack/react-router";
import { EvoAgent } from "@/pages/Dashboard";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Speed Agent" },
      { name: "description", content: "Overview of your projects and agent activity." },
      { property: "og:title", content: "Dashboard — Speed Agent" },
      { property: "og:description", content: "Overview of your projects and agent activity." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EvoAgent,
});
