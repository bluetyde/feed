// A burnup run through the server endpoints, with a scripted backend that writes the real OFFBEAT fields of FEED's burnup case (no solver needed): the detail carries the
// frozen-burnup sentence and the burnup checks, and a comparison of a burnt pin with a fresh one carries each run's own statement (it used to carry run A's alone).
import { AddressInfo } from "net";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { server, useManager } from "../src/server/server";
import { FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const pin = (burnt: boolean) => {
  const d = JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
  d.power.linearHeatRate = q(20, "kW/m");
  if (burnt) {
    d.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(95, "%"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11" };
    d.burnup = { value: q(40, "MWd/kgHM"), basis: "heavy-metal", source: "chosen for the study" };
  }
  return d;
};
let base = "";
let runsRoot = "";
let mgr: RunManager;
const ids: Record<string, string> = {};
const get = async (path: string) => fetch(base + path);
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-feed-client": "1" }, body: JSON.stringify(body) });

beforeAll(async () => {
  runsRoot = mkdtempSync(join(tmpdir(), "feed-srv-bu-"));
  const scripts: Script[] = ["burnup-good", "good"];
  let n = 0;
  mgr = new RunManager({ runsRoot, backend: new FakeBackend(() => scripts[n++]!) });
  useManager(mgr);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  for (const [name, burnt] of [["burnt", true], ["fresh", false]] as const) {
    const j: any = await (await post("/api/run", pin(burnt))).json();
    await mgr.done(j.id);
    ids[name] = j.id;
  }
});
afterAll(async () => {
  useManager(null);
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(runsRoot, { recursive: true, force: true });
});

describe("a burnup run through the server", () => {
  it("the detail carries the burnup, its sentence and its checks", async () => {
    const d: any = await (await get(`/api/run/${ids.burnt}/detail`)).json();
    expect(d.record.state).toBe("completed");
    expect(d.results.burnup).toEqual({ value: 40, source: "chosen for the study" });
    expect(d.results.thermalOnly).toMatch(/^Thermal-only result\. .*Frozen-burnup snapshot/);
    expect(d.results.checks.filter((c: any) => c.id.startsWith("burnup")).map((c: any) => c.verdict)).toEqual(["pass", "pass"]);
    expect(d.normalized.burnup.value).toBe(40);
  });
  it("the CSV export carries the sentence", async () => {
    const text = await (await get(`/api/run/${ids.burnt}/results.csv`)).text();
    expect(text).toContain("Frozen-burnup snapshot");
  });
  it("a comparison of a burnt pin (A) with a fresh one (B) carries each run's own statement, in either order", async () => {
    const ab: any = await (await get(`/api/compare?a=${ids.burnt}&b=${ids.fresh}`)).json();
    expect(ab.thermalOnly).toMatch(/^Run A: Thermal-only result\. .*Frozen-burnup snapshot.* Run B: Thermal-only result\. It says nothing about stress, failure or fuel integrity\.$/);
    const ba: any = await (await get(`/api/compare?a=${ids.fresh}&b=${ids.burnt}`)).json();
    expect(ba.thermalOnly).toMatch(/^Run A: Thermal-only result\. It says nothing about stress, failure or fuel integrity\. Run B: .*Frozen-burnup snapshot/);
    const same: any = await (await get(`/api/compare?a=${ids.fresh}&b=${ids.fresh}`)).json();
    expect(same.thermalOnly).toBe("Thermal-only result. It says nothing about stress, failure or fuel integrity.");
  });
});
