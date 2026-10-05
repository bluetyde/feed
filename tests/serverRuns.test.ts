// Run endpoints with a scripted backend: detail, CSV export, compare. (No solver needed.)
import { AddressInfo } from "net";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";
import { FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const pin = (mutate?: (d: any) => void) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  mutate?.(d);
  return d;
};
let base = "";
let runsRoot = "";
let mgr: RunManager;
const ids: Record<string, string> = {};
const get = async (path: string) => fetch(base + path);
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-srv-"));
  const scripts: Script[] = ["good", "good", "fatal"];
  let n = 0;
  mgr = new RunManager({ runsRoot, backend: new FakeBackend(() => scripts[n++]!) });
  useManager(mgr);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const start = async (name: string, d: any) => {
    const j: any = await (await post("/api/run", d)).json();
    await mgr.done(j.id);
    ids[name] = j.id;
  };
  await start("a", pin());
  await start("b", pin((d) => ((d.name = "Lower coolant coefficient"), (d.boundary.heatTransferCoefficient = { value: 25000, unit: "W/m2/K" }))));
  await start("fail", pin());
});
afterAll(async () => {
  useManager(null);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(runsRoot, { recursive: true, force: true });
});

describe("run list and detail", () => {
  it("lists runs with name, state and headline numbers", async () => {
    const list = (await (await get("/api/runs")).json()) as any[];
    expect(list.length).toBe(3);
    const a = list.find((r) => r.id === ids.a);
    expect(a.state).toBe("completed");
    expect(a.caseName).toMatch(/Synthetic composite pin/);
    expect(a.headline.centreCellT).toBeCloseTo(1307.2076, 3);
    expect(list.find((r) => r.id === ids.fail).headline).toBeUndefined();
  });

  it("detail returns the record, case, normalized case, manifest summary and results", async () => {
    const d: any = await (await get(`/api/run/${ids.a}/detail`)).json();
    expect(d.record.state).toBe("completed");
    expect(d.case.caseId).toBe("synthetic-pin");
    expect(d.normalized.mesh.fuelCells).toBe(20);
    expect(d.manifest.choices.endTime).toBe(5e7);
    expect(d.results.radial.length).toBe(26);
  });

  it("a failed run's detail has no results", async () => {
    const d: any = await (await get(`/api/run/${ids.fail}/detail`)).json();
    expect(d.record.state).toBe("failed");
    expect(d.results).toBeUndefined();
  });
});

describe("CSV export", () => {
  it("downloads a completed run as CSV with the thermal-only statement", async () => {
    const r = await get(`/api/run/${ids.a}/results.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="synthetic-pin-[0-9a-f]{12}\.csv"/);
    const t = await r.text();
    expect(t).toMatch(/# Thermal-only/);
    expect(t.split("\n").filter((l) => /^\d/.test(l)).length).toBe(26);
  });
  it("a failed run has no CSV", async () => {
    expect((await get(`/api/run/${ids.fail}/results.csv`)).status).toBe(404);
  });
});

describe("compare", () => {
  it("shows the input difference and result differences between two completed runs", async () => {
    const c: any = await (await get(`/api/compare?a=${ids.a}&b=${ids.b}`)).json();
    expect(c.identicalInputs).toBe(false);
    expect(c.inputDiff.map((r: any) => r.path)).toEqual(["boundary.heatTransferCoefficient", "name"]);
    expect(c.inputDiff.find((r: any) => r.path === "boundary.heatTransferCoefficient")).toEqual({ path: "boundary.heatTransferCoefficient", a: "30000 W/m2/K", b: "25000 W/m2/K" });
    expect(c.summary.length).toBe(6);
    expect(c.profile.r.length).toBe(26); // same geometry and mesh
    expect(c.thermalOnly).toMatch(/Thermal-only/);
    // the scripted solver returned the same fields for both cases, so the checks against the (different) closed forms disagree
    expect(c.checks.some((x: any) => x.a !== x.b)).toBe(true);
  });

  it("two runs of the same case have identical inputs", async () => {
    const c: any = await (await get(`/api/compare?a=${ids.a}&b=${ids.a}`)).json();
    expect(c.identicalInputs).toBe(true);
    expect(c.inputDiff).toEqual([]);
    expect(c.summary.every((r: any) => r.delta === 0)).toBe(true);
  });

  it("refuses a run that is not completed", async () => {
    const c: any = await (await get(`/api/compare?a=${ids.a}&b=${ids.fail}`)).json();
    expect(c.error).toMatch(/both runs must be completed.*B is failed/);
  });

  it("rejects bad ids and unknown runs", async () => {
    expect((await get(`/api/compare?a=../x&b=${ids.a}`)).status).toBe(400);
    expect((await get(`/api/compare?a=${ids.a}`)).status).toBe(400);
    const c: any = await (await get(`/api/compare?a=000000000000&b=${ids.a}`)).json();
    expect(c.error).toMatch(/unknown run/);
  });
});
