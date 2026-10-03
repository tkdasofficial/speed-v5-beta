import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

export function LandingCta() {
  return (
    <section className="lp-cta">
      <h2>Ready to build something?</h2>
      <p>Start free. No credit card needed.</p>
      <Link to="/auth/signup" className="lp-btn lp-btn-light lp-btn-lg">
        Start building <ArrowRight />
      </Link>
    </section>
  );
}
