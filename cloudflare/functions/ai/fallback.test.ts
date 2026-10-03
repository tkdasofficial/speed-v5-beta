import { describe, it, expect, vi } from "vitest";
vi.mock("../context", () => ({ envStr: () => "test-key" }));
import { runAgent } from "./orchestrator.server";

function sse(text: string) {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("server-side model fallback", () => {
  it.each([
    ["flash", ["openai/gpt-oss-20b", "nvidia/nemotron-3-super-120b-a12b", "gemini-3.5-flash-lite"]],
    ["speed", ["nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-20b", "gemini-3.5-flash-lite"]],
    ["heavy", ["openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b", "gemini-3.5-flash-lite"]],
  ] as const)("%s falls through its chain on 429/5xx", async (model, ids) => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (b.model.includes("safety")) return sse("safe");
      seen.push(b.model);
      expect(b.max_tokens).toBe(12000);
      if (seen.length === 1) return new Response("rate", { status: 429 });
      if (seen.length === 2) return new Response("down", { status: 503 });
      return sse("hello");
    }));
    await runAgent({ model, depth: "balanced", history: [{ role: "user", content: "hi" }], projectName: "p" });
    expect(seen).toEqual(ids);
  });

  it("fails clearly when every model fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    await expect(runAgent({ model: "flash", depth: "quick", history: [{ role: "user", content: "hi" }], projectName: "p" })).rejects.toThrow(/unavailable/);
  });
});
