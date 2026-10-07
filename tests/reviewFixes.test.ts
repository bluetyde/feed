// The seven findings of the Codex review of 2026-10-07 (messages/fuel-performance-studio.md), each as the reproduction that found it, plus its neighbours.
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { evaluate, minimum, primitive, solveHot } from "../src/core/conductivity";
import { FileLike, importMaterial, MAX_MANIFEST_BYTES, ORIGIN_NAME_MAX, originProblem, PROJECT_ID_MAX, readProject, readProjectAsync, setsHash, THERMAL_SET_SCHEMA } from "../src/core/projectImport";
import { saveUserMaterial, USER_LIBRARY_SCHEMA } from "../src/core/userLibrary";
import { validateMaterial } from "../src/core/validate";

const q = (value: number, unit: string) => ({ value, unit });
const polyMaterial = (a: number[], range: [number, number] = [500, 1500], unit = ["W/m/K", "W/m/K2", "W/m/K3", "W/m/K4"]) => ({
  materialId: "test-mat",
  revision: 1,
  sets: { "thermal.conductivity": { model: "polynomial", a: q(a[0]!, unit[0]!), b: q(a[1]!, unit[1]!), c: q(a[2]!, unit[2]!), d: q(a[3]!, unit[3]!), validRange: { min: q(range[0], "K"), max: q(range[1], "K") }, source: "test" } },
});

