import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "@/pages/Integrations";

export const Route = createFileRoute("/_authenticated/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — Speed Agent" },
      { name: "description", content: "Connect GitHub, Figma, databases, storage and deployment services to your Speed projects." },
      { property: "og:title", content: "Integrations — Speed Agent" },
      { property: "og:description", content: "Connect GitHub, Figma, databases, storage and deployment services to your Speed projects." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: IntegrationsPage,
});
