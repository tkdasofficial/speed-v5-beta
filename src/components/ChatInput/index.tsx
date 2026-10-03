import { ArrowUp, Check, Mic, Plus, Square } from "lucide-react";
import { ModelSelector } from "@/components/ModelSelector";
import { useAiMode } from "@/lib/ai-mode";
import { useEffect, useRef, useState } from "react";


/**
 * The single chat input box used by both the dashboard and the workspace.
 * Controlled when `value`/`onChange` are given, self-managed otherwise.
 */
export function ChatInput({ onSend, busy, onStop, value, onChange, placeholder = "Make, test, iterate..." }: { onSend: (text: string) => void; busy: boolean; onStop: () => void; value?: string; onChange?: (v: string) => void; placeholder?: string }) {
  const [inner, setInner] = useState("");
  const text = value ?? inner;
  const setText = (v: string) => { if (onChange) onChange(v); else setInner(v); };
  const [mode, setMode] = useAiMode();
  const plan = !!mode.plan;
  const setPlan = (v: boolean) => setMode({ plan: v });
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
    ref.current?.focus();
  };
  const canSend = !!text.trim() && !busy;

  return (
    <div className="rounded-[18px] border border-border bg-card p-3 shadow-[0_24px_60px_-36px_var(--primary)] transition focus-within:border-primary/60">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 768px)").matches) { e.preventDefault(); send(); } }}
        placeholder={placeholder}
        aria-label="Message the agent"
        className="block max-h-40 w-full resize-none bg-transparent px-1 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
      />
      <div className="mt-2 flex min-w-0 items-center gap-1.5">
        <button type="button" aria-label="Add attachment" className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"><Plus className="!h-4 !w-4" /></button>
        <button type="button" onClick={() => setPlan(!plan)} aria-pressed={plan} title={plan ? "Plan mode on: the AI only plans, no file changes" : "Plan mode off"} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border px-2 text-[13px] font-medium ${plan ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}>
          <span className={`grid h-4 w-4 place-items-center rounded-[3px] border ${plan ? "border-primary bg-primary" : "border-muted-foreground"}`}>{plan && <Check className="!h-3 !w-3" />}</span>
          Plan
        </button>
        <ModelSelector />
        <button type="button" onClick={() => setListening(!listening)} aria-pressed={listening} aria-label="Voice input" className={`ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-[6px] ${listening ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}><Mic className="!h-4 !w-4" /></button>
        {busy ? (
          <button type="button" onClick={onStop} aria-label="Stop agent" className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] border border-border text-foreground"><Square className="!h-3.5 !w-3.5" /></button>
        ) : (
          <button type="button" onClick={send} disabled={!canSend} aria-label="Send" className={`grid h-8 w-8 shrink-0 place-items-center rounded-[6px] ${canSend ? "bg-cta text-cta-foreground" : "bg-accent text-muted-foreground/50"}`}><ArrowUp className="!h-4 !w-4" /></button>
        )}
      </div>
    </div>
  );
}