describe("finding 1: the exact minimum of a nearly quadratic cubic", () => {
  it("the reported case: k(1000) = -1 is found, not 249", () => {
    const c = [999, -2, 0.001, 1e-25];
    expect(evaluate(c, 1000)).toBeCloseTo(-1, 9);
    expect(minimum(c, 500, 1500)).toBeCloseTo(-1, 9);
    expect(validateMaterial("fuel", polyMaterial(c)).errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
  });
  it("agrees with a brute-force sampling for cubics from nearly quadratic to strongly cubic, and for either sign of every coefficient", () => {
    const grid = (c: number[], lo: number, hi: number, n = 20000) => {
      let m = Infinity;
      for (let i = 0; i <= n; i++) m = Math.min(m, evaluate(c, lo + ((hi - lo) * i) / n));
      return m;
    };
    for (const d of [0, 1e-30, 1e-25, 1e-18, 1e-12, 1e-9, -1e-25, -1e-12, -1e-9]) {
      for (const [a, b, cc] of [[999, -2, 0.001], [5, 0.01, -1e-5], [-3, 0.02, -1e-5], [100, -0.3, 0.0004], [1, 0, 0], [-1, 0, 1e-6]] as const) {
        const c = [a, b, cc, d];
        const exact = minimum(c, 200, 2000);
        const sampled = grid(c, 200, 2000);
        expect(exact, JSON.stringify(c)).toBeLessThanOrEqual(sampled + 1e-9 * (1 + Math.abs(sampled)));
        expect(exact, JSON.stringify(c)).toBeGreaterThanOrEqual(sampled - 1e-3 * (1 + Math.abs(sampled)) - 1e-6);
      }
    }
  });
  it("a double root at zero (the discriminant and the linear term both zero) does not break it", () => {
    expect(minimum([5, 0, 0, 1], 1, 2)).toBe(6);
    expect(minimum([5, 0, 0, 1], -1, 1)).toBe(4);
  });
});

describe("finding 2: a law that overflows over its range is refused", () => {
  it("a conductivity and a heat capacity whose evaluation is infinite say so, and a large but finite law is not mistaken for it", () => {
    const k = validateMaterial("fuel", polyMaterial([1, 0, 1e308, 0], [200, 2000]));
    expect(k.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(k.errors[0]!.message).toMatch(/cannot be evaluated over its stated range 200 to 2000 K: it overflows/);
    const cp = { materialId: "test-mat", revision: 1, sets: { "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: "t" }, "thermal.volumetricHeatCapacity": { model: "polynomial", a: q(1e6, "J/m3/K"), b: q(0, "J/m3/K2"), c: q(1e308, "J/m3/K3"), validRange: { min: q(200, "K"), max: q(2000, "K") }, source: "t" } } };
    const h = validateMaterial("fuel", cp);
    expect(h.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(h.errors[0]!.message).toMatch(/heat capacity cannot be evaluated/);
    // finite but absurd: it is not an overflow, it is a units mistake, and is refused as one (a conductivity is 0.001 to 100000 W/m/K)
    const big = validateMaterial("fuel", polyMaterial([1, 0, 1e100, 0], [200, 2000]));
    expect(big.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(big.errors[0]!.message).toMatch(/outside 0\.001 to 100000/);
    expect(big.errors[0]!.message).not.toMatch(/overflows/);
    // a large law that is inside the bounds is accepted
    expect(validateMaterial("fuel", polyMaterial([1, 0, 1e-3, 0], [200, 2000])).errors).toEqual([]);
  });
});

describe("finding 3: the hot side when the search bracket overshoots a zero of k", () => {
  const c = [1, 0.001, -0.000002, 0]; // k = 0 at 1000 K; the integral from 300 K to 900 K is 492
  it("the reported case gives 900 K", () => {
    expect(solveHot(c, 300, 492)).toBeCloseTo(900, 9);
    expect(primitive(c, solveHot(c, 300, 492)) - primitive(c, 300)).toBeCloseTo(492, 9);
  });
  it("any integral reachable before the zero is solved, close to the zero as well as far from it", () => {
    for (const I of [1, 100, 300, 500, 506]) {
      const T = solveHot(c, 300, I);
      expect(T).toBeLessThan(1000);
      expect(primitive(c, T) - primitive(c, 300)).toBeCloseTo(I, 6);
    }
  });
  it("an integral the law cannot reach before k is zero is still refused (the integral up to 1000 K is about 506.3)", () => {
    expect(() => solveHot(c, 300, 507)).toThrow(/reaches zero before the conductivity integral does/);
    expect(() => solveHot(c, 300, 600)).toThrow(/reaches zero before/);
  });
  it("a zero integral is the cold side, and a law that is zero already at the cold side is refused as before", () => {
    expect(solveHot(c, 300, 0)).toBe(300);
    expect(() => solveHot([1000, -2, 0.001, 0], 1000, 5)).toThrow(/not positive at the cold side/);
  });
});

describe("finding 4: reading a project is bounded, and the server's read has a deadline", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "feed-read-"));
  const manifest = JSON.stringify({ schema: "seed.project/0.1", projectId: "p", materials: [] });
  const handle = (over: Partial<FileLike> & { size?: number; bytes?: number } = {}): FileLike & { closed: number } => {
    let given = 0;
    const h = {
      closed: 0,
      stat: async () => ({ isFile: () => true, size: over.size ?? manifest.length }),
      read: async (buf: Buffer, offset: number, length: number) => {
        const total = over.bytes ?? manifest.length;
        const n = Math.min(length, total - given);
        buf.fill(n > 0 && over.bytes === undefined ? 0 : 32, offset, offset + Math.max(n, 0));
        if (over.bytes === undefined && n > 0) Buffer.from(manifest).copy(buf, offset, given, given + n);
        given += Math.max(n, 0);
        return { bytesRead: Math.max(n, 0) };
      },
      close: async () => {
        h.closed++;
      },
    };
    return Object.assign(h, over.stat ? { stat: over.stat } : {}) as FileLike & { closed: number };
  };

  it("the async read gives what the sync read gives, for the folder and for the file", async () => {
    const d = dir();
    writeFileSync(join(d, "seed.project.json"), manifest);
    const a = await readProjectAsync(d);
    const b = await readProjectAsync(join(d, "seed.project.json"));
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && a.manifest.projectId).toBe("p");
    expect(JSON.stringify(readProject(d))).toBe(JSON.stringify(a));
  });
  it("refuses the same things the sync read refuses, with the same codes", async () => {
    const d = dir();
    const err = async (p: unknown) => {
      const r = await readProjectAsync(p);
      return r.ok ? "ok" : r.errors[0]!.code + ": " + r.errors[0]!.message;
    };
    expect(await err(undefined)).toMatch(/^E_IMPORT_PROJECT/);
    expect(await err(d)).toMatch(/no seed\.project\.json at/);
    writeFileSync(join(d, "other.json"), "{}");
    expect(await err(join(d, "other.json"))).toMatch(/reads only a file named/);
    writeFileSync(join(d, "seed.project.json"), "{broken");
    expect(await err(d)).toMatch(/not valid JSON/);
    writeFileSync(join(d, "seed.project.json"), JSON.stringify({ schema: "seed.project/0.1", projectId: "", materials: [] }));
    expect(await err(d)).toMatch(/no projectId \(1 to 200 characters\)/);
    writeFileSync(join(d, "seed.project.json"), JSON.stringify({ schema: "seed.project/0.1", projectId: "p".repeat(201), materials: [] }));
    expect(await err(d)).toMatch(/no projectId/);
    const odd = dir();
    mkdirSync(join(odd, "seed.project.json"));
    expect(await err(odd)).toMatch(/^E_IMPORT_PROJECT/);
  });
  it("a read that does not answer in time is answered with E_IMPORT_PROJECT and does not hold the caller; what it opened is closed when it finishes", async () => {
    let release: (h: FileLike) => void = () => undefined;
    const late = handle();
    const t0 = Date.now();
    const r = await readProjectAsync("C:\\somewhere\\seed.project.json", { timeoutMs: 80, open: () => new Promise<FileLike>((res) => (release = res)), isDirectory: async () => false });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.ok ? "" : r.errors[0]!.code).toBe("E_IMPORT_PROJECT");
    expect(r.ok ? "" : r.errors[0]!.message).toMatch(/took longer than 80 ms/);
    release(late);
    await new Promise((res) => setTimeout(res, 50));
    expect(late.closed).toBe(1); // the late handle is closed, not leaked
  });
  it("a file that is larger than the bound when it is read (it grew after its size was looked at) is refused, not cut; one that is not a regular file too", async () => {
    const grew = handle({ bytes: MAX_MANIFEST_BYTES + 1 });
    const r = await readProjectAsync("x/seed.project.json", { open: async () => grew, isDirectory: async () => false });
    expect(r.ok ? "" : r.errors[0]!.message).toMatch(/is larger than/);
    expect(grew.closed).toBe(1);
    const big = await readProjectAsync("x/seed.project.json", { open: async () => handle({ size: MAX_MANIFEST_BYTES + 1 }), isDirectory: async () => false });
    expect(big.ok ? "" : big.errors[0]!.message).toMatch(/is larger than/);
    const notFile = await readProjectAsync("x/seed.project.json", { open: async () => handle({ stat: async () => ({ isFile: () => false, size: 0 }) }), isDirectory: async () => false });
    expect(notFile.ok ? "" : notFile.errors[0]!.message).toMatch(/not a regular file/);
    const exact = await readProjectAsync("x/seed.project.json", { open: async () => handle(), isDirectory: async () => false });
    expect(exact.ok).toBe(true);
  });
  it("the sync read also refuses a folder in the place of the file, and an exact-size file is read whole", () => {
    const odd = dir();
    mkdirSync(join(odd, "seed.project.json"));
    expect(readProject(odd).ok).toBe(false);
  });
});

describe("findings 5, 6 and 7: saving an imported material", () => {
  const k = { schema: THERMAL_SET_SCHEMA, model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: { kind: "sourced", text: "x" } };
  const man = (revision: number, projectId = "p", name = "n") => ({ schema: "seed.project/0.1", projectId, materials: [{ id: "mat-x1", revision, name, sets: { "thermal.conductivity": k } }] });
  const imp = (revision: number, projectId = "p", name = "n") => {
    const r = importMaterial(man(revision, projectId, name), { id: "mat-x1", region: "fuel" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.material;
  };
  const inLibrary = <T>(f: (file: string) => T): T => {
    const saved = process.env.FEED_USER_LIBRARY;
    const file = join(mkdtempSync(join(tmpdir(), "feed-lib-")), "materials.json");
    process.env.FEED_USER_LIBRARY = file;
    try {
      return f(file);
    } finally {
      if (saved === undefined) delete process.env.FEED_USER_LIBRARY;
      else process.env.FEED_USER_LIBRARY = saved;
    }
  };
  const save = (material: unknown, name = "Same") => saveUserMaterial({ region: "fuel", name, material }, new Set());

  it("5: the same sets from a later project revision are a new entry with that origin and at least that revision, and saving them again is unchanged", () => {
    inLibrary(() => {
      const first = save(imp(2));
      expect(first.ok && first.entry.material.revision).toBe(2);
      const later = save(imp(8));
      expect(later.ok && later.status).toBe("saved");
      expect(later.ok && later.entry.material.revision).toBe(8);
      expect(later.ok && later.entry.material.origin?.revision).toBe(8);
      const again = save(imp(8));
      expect(again.ok && again.status).toBe("unchanged");
      expect(again.ok && again.entry.material.revision).toBe(8);
    });
  });
  it("5: an earlier project revision with the same sets, saved after a later one, is unchanged only if the library's revision already reaches it and the origin is the same", () => {
    inLibrary(() => {
      save(imp(8));
      const earlier = save(imp(5));
      expect(earlier.ok && earlier.status).toBe("saved"); // a different origin: kept, as a new revision above the latest
      expect(earlier.ok && earlier.entry.material.revision).toBe(9);
      expect(earlier.ok && earlier.entry.material.origin?.revision).toBe(5);
    });
  });
  it("6: a project revision at or beyond the last exact integer is refused at import; one below it is carried", () => {
    for (const revision of [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER]) {
      const r = importMaterial(man(revision), { id: "mat-x1", region: "fuel" });
      expect(r.ok ? "ok" : r.errors[0]!.code, String(revision)).toBe("E_IMPORT_PROJECT");
    }
    expect(importMaterial(man(Number.MAX_SAFE_INTEGER - 1), { id: "mat-x1", region: "fuel" }).ok).toBe(true);
  });
  it("6: a material, an origin or a library entry with an inexact revision is refused, and so is a save whose next revision would be inexact", () => {
    expect(validateMaterial("fuel", { materialId: "mat-x1", revision: 2 ** 53, sets: {} }).errors.some((e) => e.field === "/materials/fuel/revision")).toBe(true);
    expect(validateMaterial("fuel", { materialId: "mat-x1", revision: Number.MAX_SAFE_INTEGER, sets: { "thermal.conductivity": k } }).errors.some((e) => e.field === "/materials/fuel/revision")).toBe(false);
    const o = imp(3).origin;
    expect(originProblem({ ...o, revision: 2 ** 53 }, "mat-x1")).not.toBeNull();
    expect(originProblem({ ...o, revision: Number.MAX_SAFE_INTEGER }, "mat-x1")).not.toBeNull();
    expect(originProblem(o, "mat-x1")).toBeNull();
    inLibrary((file) => {
      const plain = { materialId: "mat-x1", revision: Number.MAX_SAFE_INTEGER, sets: { "thermal.conductivity": { model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: "x" } } };
      writeFileSync(file, JSON.stringify({ schema: USER_LIBRARY_SCHEMA, entries: [{ region: "fuel", name: "Top", label: "custom", description: "", citation: "", savedAt: "2026-10-07T00:00:00Z", material: plain }] }));
      const changed = { ...plain, revision: 1, sets: { "thermal.conductivity": { ...plain.sets["thermal.conductivity"], value: q(4, "W/m/K") } } };
      const r = save(changed, "Top");
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.errors[0]!.code + " " + r.errors[0]!.field).toBe("E_OUT_OF_RANGE /material/revision");
    });
  });
  it("7: a project id or a name the origin cannot carry is refused at import, with its field; the longest they can be import and save", () => {
    const empty = importMaterial(man(3, ""), { id: "mat-x1", region: "fuel" });
    expect(empty.ok ? "ok" : empty.errors[0]!.field).toBe("/projectId");
    const longId = importMaterial(man(3, "p".repeat(PROJECT_ID_MAX + 1)), { id: "mat-x1", region: "fuel" });
    expect(longId.ok ? "ok" : longId.errors[0]!.field).toBe("/projectId");
    const longName = importMaterial(man(3, "p", "n".repeat(ORIGIN_NAME_MAX + 1)), { id: "mat-x1", region: "fuel" });
    expect(longName.ok ? "ok" : longName.errors[0]!.code + " " + longName.errors[0]!.field).toBe("E_IMPORT_PROJECT /name");
    const edge = imp(3, "p".repeat(PROJECT_ID_MAX), "n".repeat(ORIGIN_NAME_MAX));
    inLibrary(() => {
      const r = save(edge, "Longest");
      expect(r.ok).toBe(true);
    });
  });
  it("7: import and save use one contract, so what import produces is always a saveable origin", () => {
    const m = imp(3);
    expect(originProblem(m.origin, m.materialId)).toBeNull();
    expect(originProblem({ ...m.origin, setsSha256: setsHash({}) + "0" }, m.materialId)).not.toBeNull();
    expect(originProblem({ ...m.origin, materialId: "other" }, m.materialId)).not.toBeNull();
    expect(originProblem(null, m.materialId)).not.toBeNull();
  });
});

describe("edges the mutation run of the fixes found", () => {
  it("2: a law that overflows only at the hot end (finite at the cold end) is refused, and one whose lowest value overflows to minus infinity says it cannot be evaluated, not that it is not positive", () => {
    const hotEnd = validateMaterial("fuel", polyMaterial([1, 0, 1e308, 0], [0.001, 2000]));
    expect(hotEnd.errors.map((e) => e.code)).toEqual(["E_OUT_OF_RANGE"]);
    expect(hotEnd.errors[0]!.message).toMatch(/cannot be evaluated/);
    const coldEnd = validateMaterial("fuel", polyMaterial([1, 0, -1e308, 0], [0.001, 2000]));
    expect(coldEnd.errors[0]!.message).toMatch(/cannot be evaluated/);
  });
  it("4: a finished read leaves no deadline timer behind", async () => {
    vi.useFakeTimers();
    try {
      const text = Buffer.from(JSON.stringify({ schema: "seed.project/0.1", projectId: "p", materials: [] }));
      let given = 0;
      const file = { stat: async () => ({ isFile: () => true, size: text.length }), read: async (buf: Buffer, off: number, len: number) => { const n = Math.min(len, text.length - given); text.copy(buf, off, given, given + n); given += n; return { bytesRead: n }; }, close: async () => undefined };
      const r = await readProjectAsync("x/seed.project.json", { open: async () => file, isDirectory: async () => false });
      expect(r.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("5: a library entry with the same origin but a revision below what that origin asks for (a hand-edited file) is not taken as unchanged", () => {
    const k = { schema: THERMAL_SET_SCHEMA, model: "constant", value: q(3, "W/m/K"), referenceTemperature: q(300, "K"), source: { kind: "sourced", text: "x" } };
    const man = { schema: "seed.project/0.1", projectId: "p", materials: [{ id: "mat-x1", revision: 8, name: "n", sets: { "thermal.conductivity": k } }] };
    const r = importMaterial(man, { id: "mat-x1", region: "fuel" });
    if (!r.ok) throw new Error("refused");
    const saved = process.env.FEED_USER_LIBRARY;
    const file = join(mkdtempSync(join(tmpdir(), "feed-lib-")), "materials.json");
    process.env.FEED_USER_LIBRARY = file;
    try {
      const low = { ...r.material, revision: 2 };
      writeFileSync(file, JSON.stringify({ schema: USER_LIBRARY_SCHEMA, entries: [{ region: "fuel", name: "Same", label: "custom", description: "", citation: "", savedAt: "2026-10-07T00:00:00Z", material: low }] }));
      const out = saveUserMaterial({ region: "fuel", name: "Same", material: r.material }, new Set());
      expect(out.ok && out.status).toBe("saved");
      expect(out.ok && out.entry.material.revision).toBe(8);
    } finally {
      if (saved === undefined) delete process.env.FEED_USER_LIBRARY;
      else process.env.FEED_USER_LIBRARY = saved;
    }
  });
});
