import { createFileRoute } from "@tanstack/react-router";
import { GettingStartedPage } from "@/pages/GettingStarted";

export const Route = createFileRoute("/_authenticated/getting-started")({
  head: () => ({ meta: [
    { title: "Getting started — Speed Agent" },
    { name: "description", content: "Set up your Speed Agent profile." },
    { property: "og:title", content: "Getting started — Speed Agent" },
    { property: "og:description", content: "Set up your Speed Agent profile." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: GettingStartedPage,
});
