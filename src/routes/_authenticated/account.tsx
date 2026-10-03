import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "@/pages/Account";

export const Route = createFileRoute("/_authenticated/account")({
  head: () => ({ meta: [
    { title: "Account — Speed Agent" },
    { name: "description", content: "Account overview in Speed Agent." },
    { property: "og:title", content: "Account — Speed Agent" },
    { property: "og:description", content: "Account overview in Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: AccountPage,
});
