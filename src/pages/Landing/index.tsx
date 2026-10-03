import { useRedirectIfSignedIn } from "@/lib/session-redirect";
import "@/style/landing/index.css";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingHero } from "@/components/landing/LandingHero";
import { DashboardPreview } from "@/components/landing/DashboardPreview";
import { LandingFeatures } from "@/components/landing/LandingFeatures";
import { LandingSteps } from "@/components/landing/LandingSteps";
import { LandingCta } from "@/components/landing/LandingCta";
import { LandingFooter } from "@/components/landing/LandingFooter";

export function Landing() {
  useRedirectIfSignedIn();
  return (
    <div className="lp-page">
      <LandingNav />
      <main>
        <LandingHero />
        <DashboardPreview />
        <LandingFeatures />
        <LandingSteps />
        <LandingCta />
      </main>
      <LandingFooter />
    </div>
  );
}
