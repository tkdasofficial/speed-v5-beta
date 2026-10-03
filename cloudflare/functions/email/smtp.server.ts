import { envStr } from "../context";
// Minimal SMTP client (implicit TLS, port 465) over node:tls. Server-only.
// Credentials come from SMTP_EMAIL / SMTP_PASSWORD and are never logged.
import { connect } from "node:tls";

export type Mail = { to: string; subject: string; html: string; text: string };

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const encWord = (s: string) => `=?UTF-8?B?${b64(s)}?=`;

function wrap76(s: string) {
  return s.replace(/.{1,76}/g, "$&\r\n");
}

export async function smtpSend(mail: Mail) {
  const user = envStr("SMTP_EMAIL");
  const pass = envStr("SMTP_PASSWORD");
  if (!user || !pass) throw new Error("Email is not configured");
  if (/[\r\n]/.test(mail.to) || /[\r\n]/.test(mail.subject)) throw new Error("Invalid header");

  const sock = connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com" });
  sock.setEncoding("utf8");
  let buf = "";
  const waiters: ((line: string) => void)[] = [];
  const done: string[] = [];
  sock.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^\d{3} /.test(line)) { const w = waiters.shift(); if (w) w(line); else done.push(line); }
    }
  });
  const failed = new Promise<never>((_, rej) => {
    sock.on("error", () => rej(new Error("Email server connection failed")));
    setTimeout(() => rej(new Error("Email server timed out")), 20000);
  });
  const reply = () => Promise.race([failed, new Promise<string>((r) => { const l = done.shift(); if (l) r(l); else waiters.push(r); })]);
  const expect = async (code: string, step: string) => {
    const l = await reply();
    if (!l.startsWith(code)) throw new Error(`Email server rejected ${step} (${l.slice(0, 3)})`);
  };
  const cmd = async (line: string, code: string, step: string) => { sock.write(line + "\r\n"); await expect(code, step); };

  try {
    await expect("220", "greeting");
    await cmd("EHLO speed", "250", "EHLO");
    await cmd("AUTH LOGIN", "334", "auth");
    await cmd(btoa(user), "334", "auth");
    await cmd(btoa(pass), "235", "auth");
    await cmd(`MAIL FROM:<${user}>`, "250", "sender");
    await cmd(`RCPT TO:<${mail.to}>`, "250", "recipient");
    await cmd("DATA", "354", "data");
    const boundary = "b" + crypto.randomUUID().replace(/-/g, "");
    const msg = [
      `From: ${encWord("Speed")} <${user}>`,
      `To: <${mail.to}>`,
      `Subject: ${encWord(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@speed>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(b64(mail.text)),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(b64(mail.html)),
      `--${boundary}--`,
      ".",
    ].join("\r\n");
    await cmd(msg, "250", "message");
    sock.write("QUIT\r\n");
  } finally {
    sock.end();
  }
}
