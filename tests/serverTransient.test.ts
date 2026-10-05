// The server with a transient case: the independent preview from /api/check, a scripted run that returns saved OFFBEAT output
// (tests/golden/offbeat-pulse), the CSV export, and the refusals (refinement study, compare). No solver needed.
import { AddressInfo } from "net";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackendOutcome, RunBackend, RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";

const root = join(__dirname, "..");
const golden = join(root, "tests/golden/offbeat-pulse");
const pulse = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));

/** A backend that "runs" by copying the saved OFFBEAT output of the synthetic pulse into the native folder. */
class SavedPulseBackend implements RunBackend {
  async run(args: { nativeDir: string }): Promise<BackendOutcome> {
    mkdirSync(join(args.nativeDir, "final"), { recursive: true });
    cpSync(join(golden, "C"), join(args.nativeDir, "final", "C"));
    cpSync(join(golden, "times"), join(args.nativeDir, "times"), { recursive: true });
    const last = readdirSync(join(golden, "times")).sort((x, y) => Number(x) - Number(y)).pop()!;
    cpSync(join(golden, "times", last, "T"), join(args.nativeDir, "final", "T"));
    writeFileSync(join(args.nativeDir, "log.offbeat"), "saved output\n");
    writeFileSync(join(args.nativeDir, "exit.json"), JSON.stringify({ blockMeshExit: 0, offbeatExit: 139, finalTime: 0.10000000000000184 }));
    return { cancelled: false };
  }
  async cancel() {}
}

let base = "";
let runId = "";
const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-feed-client": "1" }, body: JSON.stringify(body) });

beforeAll(async () => {
  useManager(new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-srvtr-")), backend: new SavedPulseBackend() }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const s: any = await (await post("/api/run", pulse())).json();
  runId = s.id;
  for (let i = 0; i < 100; i++) {
    const rec: any = await (await get("/api/run/" + runId)).json();
    if (rec.state !== "queued" && rec.state !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("transient case through the server", () => {
  it("/api/check: no steady profile, an independent preview and the adiabatic limit", async () => {
    const j: any = await (await post("/api/check", pulse())).json();
    expect(j.ok).toBe(true);
    expect(j.quick).toBeUndefined();
    expect(j.profile).toBeUndefined();
    expect(j.transient.steps).toBe(1000);
    expect(j.transient.depositedEnergy).toBeCloseTo(50000, 6);
    expect(j.transient.adiabaticPeak).toBeCloseTo(615.5957626, 6);
    expect(j.transient.preview.time.length).toBe(21);
    expect(Math.max(...j.transient.preview.peakT)).toBeCloseTo(615.5957626, 3);
    expect(j.derived.volumetricPower).toBeGreaterThan(0);
  });

  it("/api/check refuses a transient with a problem, naming it", async () => {
    const d = pulse();
    d.transient.timeStep = { value: 0.3, unit: "ms" };
    const j: any = await (await post("/api/check", d)).json();
    expect(j.ok).toBe(false);
    expect(j.errors[0].code).toBe("E_TIME");
  });

  it("the run completes with a transient record and a headline marked transient", async () => {
    const rec: any = await (await get("/api/run/" + runId)).json();
    expect(rec.state).toBe("completed");
    expect(rec.headline.transient).toBe(true);
    const res: any = await (await get("/api/run/" + runId + "/results")).json();
    expect(res.schema).toBe("feed.results/0.2");
    expect(res.summary.maxT).toBeCloseTo(615.59576, 4);
    expect(res.checks.every((c: any) => c.verdict === "pass")).toBe(true);
  });

  it("CSV: one row per output time with the series and the thermal-only statement", async () => {
    const r = await get("/api/run/" + runId + "/results.csv");
    expect(r.status).toBe(200);
    const t = await r.text();
    const lines = t.trim().split("\n");
    expect(lines[0]).toMatch(/transient/);
    expect(t).toMatch(/Thermal-only/);
    const head = lines.findIndex((l) => l.startsWith("time_s,"));
    expect(lines.length - head - 1).toBe(21);
    expect(lines[head + 3]!.split(",").length).toBe(9);
  });

  it("a refinement study of a transient is refused with a reason", async () => {
    const r = await post("/api/study", pulse());
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/steady/);
  });

  it("compare refuses a transient run", async () => {
    const j: any = await (await get(`/api/compare?a=${runId}&b=${runId}`)).json();
    expect(j.error).toMatch(/steady runs only/);
  });
});
