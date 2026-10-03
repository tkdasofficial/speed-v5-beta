import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordPage } from "@/pages/ResetPassword";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({ meta: [
    { title: "Set new password — Speed Agent" },
    { name: "description", content: "Choose a new password for your Speed Agent account." },
    { property: "og:title", content: "Set new password — Speed Agent" },
    { property: "og:description", content: "Choose a new password for your Speed Agent account." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ResetPasswordPage,
});
