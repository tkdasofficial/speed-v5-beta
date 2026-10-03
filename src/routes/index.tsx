import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "@/pages/Landing";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "Speed Agent — Build apps at the speed of a conversation" },
    { name: "description", content: "Tell Speed Agent what you want. It plans, builds, tests and ships your app — from one chat." },
    { property: "og:title", content: "Speed Agent — Build apps at the speed of a conversation" },
    { property: "og:description", content: "Tell Speed Agent what you want. It plans, builds, tests and ships your app — from one chat." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ] }),
  component: Landing,
});
