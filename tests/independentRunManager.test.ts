// The run manager and the server with the independent runs in a worker: a run through a scripted backend (saved OFFBEAT output of the synthetic pulse)
// gets exactly the result it got in this thread; a run whose checks cannot finish in the deadline fails with a named code and keeps the solver's output;
// cancel reaches a verification in progress; the editor's preview has its own deadline. Needs `npm run build` (the compiled worker).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { IndependentRunner } from "../src/core/independentRunner";
import { BackendOutcome, RunBackend, RunManager } from "../src/core/runManager";
import { buildTransientResults, computeIndependent, independentSolution } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { AddressInfo } from "net";
import { check, checkAsync, independent, server } from "../src/server/server";
import { transientPreview } from "../src/core/transientPreview";

const root = join(__dirname, "..");
const golden = join(root, "tests/golden/offbeat-pulse");
const pulse = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pulse.json"), "utf8"));

/** The outer-iteration records OFFBEAT prints, converged, for each of n steps (the golden pulse output has no log). Same as tests/serverTransient.test.ts. */
const convergedStepsLog = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    ["Time = " + (i + 1) * 1e-4 + " s", "", "OuterIteration n. 0", "FDICPCG:  Solving for T, Initial residual = 1e-3, Final residual = 1e-5, No Iterations 2", "relResidualT is 1", "absErrT is 5", "", "OuterIteration n. 1", "FDICPCG:  Solving for T, Initial residual = 1e-12, Final residual = 1e-13, No Iterations 1", "relResidualT is 1e-12", "absErrT is 1e-12", ""].join("\n"),
  ).join("\n");
/** "Runs" by copying the saved OFFBEAT output of the synthetic pulse into the native folder. */
class SavedPulseBackend implements RunBackend {
  async run(args: { nativeDir: string }): Promise<BackendOutcome> {
    mkdirSync(join(args.nativeDir, "final"), { recursive: true });
    cpSync(join(golden, "C"), join(args.nativeDir, "final", "C"));
    cpSync(join(golden, "times"), join(args.nativeDir, "times"), { recursive: true });
    const last = readdirSync(join(golden, "times")).sort((x, y) => Number(x) - Number(y)).pop()!;
    cpSync(join(golden, "times", last, "T"), join(args.nativeDir, "final", "T"));
    writeFileSync(join(args.nativeDir, "log.offbeat"), convergedStepsLog(1000));
    writeFileSync(join(args.nativeDir, "exit.json"), JSON.stringify({ blockMeshExit: 0, offbeatExit: 139, finalTime: 0.10000000000000184 }));
    return { cancelled: false };
  }
  async cancel() {}
}

