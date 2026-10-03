import { AuthShell } from "@/components/AuthShell";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AuthHeader } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { resendVerifyCode, verifyEmail } from "@/lib/api/auth";

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const verify = verifyEmail;
  const resend = resendVerifyCode;
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(""); setNote("");
    if (!/^\d{8}$/.test(code)) return setError("Enter the 8-digit code");
    setBusy(true);
    try {
      const r = await verify({ data: { code } });
      if (!r.ok) { setBusy(false); return setError(r.error); }
      navigate({ to: "/getting-started" });
    } catch { setBusy(false); setError("Something went wrong. Try again."); }
  };

  const again = async () => {
    setError(""); setNote("");
    const r = await resend();
    if (r.ok) setNote("A new code is on its way."); else setError(r.error);
  };

  return (
    <AuthShell>
      <AuthHeader title="Verify your email" sub="We sent an 8-digit code to your email." />
      <form onSubmit={submit} className="auth-form" noValidate>
        <label>Verification code
          <input className="sp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} />
        </label>
        {error && <p className="sp-err" role="alert">{error}</p>}
        {note && <p className="auth-sub" role="status">{note}</p>}
        <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Verifying…" : "Verify"}</Button>
      </form>
      <p className="auth-foot">Didn't get it? <button type="button" className="auth-link" onClick={again}>Send a new code</button></p>
    </AuthShell>
  );
}
