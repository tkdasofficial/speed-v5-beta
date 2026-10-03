import { AppIcon } from "@/components/AppIcon";

export function BrandLogo({ variant = "auto", className = "" }: { variant?: "auto" | "dark" | "light"; className?: string }) {
  return <AppIcon variant={variant} className={className} />;
}