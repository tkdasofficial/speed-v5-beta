import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DEPTHS, MODELS, blocksFor, useAiMode, type AiMode } from "@/lib/ai-mode";

/** 3×3 power meter: fills bottom row → middle → top, left → right within each row. */
export function Points({ filled, size = "sm" }: { filled: number; size?: "sm" | "lg" }) {
  const cell = size === "lg" ? "h-2 w-2 rounded-[2px]" : "h-[5px] w-[5px] rounded-[1px]";
  const gap = size === "lg" ? "gap-[3px]" : "gap-[2px]";
  const rows = [2, 1, 0]; // top, middle, bottom (rendered top-down)
  return (
    <span className={`grid shrink-0 ${gap}`} aria-hidden="true">
      {rows.map((r) => (
        <span key={r} className={`grid grid-cols-3 ${gap}`}>
          {[0, 1, 2].map((c) => (
            <span key={c} className={`${cell} ${r * 3 + c < filled ? "bg-success" : "bg-muted-foreground/25"}`} />
          ))}
        </span>
      ))}
    </span>
  );
}

/** Model button + bottom sheet. Only logical modes are shown; real models are chosen by the backend. */
export function ModelSelector() {
  const [mode, setMode] = useAiMode();
  const [open, setOpen] = useState(false);
  const model = MODELS.find((m) => m.id === mode.model) ?? MODELS[0];
  const depth = DEPTHS.find((d) => d.id === mode.depth) ?? DEPTHS[1];
  if (!model || !depth) return null;
  const pick = (m: AiMode) => {
    setMode(m);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Model: ${model.label}, ${depth.label}`}
        className="h-8 max-w-[148px] gap-2 border-border bg-transparent px-2.5 text-[13px] shadow-none hover:border-muted-foreground/45 hover:bg-accent"
      >
        <Points filled={blocksFor(model.id, mode)} />
        <span className="truncate text-foreground">{model.label}</span>
        <ChevronDown className="!h-3 !w-3 opacity-40" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto max-w-lg rounded-t-[16px] border-border bg-card px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 shadow-[0_-24px_60px_color-mix(in_oklab,var(--background)_80%,transparent)]"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-[17px] font-semibold">Choose a model</SheetTitle>
            <SheetDescription className="flex items-center gap-3 text-[13px]">
              <Points filled={blocksFor(model.id, mode)} size="lg" />
              <span>
                <strong className="font-semibold text-foreground">{model.label}</strong> ·{" "}
                {depth.label}
              </span>
            </SheetDescription>
          </SheetHeader>
          <div className="mt-5 grid gap-2" role="radiogroup" aria-label="Model level">
            {MODELS.map((m) => {
              const on = m.id === mode.model;
              return (
                <Button
                  key={m.id}
                  type="button"
                  variant="outline"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick({ model: m.id, depth: mode.depth })}
                  className={`h-auto w-full justify-start gap-3 rounded-[8px] px-3.5 py-3 text-left shadow-none ${on ? "border-success bg-success/5 hover:bg-success/10" : "border-border bg-transparent hover:bg-accent"}`}
                >
                  <Points filled={blocksFor(m.id, mode)} size="lg" />
                  <span className="min-w-0 flex-1">
                    <b className="block text-[14px] font-semibold">{m.label}</b>
                    <small className="block whitespace-normal text-[12px] font-normal leading-5 text-muted-foreground">
                      {m.hint}
                    </small>
                  </span>
                  {on && (
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success text-background">
                      <Check className="!h-3.5 !w-3.5" />
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
          <p className="mb-2 mt-5 text-[11px] font-bold uppercase tracking-normal text-muted-foreground">
            Build depth
          </p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Build depth">
            {DEPTHS.map((d) => {
              const on = d.id === mode.depth;
              return (
                <Button
                  key={d.id}
                  type="button"
                  variant="outline"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick({ model: mode.model, depth: d.id })}
                  className={`grid h-auto justify-items-center gap-2 rounded-[8px] py-3 text-[13px] font-medium shadow-none ${on ? "border-success bg-success/5 text-foreground hover:bg-success/10" : "border-border bg-transparent text-muted-foreground hover:bg-accent"}`}
                >
                  <span className="flex gap-1">
                    {[0, 1, 2].map((j) => (
                      <span
                        key={j}
                        className={`h-2 w-2 rounded-[2px] ${j < d.dots ? "bg-success" : "bg-muted-foreground/20"}`}
                      />
                    ))}
                  </span>
                  {d.label}
                </Button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
