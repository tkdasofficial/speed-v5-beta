import { AuthShell } from "@/components/AuthShell";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { AuthHeader } from "@/components/AuthParts";
import { Button } from "@/components/ui/button";
import { saveProfile } from "@/lib/api/auth";

const schema = z.object({
  fullName: z.string().trim().min(1, "Enter your full name").max(100),
  role: z.string().min(1, "Select your role"),
  teamType: z.string().min(1, "Select your team type"),
});

export function GettingStartedPage() {
  const navigate = useNavigate();
  const save = saveProfile;
  const [form, setForm] = useState({ fullName: "", role: "", teamType: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    const result = schema.safeParse(form);
    if (!result.success) return setError(result.error.issues[0]?.message ?? "Check your details");
    setBusy(true);
    try {
      const res = await save({ data: result.data });
      if (!res.ok) { setBusy(false); return setError(res.error); }
      navigate({ to: "/dashboard" });
    } catch {
      setBusy(false);
      setError("Something went wrong. Try again.");
    }
  };

  return <AuthShell>
      <AuthHeader title="Getting started" sub="Tell us a little about yourself." />
      <form onSubmit={submit} className="auth-form" noValidate>
        <label>Full name<input className="sp-input" autoComplete="name" maxLength={100} value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} /></label>
        <label>Role<select className="sp-input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
          <option value="">Select a role</option>
          <option value="founder">Founder</option>
          <option value="developer">Developer</option>
          <option value="designer">Designer</option>
          <option value="product">Product manager</option>
          <option value="other">Other</option>
        </select></label>
        <label>Team type<select className="sp-input" value={form.teamType} onChange={(event) => setForm({ ...form, teamType: event.target.value })}>
          <option value="">Select a team type</option>
          <option value="solo">Just me</option>
          <option value="startup">Startup</option>
          <option value="company">Company</option>
          <option value="agency">Agency</option>
          <option value="other">Other</option>
        </select></label>
        {error && <p className="sp-err" role="alert">{error}</p>}
        <Button type="submit" className="auth-full" disabled={busy}>{busy ? "Continuing…" : "Continue"}</Button>
      </form>
    </AuthShell>;
}