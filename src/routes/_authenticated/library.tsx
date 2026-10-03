import { createFileRoute } from "@tanstack/react-router";
import { LibraryPage } from "@/pages/Library";

export const Route = createFileRoute("/_authenticated/library")({
  head: () => ({
    meta: [
      { title: "Library — Speed Agent" },
      { name: "description", content: "Search, open, rename, duplicate and manage all your Speed projects." },
      { property: "og:title", content: "Library — Speed Agent" },
      { property: "og:description", content: "Search, open, rename, duplicate and manage all your Speed projects." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LibraryPage,
});
