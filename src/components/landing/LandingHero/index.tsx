import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Paperclip } from "lucide-react";
import { useState } from "react";

const ideas = ["Expense tracker", "eSports site", "AI chatbot", "Booking app"];

export function LandingHero() {
  const [text, setText] = useState("");
  const navigate = useNavigate();
  const go = () => navigate({ to: "/auth/signup" });

  return (
    <header className="lp-hero">
      <div className="lp-hero-glow" aria-hidden />
      <h1 className="lp-title">
        Build apps at the speed{" "}

        <span className="lp-accent">of a conversation.</span>
      </h1>
      <p className="lp-sub">
        Describe your idea. Speed Agent plans, builds, tests and ships it — all from one chat.
      </p>

      <form
        className="lp-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask Speed Agent to build a habit tracker…"
          rows={2}
          aria-label="Describe your app"
        />
        <div className="lp-prompt-bar">
          <span className="lp-prompt-tool"><Paperclip /></span>
          <button type="submit" className="lp-prompt-send" aria-label="Start building">
            <ArrowUp />
          </button>
        </div>
      </form>

      <div className="lp-ideas">
        {ideas.map((i) => (
          <button key={i} type="button" onClick={() => setText(`Build me an ${i.toLowerCase()}`)}>
            {i}
          </button>
        ))}
      </div>
    </header>
  );
}
