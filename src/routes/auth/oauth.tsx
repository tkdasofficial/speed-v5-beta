import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { setToken } from "@/lib/api";

// Google/GitHub sign-in return page: the API hands back the session in the URL fragment
// (never sent to any server), which is stored and then removed from history.
export const Route = createFileRoute("/auth/oauth")({
  ssr: false,
  head: () => ({ meta: [
    { title: "Signing you in — Speed Agent" },
    { name: "description", content: "Finishing sign-in to Speed Agent." },
    { property: "og:title", content: "Signing you in — Speed Agent" },
    { property: "og:description", content: "Finishing sign-in to Speed Agent." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
    { name: "robots", content: "noindex" },
  ] }),
  component: OAuthReturn,
});

function OAuthReturn() {
  const navigate = Route.useNavigate();
  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.slice(1));
    const token = q.get("token");
    const next = q.get("next");
    history.replaceState(null, "", window.location.pathname);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      setToken(token);
      void navigate({ to: next === "/getting-started" ? "/getting-started" : "/dashboard", replace: true });
    } else {
      void navigate({ to: "/auth/login", replace: true });
    }
  }, [navigate]);
  return null;
}
