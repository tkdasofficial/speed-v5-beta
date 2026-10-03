import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/workspace")({
  head: () => ({ meta: [
    { title: "Workspace — Speed Agent" },
    { name: "description", content: "Continue working in your Speed Agent project." },
    { property: "og:title", content: "Workspace — Speed Agent" },
    { property: "og:description", content: "Continue working in your Speed Agent project." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  beforeLoad: () => { throw redirect({ to: "/dashboard" }); },
});