const manager = (extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-indep-")), backend: new SavedPulseBackend(), ...extra });

describe("a run verified in a worker is the run verified in this thread", () => {
  it("completes, the results are exactly what buildTransientResults gives in this thread, and the notes say where the checks ran", async () => {
    const m = manager();
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("completed");
    expect(rec.notes.join(" ")).toMatch(/independent finite-volume runs took [\d.]+ s in a worker thread/);
    const detail = m.detail(s.id)!;
    const dir = join((m as any).opts.runsRoot, s.id);
    const C = readFileSync(join(dir, "native", "final", "C"), "utf8");
    const tdir = join(dir, "native", "times");
    const fields = readdirSync(tdir).sort((a, b) => Number(a) - Number(b)).map((d) => ({ time: Number(d), T: readFileSync(join(tdir, d, "T"), "utf8") }));
    const inThread = buildTransientResults(detail.normalized, { C, fields });
    expect(m.results(s.id)).toEqual(JSON.parse(JSON.stringify(inThread)));
  }, 60_000);

  it("a run with no compiled worker still completes and says the checks ran in the server's own thread", async () => {
    const m = manager({ independent: new IndependentRunner({ deadlineMs: 60_000, workerFile: null }) });
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("completed");
    expect(rec.notes.join(" ")).toMatch(/server's own thread \(no compiled worker was found, so no deadline applied\)/);
  }, 60_000);
});

describe("the answer of the independent runs is what the checks use", () => {
  it("a set whose same-mesh run is 5 K off makes the cross-check fail (so the results are not recomputed behind its back)", async () => {
    const stub = {
      start: (c: any) => {
        const set = computeIndependent(c);
        for (const s of set.fv.states) s.T = s.T.map((x) => x + 5);
        return { done: Promise.resolve({ ok: true, what: "full", set, mode: "worker", ms: 1 }), cancel: () => undefined };
      },
    } as unknown as IndependentRunner;
    const m = manager({ independent: stub });
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    expect((await m.done(s.id)).state).toBe("completed");
    const res: any = m.results(s.id);
    expect(res.checks.find((c: any) => c.id === "crossCheckFv").verdict).toBe("fail");
    expect(res.checks.find((c: any) => c.id === "crossCheckFv").value).toBeGreaterThan(4);
  }, 60_000);
});

describe("a deadline the checks cannot meet", () => {
  it("fails the run with E_VERIFY_INCOMPLETE, says what to do, writes no results, and keeps the solver's output", async () => {
    const m = manager({ independentDeadlineMs: 1 });
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_VERIFY_INCOMPLETE");
    expect(rec.failure!.message).toMatch(/could not be verified/);
    expect(rec.failure!.message).toMatch(/did not finish within 0\.001 s/);
    expect(rec.failure!.message).toMatch(/coarser mesh or a longer time step, or raise the deadline/);
    expect(m.results(s.id)).toBeUndefined();
    const dir = join((m as any).opts.runsRoot, s.id);
    expect(existsSync(join(dir, "results.json"))).toBe(false);
    expect(existsSync(join(dir, "native", "final", "T"))).toBe(true); // the solver's output stays
  }, 60_000);

  it("a failing worker is the same refusal, not a crash or a result", async () => {
    const m = manager({ independent: new IndependentRunner({ deadlineMs: 60_000, workerFile: join(root, "dist", "core", "nope.js") }) });
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_VERIFY_INCOMPLETE");
  }, 60_000);
});

describe("cancel during the verification", () => {
  it("stops the independent runs and ends the run cancelled, with no result", async () => {
    let started = false;
    let cancelled = false;
    let release!: (o: any) => void;
    const stub = {
      start: () => {
        started = true;
        const done = new Promise((res) => (release = res));
        return { done, cancel: () => ((cancelled = true), release({ ok: false, reason: "cancelled", message: "cancelled", ms: 0 })) };
      },
    } as unknown as IndependentRunner;
    const m = manager({ independent: stub });
    const s = m.start(pulse());
    if (!s.ok) throw new Error("refused");
    for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    expect(m.get(s.id)!.state).toBe("running");
    await m.cancel(s.id);
    const rec = await m.done(s.id);
    expect(cancelled).toBe(true);
    expect(rec.state).toBe("cancelled");
    expect(rec.failure!.code).toBe("E_CANCELLED");
    expect(rec.failure!.message).toMatch(/while the result was being checked/);
    expect(m.results(s.id)).toBeUndefined();
  }, 30_000);
});

/** Occupy every thread of the server's shared runner with a long job, so a request has to wait for a slot; returns a function that frees them. */
function saturate(): () => void {
  const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse.json"), "utf8"));
  d.mesh = { fuelCells: 100, claddingCells: 30 };
  d.transient.endTime = { value: 100, unit: "ms" };
  d.transient.timeStep = { value: 100 / 23000, unit: "ms" };
  d.transient.outputs = 23;
  const c = validateCase(d).normalized!;
  const holds = [0, 1, 2].map(() => independent.start(c, { what: "full" }));
  return () => holds.forEach((h) => h.cancel());
}
const until = async (f: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return f();
};

describe("the editor's preview", () => {
  it("through the worker it is the preview this thread gives", async () => {
    const sync: any = check(pulse());
    const viaWorker: any = await checkAsync(pulse());
    expect(viaWorker.transient.preview).toEqual(sync.transient.preview);
    expect(viaWorker.transient.previewSkipped).toBeNull();
    expect(viaWorker.transient.adiabaticPeak).toBe(sync.transient.adiabaticPeak);
  }, 30_000);

  it("a preview that cannot finish in its deadline is skipped, with the reason, and the rest of the check is intact", async () => {
    const j: any = await checkAsync(pulse(), 1);
    expect(j.ok).toBe(true);
    expect(j.transient.preview).toBeNull();
    expect(j.transient.previewSkipped).toMatch(/preview was skipped: .* did not finish within 0\.001 s/);
    expect(j.transient.adiabaticPeak).toBeGreaterThan(300);
  }, 30_000);

  it("the preview is the answer that was supplied, not one computed again (a supplied run 5 K hotter shows in the curve)", () => {
    const v = validateCase(pulse()).normalized!;
    const fv = independentSolution(v);
    for (const s of fv.states) s.T = s.T.map((x) => x + 5);
    const p = transientPreview(v, { fv });
    const q = transientPreview(v);
    expect(p.preview!.peakT[0]).toBeCloseTo(q.preview!.peakT[0]! + 5, 9);
    expect(transientPreview(v, { fv: null, skipped: "because" })).toMatchObject({ preview: null, previewSkipped: "because" });
  });

  it("a newer preview replaces one still waiting for a thread: the older request is answered, skipped, with the reason", async () => {
    const free = saturate();
    try {
      const first = checkAsync(pulse());
      await until(() => independent.activity().queued === 1);
      const second = checkAsync(pulse());
      const a: any = await first;
      expect(a.ok).toBe(true);
      expect(a.transient.preview).toBeNull();
      expect(a.transient.previewSkipped).toMatch(/a newer edit replaced this preview before it started/);
      free();
      const b: any = await second;
      expect(b.transient.preview).not.toBeNull();
    } finally {
      free();
    }
  }, 30_000);

  it("the HTTP handler waits for the runner: with every thread busy a /api/check request is queued, then answered when one is free", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const free = saturate();
    try {
      const req = fetch(base + "/api/check", { method: "POST", headers: { "content-type": "application/json", "x-feed-client": "1" }, body: JSON.stringify(pulse()) });
      expect(await until(() => independent.activity().queued === 1)).toBe(true);
      free();
      const j: any = await (await req).json();
      expect(j.ok).toBe(true);
      expect(j.transient.preview).not.toBeNull();
    } finally {
      free();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("a steady case and an invalid case are answered without a worker", async () => {
    expect((await checkAsync(JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8")))).ok).toBe(true);
    const bad: any = await checkAsync({ schema: "feed.case/0.1" });
    expect(bad.ok).toBe(false);
  });

  it("a generated pulse's integrated curve is not sent on every check (the editor uses the downsampled one in the preview)", async () => {
    const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse-kinetics.json"), "utf8"));
    const j: any = await checkAsync(d);
    expect(j.ok).toBe(true);
    expect(j.normalized.transient.generated.trace.time).toEqual([]);
    expect(j.normalized.transient.generated.summary.peakPower).toBeGreaterThan(1e8);
    expect(j.transient.generator.curve.time.length).toBeGreaterThan(50);
    expect(JSON.stringify(j).length).toBeLessThan(300_000);
    expect(validateCase(d).normalized!.transient!.generated!.trace.time.length).toBeGreaterThan(1000); // the full curve is still there for the results
  }, 30_000);
});
