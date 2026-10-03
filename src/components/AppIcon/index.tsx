const darkLogo = "/images/speed-dark.svg";
const lightLogo = "/images/speed-light.svg";

type AppIconProps = {
  variant?: "auto" | "dark" | "light";
  className?: string;
};

export function AppIcon({ variant = "auto", className = "" }: AppIconProps) {
  return (
    <span className={`app-icon app-icon-${variant} ${className}`} role="img" aria-label="Speed">
      <img className="app-icon-dark" src={darkLogo} alt="" aria-hidden="true" />
      <img className="app-icon-light" src={lightLogo} alt="" aria-hidden="true" />
    </span>
  );
}
