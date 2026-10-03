import { createFileRoute } from "@tanstack/react-router";
import { FaqPage } from "@/pages/FAQ";

export const Route = createFileRoute("/faq")({
  head: () => ({ meta: [
    { title: "FAQ — Speed Agent" },
    { name: "description", content: "Frequently asked questions about Speed Agent." },
    { property: "og:title", content: "FAQ — Speed Agent" },
    { property: "og:description", content: "Frequently asked questions about Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: FaqPage,
});
