// Plan 13 T4, ungated: a compact and a pebble through the server's check, run, results, detail, CSV and compare routes (a scripted backend with the real saved output of
// tests/golden/offbeat-compact and offbeat-pebble), and through the command line (write-case, headless validate). The editor has no panel for either yet: the response carries what a
// script needs (docs/compact-pebble.md).
import { execFileSync } from "child_process";
import { AddressInfo } from "net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";
import { FakeBackend } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const example = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
let base = "";
let runsRoot = "";
let mgr: RunManager;
const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-feed-client": "1" }, body: JSON.stringify(body) });
const ids: Record<string, string> = {};

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-cpsrv-"));
  const scripts = ["compact-good", "pebble-good"] as const;
  let n = 0;
  mgr = new RunManager({ runsRoot, backend: new FakeBackend(() => scripts[n++]!) });
  useManager(mgr);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  for (const [name, doc] of [["compact", example("synthetic-compact-steady")], ["pebble", example("synthetic-pebble-steady")]] as const) {
    const j: any = await (await post("/api/run", doc)).json();
    await mgr.done(j.id);
    ids[name] = j.id;
  }
});
afterAll(async () => {
  useManager(null);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(runsRoot, { recursive: true, force: true });
});

describe("a compact through the server", () => {
  it("/api/check accepts it as the pin it is and adds the mixture and the hottest particle", async () => {
    const j: any = await (await post("/api/check", example("synthetic-compact-steady"))).json();
    expect(j.ok).toBe(true);
    expect(j.errors).toEqual([]);
    expect(j.normalized.compact.law).toBe("maxwell-eucken");
    expect(j.compact.spec.packingFraction).toBeCloseTo(0.35, 12);
    expect(j.compact.hottestParticle.kernelCentreT).toBeGreaterThan(j.quick.temperatures.centreT);
    expect(j.compact.hottestParticle.kernelCentreT - j.quick.temperatures.centreT).toBeLessThan(15);
  });
  it("/api/check refuses a compact with a fuel material, with the compact's own error", async () => {
    const bad = example("synthetic-compact-steady");
    bad.materials.fuel = JSON.parse(JSON.stringify(bad.materials.cladding));
    const j: any = await (await post("/api/check", bad)).json();
    expect(j.ok).toBe(false);
    expect(j.errors.map((e: any) => e.code + e.field)).toEqual(["E_UNSUPPORTED/materials/fuel"]);
  });
  it("/results and /detail carry the pin's results and the compact's record; the run list has the headline", async () => {
    const r: any = await (await get(`/api/run/${ids.compact}/results`)).json();
    expect(r.checks.filter((c: any) => c.verdict === "fail")).toEqual([]);
    expect(r.compact.twoScale.map((e: any) => e.at)).toEqual(["hottest", "mean"]);
    expect(r.compact.label).toMatch(/Two-scale result/);
    const d: any = await (await get(`/api/run/${ids.compact}/detail`)).json();
    expect(d.record.state).toBe("completed");
    expect(d.normalized.compact.packingFraction).toBeCloseTo(0.35, 12);
    const list: any[] = await (await get("/api/runs")).json();
    expect(list.find((x) => x.id === ids.compact).headline.centreCellT).toBeCloseTo(r.summary.centreCellT, 9);
  });
  it("the CSV is the pin's", async () => {
    const text = await (await get(`/api/run/${ids.compact}/results.csv`)).text();
    expect(text).toContain("r_mm,T_K,T_C,region");
  });
});

