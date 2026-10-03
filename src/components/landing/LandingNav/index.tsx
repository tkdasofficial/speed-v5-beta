import { Link } from "@tanstack/react-router";
import { AppIcon } from "@/components/AppIcon";

export function LandingNav() {
  return (
    <nav className="lp-nav">
      <div className="lp-nav-inner">
        <Link to="/" className="lp-brand" aria-label="Speed home">
          <AppIcon />
          <span>SPEED</span>
        </Link>
        <div className="lp-nav-links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <Link to="/faq">FAQ</Link>
        </div>
        <div className="lp-nav-actions">
          <Link to="/auth/login" className="lp-btn lp-btn-ghost">Log in</Link>
          <Link to="/auth/signup" className="lp-btn lp-btn-light">Get started</Link>
        </div>
      </div>
    </nav>
  );
}
