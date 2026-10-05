// Study endpoints with a scripted backend. The scripted output has 26 cells, so only the 20/6 mesh parses; this exercises
// request validation, the mesh cap and the failure path. The success path runs in runManagerWsl.test.ts (real solver).
import { AddressInfo } from "net";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";
import { FakeBackend } from "./helpers/fakeBackend";

let base = "";
let runsRoot = "";
let mgr: RunManager;
const pin = (mutate?: (d: any) => void) => {
  const d = JSON.parse(readFileSync(join(__dirname, "..", "examples/synthetic-pin.json"), "utf8"));
  mutate?.(d);
  return d;
};
const post = (path: string, body: unknown, type = "application/json") => fetch(base + path, { method: "POST", headers: { "content-type": type, "x-feed-client": "1" }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-study-"));
  mgr = new RunManager({ runsRoot, backend: new FakeBackend("good") });
  useManager(mgr);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  useManager(null);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(runsRoot, { recursive: true, force: true });
});

describe("POST /api/study", () => {
  it("starts three runs at x1, x2 and x4 of the mesh", async () => {
    const r = await post("/api/study", pin());
    expect(r.status).toBe(202);
    const { ids } = (await r.json()) as { ids: string[] };
    expect(ids.length).toBe(3);
    expect(ids.every((i) => /^[0-9a-f]{12}$/.test(i))).toBe(true);
    for (const id of ids) await mgr.done(id);
    const cells = await Promise.all(ids.map(async (id) => ((await (await fetch(`${base}/api/run/${id}/detail`)).json()) as any).case.mesh.fuelCells));
    expect(cells).toEqual([20, 40, 80]);
  });

  it("refuses an invalid case without starting anything", async () => {
    const before = mgr.list().length;
    const r = await post("/api/study", pin((d) => delete d.boundary.heatTransferCoefficient));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).errors[0].code).toBe("E_BOUNDARY_INCOMPLETE");
    expect(mgr.list().length).toBe(before);
  });

  it("refuses a mesh whose finest level would exceed the cap", async () => {
    const before = mgr.list().length;
    const r = await post("/api/study", pin((d) => (d.mesh.fuelCells = 1500)));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/limited to 4000/);
    expect(mgr.list().length).toBe(before);
  });

  it("refuses a mesh whose finest cladding level would exceed its cap", async () => {
    const before = mgr.list().length;
    const r = await post("/api/study", pin((d) => (d.mesh.claddingCells = 600)));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/cladding cells.*limited to 2000/);
    expect(mgr.list().length).toBe(before);
  });

  it("rejects non-JSON content and bad JSON", async () => {
    expect((await post("/api/study", "x", "text/plain")).status).toBe(415);
    expect((await post("/api/study", "{nope")).status).toBe(400);
  });
});

describe("GET /api/study", () => {
  it("reports a failed study when a level did not produce a result (scripted output has the wrong cell count for x2, x4)", async () => {
    const { ids } = (await (await post("/api/study", pin())).json()) as { ids: string[] };
    for (const id of ids) await mgr.done(id);
    const s = (await (await fetch(`${base}/api/study?ids=${ids.join(",")}`)).json()) as any;
    expect(s.status).toBe("failed");
    expect(s.states).toEqual(["completed", "failed", "failed"]);
    expect(s.failures[1]).toMatch(/not a complete result.*expected 52 cells/);
  });

  it("rejects bad id lists", async () => {
    for (const q of ["", "ids=a,b,c", "ids=000000000000,000000000000", "ids=../x,000000000000,000000000000"]) expect((await fetch(`${base}/api/study?${q}`)).status).toBe(400);
  });

  it("unknown runs are an error, not a crash", async () => {
    const s = (await (await fetch(`${base}/api/study?ids=000000000000,000000000001,000000000002`)).json()) as any;
    expect(s.status).toBe("error");
  });
});
