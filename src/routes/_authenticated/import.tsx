import { createFileRoute } from "@tanstack/react-router";
import { ImportPage } from "@/pages/Import";

export const Route = createFileRoute("/_authenticated/import")({
  head: () => ({
    meta: [
      { title: "Import — Speed Agent" },
      { name: "description", content: "Import GitHub or Bitbucket repositories, Figma designs, or project files into Speed." },
      { property: "og:title", content: "Import — Speed Agent" },
      { property: "og:description", content: "Import GitHub or Bitbucket repositories, Figma designs, or project files into Speed." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ImportPage,
});
