import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PromptCard } from "@/components/workspace/PromptCard";

const mockHeights = (scroll: number, client: number) => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
};

describe("PromptCard", () => {
  it("short prompt: full text, no Show more", () => {
    mockHeights(40, 40);
    render(<PromptCard prompt="Build a site." />);
    expect(screen.getByTestId("prompt-text").textContent).toBe("Build a site.");
    expect(screen.queryByText("Show more")).toBeNull();
  });
  it("long prompt: clamped, toggles Show more / Show less, text never changes", () => {
    mockHeights(200, 60);
    const long = "word ".repeat(120).trim();
    render(<PromptCard prompt={long} />);
    const p = screen.getByTestId("prompt-text");
    expect(p.className).toContain("line-clamp-3");
    fireEvent.click(screen.getByText("Show more"));
    expect(p.className).not.toContain("line-clamp-3");
    expect(p.textContent).toBe(long);
    fireEvent.click(screen.getByText("Show less"));
    expect(p.className).toContain("line-clamp-3");
    expect(screen.getByText("Show more")).toBeTruthy();
  });
});
