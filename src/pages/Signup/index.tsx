import { useRedirectIfSignedIn } from "@/lib/session-redirect";
import { AuthShell } from "@/components/AuthShell";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AuthHeader, SocialButtons, startOAuth } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { signUp } from "@/lib/api/auth";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email").max(255),
  password: z.string().min(8, "Password needs at least 8 characters").max(72),
});

export function SignupPage() {
  useRedirectIfSignedIn();
  const navigate = useNavigate();
  const doSignUp = signUp;
  const [form, setForm] = useState({ email: "", password: "" });
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const agreed = () => {
    if (terms && privacy) return true;
    setError("Accept the Terms of Service and Privacy Policy");
    return false;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const r = schema.safeParse(form);
    if (!r.success) return setError(r.error.issues[0]?.message ?? "Check your details");
    if (!agreed()) return;
    setBusy(true);
    try {
      const res = await doSignUp({ data: r.data });
      if (!res.ok) { setBusy(false); return setError(res.error); }
      navigate({ to: "/auth/verify-email" });
    } catch {
      setBusy(false);
      setError("Something went wrong. Try again.");
    }
  };

  return (
    <AuthShell>
        <AuthHeader title="Create account" sub="Start building apps with Speed." />
        <SocialButtons disabled={busy} onPick={(p) => { setError(""); if (agreed()) { setBusy(true); startOAuth(p); } }} />
        <form onSubmit={submit} className="auth-form" noValidate>
          <label>Email<input className="sp-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" maxLength={255} /></label>
          <label>Password<input className="sp-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" maxLength={72} /></label>
          <div className="auth-checks">
            <label><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /><span>I agree to the <Link to="/terms-service">Terms of Service</Link></span></label>
            <label><input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} /><span>I agree to the <Link to="/privacy-policy">Privacy Policy</Link></span></label>
          </div>
          {error && <p className="sp-err" role="alert">{error}</p>}
          <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
        </form>
        <p className="auth-foot">Have an account? <Link to="/auth/login">Log in</Link></p>
      </AuthShell>
  );
}
