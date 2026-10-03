// Single source of truth for the user's AI mode (logical values only; real models live on the backend).
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@realtime/store";
import type { StateEntry } from "@realtime/events";
import { useAppState } from "@/lib/sync";
import { setState } from "@/lib/api/sync";

export type AiModel = "speed" | "flash" | "heavy";
export type AiDepth = "quick" | "balanced" | "deep";
export type AiMode = { model: AiModel; depth: AiDepth; plan?: boolean };

export const MODELS: { id: AiModel; label: string; hint: string }[] = [
  { id: "speed", label: "Speed", hint: "Fast answers for everyday tasks" },
  { id: "flash", label: "Flash", hint: "Stronger reasoning for most builds" },
  { id: "heavy", label: "Heavy", hint: "Maximum power for complex work" },
];
export const DEPTHS: { id: AiDepth; label: string; dots: number }[] = [
  { id: "quick", label: "Quick", dots: 1 },
  { id: "balanced", label: "Balanced", dots: 2 },
  { id: "deep", label: "Deep", dots: 3 },
];
const KEY = "ai-mode";
const DEFAULT: AiMode = { model: "speed", depth: "balanced", plan: false };

/** Filled dots (0–3) for each level given the selection: lower levels full, selected level = depth dots. */
export function levelDots({ model, depth }: AiMode): [number, number, number] {
  const lvl = MODELS.findIndex((m) => m.id === model);
  const d = DEPTHS.find((x) => x.id === depth)!.dots;
  return [0, 1, 2].map((i) => (i < lvl ? 3 : i === lvl ? d : 0)) as [number, number, number];
}

/** Overall level 1–9: model tier ×3 + depth. */
export function modeLevel({ model, depth }: AiMode): number {
  const lvl = Math.max(0, MODELS.findIndex((m) => m.id === model));
  const d = DEPTHS.find((x) => x.id === depth)?.dots ?? 2;
  return lvl * 3 + d;
}
/** Filled blocks (1–9) for a model's meter: capped at that model's tier ceiling (Speed 3, Flash 6, Heavy 9). */
export function blocksFor(model: AiModel, mode: AiMode): number {
  const cap = (MODELS.findIndex((m) => m.id === model) + 1) * 3;
  return Math.min(modeLevel(mode), cap);
}

export function useAiMode(): [AiMode, (m: Partial<AiMode>) => void] {
  const qc = useQueryClient();
  const raw = useAppState<Partial<AiMode>>(KEY, DEFAULT);
  const mode: AiMode = {
    model: MODELS.some((m) => m.id === raw.model) ? raw.model! : DEFAULT.model,
    depth: DEPTHS.some((d) => d.id === raw.depth) ? raw.depth! : DEFAULT.depth,
    plan: raw.plan === true,
  };
  const set = (patch: Partial<AiMode>) => {
    const m: AiMode = { ...mode, ...patch };
    // Reflect immediately; the server write is authoritative and syncs back via real-time.
    qc.setQueryData<StateEntry[]>(keys.state, (all = []) => {
      const cur = all.find((s) => s.key === KEY);
      return cur ? all.map((s) => (s.key === KEY ? { ...s, value: m } : s)) : [...all, { key: KEY, value: m, version: 0 }];
    });
    void setState({ data: { key: KEY, value: m } }).catch(() => undefined);
  };
  return [mode, set];
}
