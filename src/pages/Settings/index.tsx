import { Link } from "@tanstack/react-router";
import { ChevronRight, FileText, UserRound, Wrench } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import "@/style/Settings/index.css";


export function SettingsPage() {
  return <PageShell title="Settings"><nav className="settings-list" aria-label="Settings">
    <Link className="settings-link" to="/account"><UserRound /> Account <ChevronRight /></Link>
    <Link className="settings-link" to="/agent-tools"><Wrench /> Agent tools <ChevronRight /></Link>
    <Link className="settings-link" to="/terms-service"><FileText /> Terms of Service <ChevronRight /></Link>
    <Link className="settings-link" to="/privacy-policy"><FileText /> Privacy Policy <ChevronRight /></Link>
  </nav></PageShell>;
}