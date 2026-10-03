// Shared request schemas. Server functions always parse input with these.
import { z } from "zod";

export const id = z.string().min(1).max(64);
export const projectCreate = z.object({ name: z.string().trim().min(1).max(80) });
export const projectUpdate = z.object({
  id,
  name: z.string().trim().min(1).max(80).optional(),
  settings: z.record(z.string(), z.union([z.string().max(200), z.boolean(), z.number()])).optional(),
});
export const messageCreate = z.object({ projectId: id, content: z.string().trim().min(1).max(10000), model: z.enum(["speed", "flash", "heavy"]).default("speed"), depth: z.enum(["quick", "balanced", "deep"]).default("balanced"), plan: z.boolean().default(false) });
export const agentStep = z.object({
  projectId: id, prompt: z.string().trim().min(1).max(10000).optional(), round: z.number().int().min(0).max(20),
  model: z.enum(["speed", "flash", "heavy"]).default("speed"), depth: z.enum(["quick", "balanced", "deep"]).default("balanced"), plan: z.boolean().default(false),
  files: z.array(z.string().max(400)).max(500).default([]),
  results: z.string().max(60000).default(""),
});
export const taskCreate = z.object({ projectId: id, title: z.string().trim().min(1).max(200), description: z.string().max(2000).default("") });
export const taskUpdate = z.object({
  id,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(["draft", "ready", "active", "done"]).optional(),
});
export const profileUpdate = z.object({ displayName: z.string().trim().min(1).max(100).optional(), avatarUrl: z.string().url().max(500).nullable().optional() });
export const stateSet = z.object({ key: z.string().regex(/^[a-z0-9:_-]{1,80}$/), value: z.unknown() });
export const since = z.object({ seq: z.number().int().min(0) });
