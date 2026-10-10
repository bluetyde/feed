// docs/licences (F0 exit review, finding 9): the saved licence texts are the ones recorded, the inventory names the pins and every saved
// file, FEED's own licence fields are MIT, and the licences of the npm packages FEED runs on are the ones the inventory states.
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const dir = join(root, "docs", "licences");
const tp = join(dir, "third-party");
const read = (p: string) => readFileSync(p, "utf8");
const readme = read(join(dir, "README.md"));
const pins = Object.fromEntries(
  read(join(root, "solver", "pins.env"))
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

describe("the saved licence texts", () => {
  const sums = read(join(tp, "SHA256SUMS"))
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{64})  (\S+)$/.exec(l);
      if (!m) throw new Error("bad SHA256SUMS line: " + l);
      return { hash: m[1]!, file: m[2]! };
    });
  const texts = readdirSync(tp).filter((f) => f !== "SHA256SUMS");

  it("SHA256SUMS lists exactly the files in third-party/, and each hash matches its file", () => {
    expect(sums.map((s) => s.file).sort()).toEqual([...texts].sort());
    for (const s of sums) expect({ file: s.file, hash: createHash("sha256").update(readFileSync(join(tp, s.file))).digest("hex") }).toEqual({ file: s.file, hash: s.hash });
  });

  it("each file is the licence it is named for", () => {
    const has = (f: string, ...needles: string[]) => {
      const t = read(join(tp, f));
      for (const n of needles) expect(t, `${f} should contain ${n}`).toContain(n);
    };
    has("OFFBEAT-LICENSE.txt", "GNU GENERAL PUBLIC LICENSE", "Version 3, 29 June 2007");
    has("SCIANTIX-LICENSE.txt", "MIT License", "Pizzocri", "Politecnico di Milano");
    has("OpenFOAM-9-COPYING.txt", "GNU GENERAL PUBLIC LICENSE", "OpenFOAM Foundation");
    has("openfoam9-debian-copyright.txt", "OpenFOAM Foundation", "either version 3 of the License", "CeCILL-C_V1", "README_scotch");
    has("openfoam9-gzstream-COPYING.LIB.txt", "GNU LESSER GENERAL PUBLIC LICENSE", "Version 2.1");
  });

  it("the files have LF line endings, so the recorded hashes do not depend on the checkout", () => {
    for (const f of texts) expect(read(join(tp, f)).includes("\r"), f).toBe(false);
  });

  it("the collect script copies exactly these files and checks the pins before it does", () => {
    const s = read(join(root, "solver", "collect-licences.sh"));
    for (const f of texts) expect(s, f).toContain(f);
    expect(s).toContain('. "$HERE/pins.env"');
    expect(s.indexOf("PIN MISMATCH")).toBeGreaterThan(-1);
    expect(s.indexOf("PIN MISMATCH")).toBeLessThan(s.indexOf('cp "$OFF/LICENSE"'));
  });
});

