import { createFileRoute } from "@tanstack/react-router";
import { ForgotPasswordPage } from "@/pages/ForgotPassword";

export const Route = createFileRoute("/auth/forgot-password")({
  head: () => ({ meta: [
    { title: "Reset password — Speed Agent" },
    { name: "description", content: "Reset your Speed Agent password." },
    { property: "og:title", content: "Reset password — Speed Agent" },
    { property: "og:description", content: "Reset your Speed Agent password." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: ForgotPasswordPage,
});
