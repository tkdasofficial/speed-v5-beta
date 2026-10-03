import { createFileRoute } from "@tanstack/react-router";
import { SignupPage } from "@/pages/Signup";

export const Route = createFileRoute("/auth/signup")({
  head: () => ({ meta: [
    { title: "Create account — Speed Agent" },
    { name: "description", content: "Create your Speed Agent account." },
    { property: "og:title", content: "Create account — Speed Agent" },
    { property: "og:description", content: "Create your Speed Agent account." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: SignupPage,
});
