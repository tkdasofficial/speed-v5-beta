import { createFileRoute } from "@tanstack/react-router";
import { TermsPage } from "@/pages/TermsOfService";

export const Route = createFileRoute("/terms-service")({
  head: () => ({ meta: [
    { title: "Terms of Service — Speed Agent" },
    { name: "description", content: "Terms of Service information for Speed Agent." },
    { property: "og:title", content: "Terms of Service — Speed Agent" },
    { property: "og:description", content: "Terms of Service information for Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: TermsPage,
});
