import { useRedirectIfSignedIn } from "@/lib/session-redirect";
import { AuthShell } from "@/components/AuthShell";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AuthHeader, SocialButtons, startOAuth } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/api/auth";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(1, "Enter your password").max(72),
});

export function LoginPage() {
  useRedirectIfSignedIn();
  const navigate = useNavigate();
  const doSignIn = signIn;
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("error");
    if (e) setError(e.replace(/_/g, " "));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const r = schema.safeParse(form);
    if (!r.success) return setError(r.error.issues[0]?.message ?? "Check your details");
    setBusy(true);
    try {
      const res = await doSignIn({ data: r.data });
      if (!res.ok) { setBusy(false); return setError(res.error); }
      const raw = new URLSearchParams(window.location.search).get("redirect");
      let to = "/dashboard";
      try { if (raw) { const u = new URL(raw, window.location.origin); if (u.origin === window.location.origin && !u.pathname.startsWith("/auth")) to = u.pathname + u.search; } } catch { /* ignore */ }
      navigate({ to: res.verified ? to : "/auth/verify-email" } as never);
    } catch {
      setBusy(false);
      setError("Something went wrong. Try again.");
    }
  };

  return (
    <AuthShell>
        <AuthHeader title="Log in" sub="Welcome back to Speed." />
        <SocialButtons disabled={busy} onPick={(p) => { setBusy(true); startOAuth(p); }} />
        <form onSubmit={submit} className="auth-form" noValidate>
          <label>Email<input className="sp-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" maxLength={255} /></label>
          <label>
            <span className="auth-row">Password<Link to="/auth/forgot-password">Forgot?</Link></span>
            <input className="sp-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="current-password" maxLength={72} />
          </label>
          {error && <p className="sp-err" role="alert">{error}</p>}
          <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Logging in…" : "Log in"}</Button>
        </form>
        <p className="auth-foot">New to Speed? <Link to="/auth/signup">Create account</Link></p>
      </AuthShell>
  );
}