describe("the inventory (docs/licences/README.md)", () => {
  it("names the pinned OFFBEAT commit, the OpenFOAM package and version, and the Ubuntu base", () => {
    expect(readme).toContain(pins.OFFBEAT_COMMIT!);
    expect(readme).toContain(pins.OPENFOAM_VERSION!);
    expect(readme).toContain("openfoam9");
    expect(readme).toContain("Ubuntu 22.04");
  });

  it("links to every saved text, and every relative link in it points at a file that exists", () => {
    for (const f of readdirSync(tp).filter((x) => x !== "SHA256SUMS")) expect(readme, f).toContain("third-party/" + f);
    for (const m of readme.matchAll(/\]\(([^)#]+)\)/g)) {
      const target = m[1]!;
      if (/^https?:/.test(target)) continue;
      expect(existsSync(join(dir, target)), target).toBe(true);
    }
  });

  it("states each licence in the inventory that matters for distribution, including the two that are missing", () => {
    for (const needle of ["GNU GPL, version 3 or later", "SCIANTIX", "MIT", "CeCILL-C", "LGPL", "CoolProp", "Ian H. Bell", "Canonical", "776"]) expect(readme, needle).toContain(needle);
    expect(readme).toMatch(/\*\*missing\*\*/);
    expect(readme).toMatch(/Not legal advice/);
  });
});

describe("FEED's own licence and its npm packages", () => {
  const pkg = JSON.parse(read(join(root, "package.json")));

  it("FEED is MIT: the LICENSE file and the package.json field agree, with the holder named", () => {
    expect(pkg.license).toBe("MIT");
    const l = read(join(root, "LICENSE"));
    expect(l).toMatch(/^MIT License/);
    expect(l).toContain("bluetyde");
  });

  /** package.json of an installed package, found the way node resolves it. */
  const find = (name: string, from: string): { file: string; json: any } | undefined => {
    for (let d = from; ; d = dirname(d)) {
      const p = join(d, "node_modules", name, "package.json");
      if (existsSync(p)) return { file: p, json: JSON.parse(read(p)) };
      if (dirname(d) === d) return undefined;
    }
  };
  const closure = (): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (name: string, from: string) => {
      const r = find(name, from);
      expect(r, "installed package " + name).toBeDefined();
      if (!r || out.has(r.json.name)) return;
      out.set(r.json.name, String(r.json.license));
      for (const d of Object.keys(r.json.dependencies ?? {})) walk(d, dirname(r.file));
    };
    for (const d of Object.keys(pkg.dependencies ?? {})) walk(d, root);
    return out;
  };

  it("every package FEED runs on (production closure) is MIT or BSD-3-Clause, as the inventory says, and is named in it", () => {
    const c = closure();
    expect(c.size).toBeGreaterThanOrEqual(5);
    for (const [name, licence] of c) {
      expect(["MIT", "BSD-3-Clause"], `${name}: ${licence}`).toContain(licence);
      expect(readme, name).toContain(name);
    }
    expect(c.get("fast-uri")).toBe("BSD-3-Clause");
  });

  it("the build and test tools are the licences the inventory states, and none of FEED's packages is GPL or AGPL", () => {
    const dev = Object.fromEntries(Object.keys(pkg.devDependencies ?? {}).map((n) => [n, String(find(n, root)?.json.license)]));
    expect(dev["typescript"]).toBe("Apache-2.0");
    expect(dev["vitest"]).toBe("MIT");
    expect(dev["@types/node"]).toBe("MIT");
    for (const l of [...closure().values(), ...Object.values(dev)]) expect(l).not.toMatch(/GPL/);
  });
});

describe("THIRD_PARTY_NOTICES.md", () => {
  const notices = read(join(root, "THIRD_PARTY_NOTICES.md"));
  const pkg = JSON.parse(read(join(root, "package.json")));
  const lock = JSON.parse(read(join(root, "package-lock.json"))).packages as Record<string, { version: string; license?: string; dev?: boolean; optional?: boolean }>;

  it("names FEED's licence holder, the pinned OFFBEAT commit and the OpenFOAM package and version", () => {
    expect(notices).toContain("Copyright (c) 2026 bluetyde");
    expect(notices).toContain(pins.OFFBEAT_COMMIT!);
    expect(notices).toContain(pins.OPENFOAM_PACKAGE!);
    expect(notices).toContain(pins.OPENFOAM_VERSION!);
  });

  it("lists every package FEED depends on, and every package that runs, with the version and the licence of the lock file", () => {
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    for (const [path, v] of Object.entries(lock)) if (path && !v.dev && !v.optional) names.add(path.split("node_modules/").pop()!);
    expect(names.size).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const v = lock["node_modules/" + name]!;
      expect(notices, name).toContain(`| ${name} | ${v.version} | ${v.license}`);
    }
  });

  it("names every saved licence text by file name, and every relative link in it points at a file that exists", () => {
    for (const f of readdirSync(tp).filter((x) => x !== "SHA256SUMS")) expect(notices, f).toContain(f);
    for (const m of notices.matchAll(/\]\(([^)#]+)\)/g)) {
      const target = m[1]!;
      if (/^https?:/.test(target)) continue;
      expect(existsSync(join(root, target)), target).toBe(true);
    }
  });

  it("says the solver is installed separately and not bundled, and what distributing it would carry", () => {
    for (const needle of ["never bundled", "GNU GPL, version 3 or later", "CeCILL-C", "corresponding source"]) expect(notices, needle).toContain(needle);
  });
});
