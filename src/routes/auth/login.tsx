import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "@/pages/Login";

export const Route = createFileRoute("/auth/login")({
  head: () => ({ meta: [
    { title: "Log in — Speed Agent" },
    { name: "description", content: "Log in to Speed Agent." },
    { property: "og:title", content: "Log in — Speed Agent" },
    { property: "og:description", content: "Log in to Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: LoginPage,
});
