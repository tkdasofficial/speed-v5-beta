import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/pages/Settings";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [
    { title: "Settings — Speed Agent" },
    { name: "description", content: "Account and policy links for Speed Agent." },
    { property: "og:title", content: "Settings — Speed Agent" },
    { property: "og:description", content: "Account and policy links for Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: SettingsPage,
});
