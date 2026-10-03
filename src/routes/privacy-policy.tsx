import { createFileRoute } from "@tanstack/react-router";
import { PrivacyPage } from "@/pages/PrivacyPolicy";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({ meta: [
    { title: "Privacy Policy — Speed Agent" },
    { name: "description", content: "Privacy policy information for Speed Agent." },
    { property: "og:title", content: "Privacy Policy — Speed Agent" },
    { property: "og:description", content: "Privacy policy information for Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: PrivacyPage,
});
