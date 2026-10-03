import { Link } from "@tanstack/react-router";
import { AppIcon } from "@/components/AppIcon";

export function LandingFooter() {
  return (
    <footer className="lp-footer">
      <div className="lp-footer-inner">
        <span className="lp-brand"><AppIcon /><span>SPEED</span></span>
        <nav className="lp-footer-links">
          <Link to="/terms-service">Terms of Service</Link>
          <Link to="/privacy-policy">Privacy Policy</Link>
          <Link to="/faq">FAQ</Link>
        </nav>
        <span className="lp-footer-copy">© 2026 Speed Agent</span>
      </div>
    </footer>
  );
}
