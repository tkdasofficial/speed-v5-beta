import { AuthShell } from "@/components/AuthShell";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AuthHeader } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { resetPassword } from "@/lib/api/auth";

export function ResetPasswordPage() {
  const reset = resetPassword;
  const [token, setToken] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") ?? ""); }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (pw.length < 8) return setError("Password needs at least 8 characters");
    if (pw !== pw2) return setError("Passwords don't match");
    if (!/^[a-f0-9]{64}$/.test(token)) return setError("This reset link is invalid or has expired");
    setBusy(true);
    try {
      const r = await reset({ data: { token, password: pw } });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setDone(true);
    } catch { setBusy(false); setError("Something went wrong. Try again."); }
  };

  return (
    <AuthShell>
      <AuthHeader title="Set new password" sub="Choose a new password for your account." />
      {done ? (
        <div className="sp-state">
          <b>Password updated</b>
          <p>You've been signed out everywhere. Log in with your new password.</p>
          <Link to="/auth/login" className="sp-btn is-primary auth-full">Log in</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="auth-form" noValidate>
          <label>New password<input className="sp-input" type="password" autoComplete="new-password" maxLength={72} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          <label>Confirm password<input className="sp-input" type="password" autoComplete="new-password" maxLength={72} value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
          {error && <p className="sp-err" role="alert">{error}</p>}
          <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Saving…" : "Save password"}</Button>
        </form>
      )}
    </AuthShell>
  );
}