describe("a pebble through the server", () => {
  it("/api/check accepts it, with its closed form and the hottest particle, and no pin or particle in the answer", async () => {
    const j: any = await (await post("/api/check", example("synthetic-pebble-steady"))).json();
    expect(j.ok).toBe(true);
    expect(j.normalized).toBeUndefined();
    expect(j.triso).toBeUndefined();
    expect(j.pebble.normalized.cells).toEqual([160, 40]);
    expect(j.pebble.closed.centreT).toBeGreaterThan(j.pebble.closed.interfaceT);
    expect(j.pebble.hottestParticle.matrixT).toBeCloseTo(j.pebble.closed.centreT, 9);
  });
  it("/api/check keeps the pebble's own errors for an invalid one, and /api/run rejects it", async () => {
    const bad = example("synthetic-pebble-steady");
    delete bad.materials.shell;
    const j: any = await (await post("/api/check", bad)).json();
    expect(j.ok).toBe(false);
    expect(j.errors.map((e: any) => e.code)).toEqual(["E_SCHEMA_INVALID"]);
    const res = await post("/api/run", bad);
    expect(res.status).toBe(400);
  });
  it("/results and /detail carry the pebble's results; the headline is the fuelled zone's first cell and the wall", async () => {
    const r: any = await (await get(`/api/run/${ids.pebble}/results`)).json();
    expect(r.kind).toBe("pebble");
    expect(r.checks.filter((c: any) => c.verdict === "fail")).toEqual([]);
    expect(r.regions.map((x: any) => x.name)).toEqual(["fuelled", "shell"]);
    const d: any = await (await get(`/api/run/${ids.pebble}/detail`)).json();
    expect(d.normalized.kind).toBe("pebble");
    expect(d.manifest.choices.endTime).toBeGreaterThan(0);
    const list: any[] = await (await get("/api/runs")).json();
    expect(list.find((x) => x.id === ids.pebble).headline.centreCellT).toBeCloseTo(r.summary.centreCellT, 9);
  });
  it("the CSV has a row per cell, the regions' faces and the hottest particle of each two-scale entry, with the two-scale label", async () => {
    const res = await get(`/api/run/${ids.pebble}/results.csv`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# Fuel Performance Studio results (pebble)");
    expect(text).toContain("Two-scale result");
    expect(text.split("\n").filter((l) => /,(fuelled|shell)$/.test(l))).toHaveLength(200);
    expect(text).toContain("# fuelled,");
    expect(text).toContain("# hottest,");
    expect(text).toContain("# mean,");
  });
  it("compare refuses a pebble (with a pin or with itself), saying why", async () => {
    for (const [a, b] of [[ids.pebble, ids.compact], [ids.compact, ids.pebble], [ids.pebble, ids.pebble]] as const) {
      const j: any = await (await get(`/api/compare?a=${a}&b=${b}`)).json();
      expect(j.error).toMatch(/pins and plates/);
    }
  });
});

describe("the editor's page", () => {
  it("opens a compact as the pin it is (its fuel item says it is derived, not a missing material) and shows a valid pebble as a notice, not as a pin (guards by their text; driven in the browser pane)", () => {
    const html = readFileSync(join(root, "src", "web", "index.html"), "utf8");
    expect(html).toContain('selected === "fuel" && doc.compact');
    expect(html).toContain("The editor has no panel for that block yet: edit it in the JSON tab.");
    expect(html).toContain("if (j.ok && j.pebble) result = { ok: false");
    expect(html).toContain("the editor has no panel or picture for a pebble yet");
  });
});

describe("through the command line", () => {
  const dist = join(root, "dist", "cli");
  it("write-case writes the pebble's wedge case and its manifest, and the compact's pin case", () => {
    const out = mkdtempSync(join(tmpdir(), "feed-wc4-"));
    try {
      execFileSync("node", [join(dist, "write-case.js"), join(root, "examples", "synthetic-pebble-steady.json"), join(out, "pebble")], { stdio: "pipe" });
      for (const f of ["system/blockMeshDict", "system/controlDict", "constant/solverDict", "0/T", "0/D", "feed-manifest.json"]) expect(existsSync(join(out, "pebble", f)), f).toBe(true);
      const man = JSON.parse(readFileSync(join(out, "pebble", "feed-manifest.json"), "utf8"));
      expect(man.caseId).toBe("synthetic-pebble-steady");
      expect(readFileSync(join(out, "pebble", "system", "blockMeshDict"), "utf8")).toContain("hex ( 0 1 2 3 4 5 6 7 ) Kernel (1 1 160)");
      execFileSync("node", [join(dist, "write-case.js"), join(root, "examples", "synthetic-compact-steady.json"), join(out, "compact")], { stdio: "pipe" });
      expect(readFileSync(join(out, "compact", "constant", "solverDict"), "utf8")).toContain("conductivityModel ZyRELAP");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  it("headless validate accepts both", () => {
    for (const f of ["synthetic-pebble-steady", "synthetic-compact-steady"]) {
      const r = JSON.parse(execFileSync("node", [join(dist, "headless.js"), "validate", join(root, "examples", f + ".json")], { encoding: "utf8" }));
      expect(r).toEqual({ ok: true, warnings: [] });
    }
  });
});
