// Deterministic, AI-free extraction of explicit project / app / website names from a prompt. Never modifies the prompt.
export type ProjectMetadata = { projectName: string | null; appName: string | null; websiteName: string | null };

const Q = `["“”'‘’]`;
const QUOTED = `${Q}([^"“”'‘’\\n]{1,60})${Q}`;
const WORD = `([A-Za-z0-9][\\w.&-]{0,59})`;
const LINE = `([^\\n.,;!?]{1,60})`;
const STOP = new Set(["a", "an", "the", "for", "that", "which", "with", "and", "to", "of", "is", "it", "this", "my", "our"]);

const clean = (s: string | undefined) => {
  const v = (s ?? "").trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").replace(/[.,;:!?]+$/, "").trim();
  return v && !STOP.has(v.toLowerCase()) ? v.slice(0, 60) : null;
};

/** Patterns for one noun, in priority order: "X Name: v", "X named v", "X called v", "this X is called v", "the X name is v", "X: v". */
function patterns(noun: string, colonAlone: boolean): RegExp[] {
  const n = `(?:${noun})`;
  const val = (u: string) => `(?:${QUOTED}|${u})`;
  const list = [
    new RegExp(`\\b${n}\\s+name\\s*[:=]\\s*${val(LINE)}`, "i"),
    new RegExp(`\\b${n}\\s+named\\s+${val(WORD)}`, "i"),
    new RegExp(`\\b${n}\\s+called\\s+${val(WORD)}`, "i"),
    new RegExp(`\\b${n}\\s+is\\s+(?:called|named)\\s+${val(WORD)}`, "i"),
    new RegExp(`\\b${n}(?:'s)?\\s+name\\s+is\\s+${val(WORD)}`, "i"),
  ];
  if (colonAlone) list.push(new RegExp(`(?:^|\\n)\\s*${n}\\s*:\\s*${val(LINE)}`, "i"));
  return list;
}

function first(prompt: string, res: RegExp[]): string | null {
  for (const re of res) {
    const m = re.exec(prompt);
    const v = m && clean(m[1] ?? m[2]);
    if (v) return v;
  }
  return null;
}

export function extractProjectMetadata(prompt: string): ProjectMetadata {
  try {
    const project = first(prompt, patterns("project", true));
    const appName = first(prompt, patterns("app|application", false));
    const websiteName = first(prompt, patterns("website|site|landing page", false));
    return { projectName: project ?? appName ?? websiteName, appName, websiteName };
  } catch {
    return { projectName: null, appName: null, websiteName: null };
  }
}
