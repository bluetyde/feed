// Plan 13 T6: the population's worker thread and the server's function behind the editor's Run population (the route itself is in tests/populationEditor.test.ts). Kept apart from
// tests/trisoPopulation.test.ts because a worker runs the COMPILED code in dist/ (npm run build first), not the source: a mutation of the source does not reach it.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { startPopulation } from "../src/core/populationRunner";
import { validateCase } from "../src/core/validate";
import { populationFor } from "../src/server/server";

const root = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
const vec = (name: string) => read("schema/vectors/good/" + name + ".json");
const q = (value: number, unit: string) => ({ value, unit });
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.triso!;
};
function particle(pop: Record<string, unknown>, power = "600") {
  const c = vec("triso-steady");
  c.power = { kernelPowerDensity: q(Number(power), "MW/m3") };
  c.population = pop;
  return c;
}
const N = (m: number, s: number, u = "um") => ({ kind: "normal", mean: q(m, u), stdDev: q(s, u) });
const ok = (pop: Record<string, unknown>, power?: string) => norm(particle(pop, power));

describe("the worker and the function behind Run population", () => {
  it("populationFor answers a valid case with the spread, a case without a population and an invalid one with their reasons, and a pin with its own", async () => {
    const good = await populationFor(particle({ size: 100, seed: 1, distributions: { kernelRadius: N(250, 5) } }));
    expect(good.status).toBe(200);
    expect((good.body as any).result.kind).toBe("triso-population");
    expect((good.body as any).result.size).toBe(100);
    const none = await populationFor(vec("triso-steady"));
    expect(none.status).toBe(400);
    expect((none.body as any).errors[0].code).toBe("E_PROP_MISSING");
    const bad = await populationFor(particle({ size: 0, seed: 1, distributions: {} }));
    expect(bad.status).toBe(400);
    expect((bad.body as any).errors[0].code).toBe("E_OUT_OF_RANGE");
    const pin = await populationFor(read("examples/synthetic-pin.json"));
    expect(pin.status).toBe(400);
    expect((pin.body as any).errors[0].code).toBe("E_UNSUPPORTED");
    const mostly = await populationFor(particle({ size: 50, seed: 3, distributions: { buffer: { kind: "normal", mean: q(-1, "um"), stdDev: q(0.5, "um") }, ipyc: { kind: "normal", mean: q(-1, "um"), stdDev: q(0.5, "um") }, sic: { kind: "normal", mean: q(-1, "um"), stdDev: q(0.5, "um") }, opyc: { kind: "normal", mean: q(-1, "um"), stdDev: q(0.5, "um") } } }));
    expect(mostly.status).toBe(422);
    expect((mostly.body as any).error).toMatch(/too many particles/);
  }, 60000);
  it("the worker thread gives the same result as the calling thread, and says which it was", async () => {
    const n = ok({ size: 500, seed: 14, distributions: { kernelRadius: N(250, 6), powerFactor: { kind: "lognormal", median: q(1, "1"), sigmaLog: q(0.1, "1") } } });
    const inProcess = await startPopulation(n, { workerFile: null }).done;
    const worker = await startPopulation(n).done;
    expect(inProcess.ok && worker.ok).toBe(true);
    if (inProcess.ok && worker.ok) {
      expect(inProcess.mode).toBe("in-process");
      expect(worker.mode).toBe("worker");
      expect(JSON.stringify(worker.result)).toBe(JSON.stringify(inProcess.result));
    }
  }, 60000);
  it("a deadline stops the worker and reports it; a cancel stops it and reports that", async () => {
    const n = ok({ size: 100000, seed: 1, distributions: { kernelRadius: N(250, 6) } });
    const slow = await startPopulation(n, { deadlineMs: 5 }).done;
    expect(slow).toMatchObject({ ok: false, reason: "deadline" });
    const h = startPopulation(n);
    h.cancel();
    expect(await h.done).toMatchObject({ ok: false, reason: "cancelled" });
  }, 60000);
});
