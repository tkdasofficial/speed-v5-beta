import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getToken } from "@/lib/api";
import { getMe } from "@/lib/api/auth";

/**
 * Public entry pages (landing, log in, sign up) send a visitor who already has a
 * saved session straight into the app, so a returning user is never asked to
 * log in again. Uses the existing stored session — no new auth mechanism.
 */
export function useRedirectIfSignedIn() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (!getToken()) return;
    let alive = true;
    void getMe().then((me) => {
      if (!alive || !me) return;
      qc.setQueryData(["me"], me);
      const raw = new URLSearchParams(window.location.search).get("redirect");
      let to = "/dashboard";
      try { if (raw) { const u = new URL(raw, window.location.origin); if (u.origin === window.location.origin && !u.pathname.startsWith("/auth")) to = u.pathname + u.search; } } catch { /* ignore */ }
      void navigate({ to: me.email_verified ? to : "/auth/verify-email", replace: true } as never);
    });
    return () => { alive = false; };
  }, [navigate, qc]);
}
