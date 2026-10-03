import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailPage } from "@/pages/VerifyEmail";

export const Route = createFileRoute("/auth/verify-email")({
  head: () => ({ meta: [
    { title: "Verify email — Speed Agent" },
    { name: "description", content: "Enter the code we emailed to verify your Speed Agent account." },
    { property: "og:title", content: "Verify email — Speed Agent" },
    { property: "og:description", content: "Enter the code we emailed to verify your Speed Agent account." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: VerifyEmailPage,
});
