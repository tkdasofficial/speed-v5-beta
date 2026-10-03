export const projectSlug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const known: string[] = [];

export const projectName = (id: string) => known.find((n) => projectSlug(n) === id) ?? id;
