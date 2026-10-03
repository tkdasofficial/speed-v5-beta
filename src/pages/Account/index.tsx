import { PageShell } from "@/components/PageShell";
import "@/style/Account/index.css";


export function AccountPage() {
  return <PageShell title="Account"><div className="account-card"><span className="account-avatar">TK</span><b>TK Das</b></div><p className="account-note">Account details are not connected in this preview.</p></PageShell>;
}