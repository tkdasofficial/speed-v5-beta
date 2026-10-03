const steps = [
  { n: "01", t: "Describe it", d: "Tell the agent what you want in plain words." },
  { n: "02", t: "Watch it build", d: "Plans, code and fixes appear live in the chat." },
  { n: "03", t: "Ship it", d: "Preview, tweak and publish when it feels right." },
];

export function LandingSteps() {
  return (
    <section className="lp-section" id="how">
      <div className="lp-section-head">
        <span className="lp-eyebrow">How it works</span>
        <h2>Idea to app in three steps</h2>
      </div>
      <ol className="lp-steps">
        {steps.map((s) => (
          <li key={s.n}>
            <span>{s.n}</span>
            <h3>{s.t}</h3>
            <p>{s.d}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
