import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

export function EmptyPage({ title, description }: { title: string; description: string }) {
  return (
    <main className="empty-page">
      <Link to="/dashboard"><ArrowLeft size={15} /> Back to Speed</Link>
      <div><h1>{title}</h1><p>{description}</p></div>
      <div className="empty-box">Coming soon</div>
    </main>
  );
}
