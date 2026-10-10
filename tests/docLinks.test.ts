// Release hygiene: every relative link in the repo's markdown resolves to a file inside the repository (no link to a sibling project, a workspace folder or a local path),
// and no document names a local folder or a user. A reader of a clone must be able to follow every link.
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
function markdown(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", "runs"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) markdown(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}
const files = markdown(root);

describe("the markdown of the repository", () => {
  it("finds the documents", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.map((f) => relative(root, f))).toContain("README.md");
  });
  it("every relative link resolves to a file or folder inside the repository", () => {
    const broken: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!.split("#")[0]!;
        if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const full = resolve(dirname(f), decodeURIComponent(target));
        if (relative(root, full).startsWith("..") || !existsSync(full)) broken.push(relative(root, f) + " -> " + m[1]);
      }
    }
    expect(broken).toEqual([]);
  });
  it("no document names a local user folder or the workspace's own folders", () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const needle of ["jwncr", "Claude Code Test", "C:\Users", "../messages", "../../plans", "../experiment-studio", "../../OpenMC"]) if (text.includes(needle)) hits.push(relative(root, f) + ": " + needle);
    }
    expect(hits).toEqual([]);
  });
});
