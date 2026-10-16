// Plan 13 T3, ungated: a particle through the server's check, run, results, detail, CSV and compare routes (a scripted backend with the real saved output), and through the command
// line (write-case, headless validate). The editor's page (src/web) is milestone T5; the page's guards are checked by their text.
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
const particle = () => JSON.parse(readFileSync(join(root, "schema", "vectors", "good", "triso-steady.json"), "utf8"));
const pin = () => JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"));
let base = "";
let runsRoot = "";
let mgr: RunManager;
const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-feed-client": "1" }, body: JSON.stringify(body) });
const ids: Record<string, string> = {};

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-trisrv-"));
  const scripts = ["triso-good", "good"] as const;
  let n = 0;
  mgr = new RunManager({ runsRoot, backend: new FakeBackend(() => scripts[n++]!) });
  useManager(mgr);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  for (const [name, doc] of [["particle", particle()], ["pin", pin()]] as const) {
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

describe("a particle through the server", () => {
  it("/api/check accepts it and carries the normalised particle, its closed form and its numbers", async () => {
    const j: any = await (await post("/api/check", particle())).json();
    expect(j.ok).toBe(true);
    expect(j.errors).toEqual([]);
    expect(j.normalized).toBeUndefined();
    expect(j.triso.normalized.layers.map((l: any) => l.name)).toEqual(["buffer", "ipyc", "sic", "opyc"]);
    expect(j.triso.quick.verdict).toBe("in-domain");
    expect(j.triso.derived.particlePower).toBeGreaterThan(0);
  });
  it("/api/check keeps the particle's own errors for an invalid one", async () => {
    const bad = particle();
    bad.power = {};
    const j: any = await (await post("/api/check", bad)).json();
    expect(j.ok).toBe(false);
    expect(j.errors.map((e: any) => e.code)).toEqual(["E_SCHEMA_INVALID"]);
  });
  it("/api/run starts it, /results and /detail carry the particle's results, and the run list has its headline", async () => {
    const r: any = await (await get(`/api/run/${ids.particle}/results`)).json();
    expect(r.kind).toBe("triso");
    expect(r.checks.filter((c: any) => c.verdict === "fail")).toEqual([]);
    expect(r.regions).toHaveLength(5);
    const d: any = await (await get(`/api/run/${ids.particle}/detail`)).json();
    expect(d.record.state).toBe("completed");
    expect(d.normalized.kind).toBe("triso");
    expect(d.results.summary.wallT).toBe(1000);
    expect(d.manifest.choices.endTime).toBe(5e7);
    const list: any[] = await (await get("/api/runs")).json();
    expect(list.find((x) => x.id === ids.particle).headline.centreCellT).toBeCloseTo(r.summary.kernelCentreCellT, 9);
  });
  it("/api/run rejects an invalid particle with its errors", async () => {
    const bad = particle();
    delete bad.materials.kernel;
    const res = await post("/api/run", bad);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).errors.map((e: any) => e.code)).toEqual(["E_SCHEMA_INVALID"]);
  });
  it("the CSV has a row per cell and the regions' faces", async () => {
    const res = await get(`/api/run/${ids.particle}/results.csv`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# Fuel Performance Studio results (coated particle)");
    expect(text).toContain("r_um,T_K,T_C,region");
    expect(text.split("\n").filter((l) => /,(kernel|buffer|ipyc|sic|opyc)$/.test(l))).toHaveLength(64);
    expect(text).toContain("# kernel,");
    expect(text).toContain("# opyc,");
  });
  it("compare refuses a particle (with a pin or with itself), saying why, and does not crash", async () => {
    for (const [a, b] of [[ids.particle, ids.pin], [ids.pin, ids.particle], [ids.particle, ids.particle]] as const) {
      const j: any = await (await get(`/api/compare?a=${a}&b=${b}`)).json();
      expect(j.error).toMatch(/pins and plates/);
    }
  });
  it("the page shows a particle as a note and a plain results card, not through the pin's views (their guards are in the page's text)", () => {
    const html = readFileSync(join(root, "src", "web", "index.html"), "utf8");
    expect(html).toContain("I_PARTICLE");
    expect(html).toContain('d.results.kind === "triso"');
    expect(html).toContain('d.normalized.kind === "triso"');
  });
});

describe("a particle through the command line", () => {
  const dist = join(root, "dist", "cli");
  it("write-case writes the wedge case and its manifest, and refuses an invalid particle", () => {
    const out = mkdtempSync(join(tmpdir(), "feed-wc-"));
    try {
      const src = join(root, "schema", "vectors", "good", "triso-steady.json");
      execFileSync("node", [join(dist, "write-case.js"), src, join(out, "case")], { stdio: "pipe" });
      for (const f of ["system/blockMeshDict", "system/controlDict", "constant/solverDict", "0/T", "0/D", "feed-manifest.json"]) expect(existsSync(join(out, "case", f)), f).toBe(true);
      const man = JSON.parse(readFileSync(join(out, "case", "feed-manifest.json"), "utf8"));
      expect(man.caseId).toBe("triso-steady");
      expect(man.choices.endTime).toBe(5e7);
      expect(man.files["system/blockMeshDict"]).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(out, "case", "system", "blockMeshDict"), "utf8")).toContain("hex ( 0 1 2 3 4 5 6 7 ) Kernel (1 1 12)");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  it("headless validate accepts a particle", () => {
    const src = join(root, "schema", "vectors", "good", "triso-steady.json");
    const r = JSON.parse(execFileSync("node", [join(dist, "headless.js"), "validate", src], { encoding: "utf8" }));
    expect(r).toEqual({ ok: true, warnings: [] });
  });
});
