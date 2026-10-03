import { useLayoutEffect, useRef, useState } from "react";

/** Shows the project's original prompt exactly as submitted: 3-line CSS clamp, "Show more" only when it actually overflows. */
export function PromptCard({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1); };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [prompt, open]);

  return (
    <section aria-label="Original prompt" className="min-w-0 rounded-[12px] border border-border bg-card px-3.5 py-3">
      <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Prompt</p>
      <p ref={ref} data-testid="prompt-text" className={`whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-foreground [overflow-wrap:anywhere] ${open ? "" : "line-clamp-3"}`}>{prompt}</p>
      {(overflows || open) && (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mt-1.5 text-[13px] font-semibold text-primary">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </section>
  );
}
