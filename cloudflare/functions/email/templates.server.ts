// Email templates for the allowed notification types only. Server-only.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Block = { heading: string; intro: string; code?: string; button?: { label: string; url: string }; lines?: string[] | undefined; foot?: string };

function layout(b: Block) {
  const lines = (b.lines ?? []).map((l) => `<p style="margin:0 0 6px;color:#1A1A1A;font-size:14px">${esc(l)}</p>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Manrope,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="margin:0 0 24px;font-weight:800;font-size:18px;color:#000000">Speed</p>
<h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#000000">${esc(b.heading)}</h1>
<p style="margin:0 0 20px;color:#1A1A1A;font-size:15px;line-height:1.5">${esc(b.intro)}</p>
${b.code ? `<p style="margin:0 0 20px;font-size:32px;font-weight:800;letter-spacing:6px;color:#1D4ED8">${esc(b.code)}</p>` : ""}
${b.button ? `<p style="margin:0 0 20px"><a href="${esc(b.button.url)}" style="display:inline-block;background:#1D4ED8;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(b.button.label)}</a></p>` : ""}
${lines}
<p style="margin:24px 0 0;color:#1A1A1A;font-size:12px;opacity:.7">${esc(b.foot ?? "If you didn't expect this email, you can ignore it.")}</p>
</div></body></html>`;
  const text = [b.heading, "", b.intro, b.code ?? "", b.button ? `${b.button.label}: ${b.button.url}` : "", ...(b.lines ?? []), "", b.foot ?? "If you didn't expect this email, you can ignore it."]
    .filter((x, i, a) => x !== "" || a[i - 1] !== "").join("\n");
  return { html, text };
}

export const templates = {
  verifyEmail: (p: { code: string }) => ({ subject: `Your Speed verification code: ${p.code}`, ...layout({ heading: "Verify your email", intro: "Enter this 8-digit code in Speed to verify your email. It expires in 15 minutes.", code: p.code }) }),
  passwordReset: (p: { url: string }) => ({ subject: "Reset your Speed password", ...layout({ heading: "Reset your password", intro: "Use the button below to set a new password. The link expires in 30 minutes and works once.", button: { label: "Set new password", url: p.url } }) }),
  loginAlert: (p: { when: string; ip: string; agent: string }) => ({ subject: "New sign-in to your Speed account", ...layout({ heading: "New sign-in detected", intro: "Your Speed account was just signed in to.", lines: [`Time: ${p.when}`, `IP address: ${p.ip}`, `Device: ${p.agent}`], foot: "If this wasn't you, reset your password right away." }) }),
  accountSecurity: (p: { change: string; when: string }) => ({ subject: `Security change on your Speed account`, ...layout({ heading: "Your account was changed", intro: p.change, lines: [`Time: ${p.when}`], foot: "If you didn't make this change, reset your password and contact support." }) }),
  system: (p: { title: string; body: string }) => ({ subject: `Speed: ${p.title}`, ...layout({ heading: p.title, intro: p.body, foot: "You're receiving this because you have a Speed account." }) }),
  billing: (p: { title: string; body: string; lines?: string[] }) => ({ subject: `Speed billing: ${p.title}`, ...layout({ heading: p.title, intro: p.body, lines: p.lines, foot: "This is a billing notice for your Speed account." }) }),
  invitation: (p: { inviter: string; target: string; url: string }) => ({ subject: `${p.inviter} invited you to ${p.target} on Speed`, ...layout({ heading: "You're invited", intro: `${p.inviter} invited you to join ${p.target} on Speed.`, button: { label: "Accept invitation", url: p.url } }) }),
  usage: (p: { title: string; body: string }) => ({ subject: `Speed usage: ${p.title}`, ...layout({ heading: p.title, intro: p.body, foot: "This is a usage notice for your Speed account." }) }),
};

export type TemplateName = keyof typeof templates;
