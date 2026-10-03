import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Global app header — sized from the workspace header: 48px tall, 40px side columns, 36px buttons. */
export function Header({ left, title, onTitleClick, titleExpanded, center, right, align = "center" }: {
  align?: "center" | "start";
  left?: ReactNode;
  title?: ReactNode;
  onTitleClick?: () => void;
  titleExpanded?: boolean;
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="w-full shrink-0 border-b border-border bg-background pt-[env(safe-area-inset-top)]">
      <div className="grid h-12 grid-cols-[minmax(40px,auto)_minmax(0,1fr)_minmax(40px,auto)] items-center gap-1 px-2">
        <div className="flex items-center">{left}</div>
        <div className={`flex min-w-0 ${align === "start" ? "justify-start" : "justify-center"}`}>
          {center ?? (onTitleClick ? (
            <Button type="button" variant="ghost" onClick={onTitleClick} aria-expanded={titleExpanded} className="flex h-9 min-w-0 max-w-full items-center gap-1 rounded-[6px] px-2">
              <span className="truncate text-[15px] font-semibold">{title}</span><ChevronDown className="!h-4 !w-4 shrink-0 text-muted-foreground" />
            </Button>
          ) : (
            <span className="truncate px-2 text-[15px] font-semibold">{title}</span>
          ))}
        </div>
        <div className="flex items-center justify-end">{right}</div>
      </div>
    </header>
  );
}

/** Standard 36px icon button for header slots. */
export function HeaderIcon({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} onClick={onClick} className="h-9 w-9 rounded-[6px] [&_svg]:!h-[18px] [&_svg]:!w-[18px]">
      {children}
    </Button>
  );
}
