import { AuthShell } from "@/components/AuthShell";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { z } from "zod";
import { AuthHeader } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { requestPasswordReset } from "@/lib/api/auth";

const emailSchema = z.string().trim().email("Enter a valid email").max(255);

export function ForgotPasswordPage() {
  const request = requestPasswordReset;
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const r = emailSchema.safeParse(email);
    if (!r.success) return setError(r.error.issues[0]?.message ?? "Enter a valid email");
    setBusy(true);
    try {
      await request({ data: { email: r.data } });
      setSent(true);
    } catch { setError("Something went wrong. Try again."); }
    setBusy(false);
  };

  return (
    <AuthShell>
        <AuthHeader title="Reset password" sub="We'll email you a link to set a new password." />
        {sent ? (
          <div className="sp-state">
            <b>Check your email</b>
            <p>If an account exists for {email.trim()}, a reset link is on its way.</p>
            <Link to="/auth/login" className="sp-btn is-primary auth-full">Back to log in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="auth-form" noValidate>
            <label>Email<input className="sp-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={255} /></label>
            {error && <p className="sp-err" role="alert">{error}</p>}
            <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
          </form>
        )}
        <p className="auth-foot">Remembered it? <Link to="/auth/login">Log in</Link></p>
      </AuthShell>
  );
}
