// Plan 15, B4: the two-dimensional reference of a transient stack of plates in a worker thread, with a deadline (src/core/independentRunner.ts, what: "stackReference"), and what the
// run manager does with the answer. Needs `npm run build` (the compiled worker), like tests/independentRunner.test.ts.
// Limits fixed here before the first run, with their reasons:
//   SAME             the worker's solution, and the record built from it, EQUAL the in-thread ones exactly (toEqual): the same code on the same numbers; a structured clone keeps every double.
//   DEADLINE         a job of about 3.5 s (50 slices, 26 cells, 2300 steps) against 150 ms: nothing about the machine's load lets it finish, as in independentRunner.test.ts.
//   NOT STUCK        the thread is gone and no timer is left after a deadline or a cancel (the runner's own tests ask the same).
//   CAPS             the two caps (3e6 unknown-steps, 4e8 band work) are asked with cases that are over them by a factor of 1.3 and 1.9; nothing is solved for them.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { IndependentRunner } from "../src/core/independentRunner";
import { BackendOutcome, RunBackend, RunManager } from "../src/core/runManager";
import { STACK_TRANSIENT_BAND_WORK_MAX, STACK_TRANSIENT_WORK_MAX, solveStackTransientReference, stackTransientReference, stackTransientReferenceFrom, stackTransientWork } from "../src/core/stackReference";
import { buildStackTransientResults, computeIndependentStack } from "../src/core/stackTransientResults";
import { NormalizedCase, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const example = () => JSON.parse(readFileSync(join(root, "examples", "synthetic-plate-loss-of-cooling.json"), "utf8"));
const goldenDir = join(root, "tests", "golden", "examples", "synthetic-plate-loss-of-cooling");

/** The loss-of-cooling plate on a stack and a step count of our choosing (the histories run to the end time). */
function plate(slices: number, steps: number, fuel = 20, clad = 6, kT = false): NormalizedCase {
  const d = example();
  d.axial.slices = slices;
  d.mesh = { fuelCells: fuel, claddingCells: clad };
  d.transient.timeStep = { value: 60 / steps, unit: "s" };
  d.transient.outputs = 20;
  if (kT) {
    const range = { min: { value: 250, unit: "K" }, max: { value: 4000, unit: "K" } };
    d.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: { value: 4, unit: "W/m/K" }, b: { value: -0.0004, unit: "W/m/K2" }, validRange: range, source: "synthetic" };
  }
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
}
const small = () => plate(10, 1200);
/** About 3.5 s of work in one thread. */
const big = () => plate(50, 2300);
const waitFor = async (f: () => boolean, ms = 1500) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return f();
};

const golden = () => {
  const n = JSON.parse(readFileSync(join(goldenDir, "normalized.json"), "utf8"));
  const times = readdirSync(join(goldenDir, "times")).sort((a, b) => Number(a) - Number(b));
  return { n, C: readFileSync(join(goldenDir, "C"), "utf8"), fields: times.map((t) => ({ time: Number(t), T: readFileSync(join(goldenDir, "times", t, "T"), "utf8") })) };
};

describe("the work a reference may cost", () => {
  it("the size of a case: unknowns, steps, the unknown-steps and the work of the banded solves", () => {
    expect(stackTransientWork(small())).toEqual({ unknowns: 260, steps: 1200, work: 312000, bandWork: 260 * 26 * 1200 });
    const pulse = validateCase(JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse.json"), "utf8"))).normalized!;
    expect(stackTransientWork(pulse)).toBeUndefined(); // not a stack
  });

  it("more unknown-steps than the cap: nothing is solved, and the reason says the numbers", () => {
    const c = JSON.parse(JSON.stringify(small())) as NormalizedCase;
    c.axial!.slices = 50;
    c.transient!.steps = 3000; // 1300 unknowns x 3000 = 3.9e6, 1.3 times the cap
    const r = solveStackTransientReference(c);
    expect(r).toEqual({ fallback: expect.stringMatching(/1300 unknowns x 3000 steps is more than the 3000000 the reference solves/) });
    expect(stackTransientReference(c)).toEqual(r);
  });

  it("more banded-solve work than the cap (few layers of very many cells): nothing is solved, and the reason says the work", () => {
    const c = JSON.parse(JSON.stringify(small())) as NormalizedCase;
    c.axial!.slices = 4;
    c.mesh = { ...c.mesh, fuelCells: 200, claddingCells: 50 };
    c.transient!.steps = 3000; // 1000 unknowns x 250 x 3000 = 7.5e8, 1.9 times the cap, while the unknown-steps (3e6) are at the other cap
    const r = solveStackTransientReference(c);
    expect(r).toEqual({ fallback: expect.stringMatching(/1000 unknowns x 250 cells per layer x 3000 steps is more work \(7\.50e\+8\) than the 4e\+8/) });
    expect(STACK_TRANSIENT_BAND_WORK_MAX).toBe(4e8);
    expect(STACK_TRANSIENT_WORK_MAX).toBe(3e6);
  });

  it("the largest stack the validator allows (50 slices, 26 cells) is under both caps", () => {
    const w = stackTransientWork(big())!;
    expect(w.work).toBeLessThanOrEqual(STACK_TRANSIENT_WORK_MAX);
    expect(w.bandWork).toBeLessThanOrEqual(STACK_TRANSIENT_BAND_WORK_MAX);
  });
});

describe("the worker gives the numbers this thread gives", () => {
  it("the solution (every state, every trace), the start and its distance from the coupled steady state are equal", async () => {
    const c = small();
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const out = await r.start(c, { what: "stackReference" }).done;
    expect(out.ok).toBe(true);
    if (!out.ok || out.what !== "stackReference") return;
    expect(out.mode).toBe("worker");
    expect("solved" in out.set).toBe(true);
    const here = solveStackTransientReference(c);
    expect(out.set).toEqual(here);
  }, 30_000);

  it("the record built from the worker's solution equals the one built from this thread's, on the saved OFFBEAT output", async () => {
    const { n, C, fields } = golden();
    const sets = computeIndependentStack(n);
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const out = await r.start(n, { what: "stackReference" }).done;
    if (!out.ok || out.what !== "stackReference" || !("solved" in out.set)) throw new Error("the worker did not solve");
    const viaWorker = buildStackTransientResults(n, { C, fields }, sets, { reference: stackTransientReferenceFrom(n, out.set.solved) });
    const inThread = buildStackTransientResults(n, { C, fields }, sets, stackTransientReference(n));
    expect(viaWorker).toEqual(inThread);
    expect(viaWorker.axial.reference).toMatchObject({ kind: "two-dimensional" });
    expect(viaWorker.checks.filter((x) => x.verdict === "fail")).toEqual([]);
  }, 60_000);

  it("with no compiled worker the job runs in this thread, says so, and gives the same solution", async () => {
    const c = small();
    const r = new IndependentRunner({ deadlineMs: 60_000, workerFile: null });
    const out = await r.start(c, { what: "stackReference" }).done;
    expect(out).toMatchObject({ ok: true, what: "stackReference", mode: "in-process" });
    if (out.ok) expect(out.set).toEqual(solveStackTransientReference(c));
  }, 30_000);
});

describe("the deadline", () => {
  it("stops a reference that is too slow: the outcome names the reference, and the thread is gone", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const t0 = Date.now();
    const out = await r.start(big(), { what: "stackReference", deadlineMs: 150 }).done;
    expect(out).toMatchObject({ ok: false, reason: "deadline" });
    if (out.ok) return;
    expect(out.message).toMatch(/the two-dimensional reference did not finish within 0\.150 s and was stopped/);
    expect(Date.now() - t0).toBeLessThan(2500); // not the 3.5 s the work needs
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
    expect(r.timersPending()).toBe(0);
    expect(r.activity()).toEqual({ running: 0, queued: 0 });
  }, 20_000);

  it("the runner is not poisoned by it: the next reference completes", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    await r.start(big(), { what: "stackReference", deadlineMs: 100 }).done;
    const out = await r.start(small(), { what: "stackReference" }).done;
    expect(out.ok).toBe(true);
  }, 30_000);

  it("without a worker the solver's own deadline is enforced: the answer is a fallback with the step it stopped at, not an error", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000, workerFile: null });
    const t0 = Date.now();
    const out = await r.start(big(), { what: "stackReference", deadlineMs: 150 }).done;
    expect(out).toMatchObject({ ok: true, mode: "in-process" });
    if (!out.ok || out.what !== "stackReference") return;
    expect(out.set).toEqual({ fallback: expect.stringMatching(/the two-dimensional reference could not be computed: the stack's transient did not finish in 150 ms \(stopped at step \d+ of 2300\)/) });
    expect(Date.now() - t0).toBeLessThan(2500);
  }, 20_000);
});

describe("cancel", () => {
  it("a running reference: the thread is terminated and the outcome is cancelled", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const h = r.start(big(), { what: "stackReference" });
    await new Promise((x) => setTimeout(x, 200));
    expect(r.liveThreads()).toBe(1);
    h.cancel();
    expect(await h.done).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
    expect(r.timersPending()).toBe(0);
  }, 20_000);
});

describe("a failing worker is reported, not thrown", () => {
  it("a worker file that is not there: the outcome is worker-failed and says it is the reference", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000, workerFile: join(root, "dist", "core", "nope.js") });
    const out = await r.start(small(), { what: "stackReference" }).done;
    expect(out).toMatchObject({ ok: false, reason: "worker-failed" });
  });
});

describe("the fallback is in the record", () => {
  it("a reference that could not be made gives the allowance, and the record says why", () => {
    const { n, C, fields } = golden();
    const reason = "the two-dimensional reference did not finish within 60 s and was stopped";
    const rec = buildStackTransientResults(n, { C, fields }, computeIndependentStack(n), { fallback: reason });
    expect(rec.axial.reference).toEqual({ kind: "allowance", reason });
    expect(rec.axial.allowance.field).toBeGreaterThan(0);
    const note = rec.checks.find((x) => x.id === "axialConduction")!.note;
    expect(note).toMatch(/per-slice cross-check is widened by/);
  }, 30_000);
});

// ---- through the run manager ---------------------------------------------------------------------------------------------------------------------------------------

/** The converged outer iterations OFFBEAT prints, for each of n steps (the saved output has no log). */
const convergedStepsLog = (n: number, dt: number) =>
  Array.from({ length: n }, (_, i) =>
    ["Time = " + (i + 1) * dt + " s", "", "OuterIteration n. 0", "FDICPCG:  Solving for T, Initial residual = 1e-3, Final residual = 1e-5, No Iterations 2", "relResidualT is 1", "absErrT is 5", "", "OuterIteration n. 1", "FDICPCG:  Solving for T, Initial residual = 1e-12, Final residual = 1e-13, No Iterations 1", "relResidualT is 1e-12", "absErrT is 1e-12", ""].join("\n"),
  ).join("\n");
/** "Runs" by copying a saved OFFBEAT output into the native folder (the loss-of-cooling plate of the examples, or a pin stack's pulse). */
class SavedBackend implements RunBackend {
  constructor(private dir = goldenDir, private steps = 1200, private dt = 0.05) {}
  async run(args: { nativeDir: string }): Promise<BackendOutcome> {
    mkdirSync(join(args.nativeDir, "final"), { recursive: true });
    cpSync(join(this.dir, "C"), join(args.nativeDir, "final", "C"));
    cpSync(join(this.dir, "times"), join(args.nativeDir, "times"), { recursive: true });
    const last = readdirSync(join(this.dir, "times")).sort((x, y) => Number(x) - Number(y)).pop()!;
    cpSync(join(this.dir, "times", last, "T"), join(args.nativeDir, "final", "T"));
    writeFileSync(join(args.nativeDir, "log.offbeat"), convergedStepsLog(this.steps, this.dt));
    writeFileSync(join(args.nativeDir, "exit.json"), JSON.stringify({ blockMeshExit: 0, offbeatExit: 139, finalTime: Number(last) }));
    return { cancelled: false };
  }
  async cancel() {}
}
const manager = (extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) => new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-stackref-")), backend: new SavedBackend(), ...extra });
/** A runner that answers a reference job with `reference` and every other job with the real runner. */
const runnerWith = (reference: (c: NormalizedCase) => { done: Promise<any>; cancel: () => void }) => {
  const real = new IndependentRunner({ deadlineMs: 60_000 });
  return { start: (c: NormalizedCase, o: any = {}) => (o.what === "stackReference" ? reference(c) : real.start(c, o)) } as unknown as IndependentRunner;
};

describe("a plate stack run through the manager", () => {
  it("is judged against the reference solved in a worker: the record equals the in-thread one, and the notes say where it ran", async () => {
    const m = manager();
    const s = m.start(example());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("completed");
    expect(rec.notes.join(" ")).toMatch(/two-dimensional reference of the stack took [\d.]+ s in a worker thread/);
    const dir = join((m as any).opts.runsRoot, s.id);
    const n = JSON.parse(readFileSync(join(dir, "normalized.json"), "utf8"));
    const C = readFileSync(join(dir, "native", "final", "C"), "utf8");
    const tdir = join(dir, "native", "times");
    const fields = readdirSync(tdir).sort((a, b) => Number(a) - Number(b)).map((d) => ({ time: Number(d), T: readFileSync(join(tdir, d, "T"), "utf8") }));
    const inThread = buildStackTransientResults(n, { C, fields });
    const res: any = m.results(s.id);
    expect(res).toEqual(JSON.parse(JSON.stringify(inThread)));
    expect(res.axial.reference.kind).toBe("two-dimensional");
    expect(res.checks.filter((x: any) => x.verdict === "fail")).toEqual([]);
  }, 120_000);

  it("a reference that passes its deadline does not fail the run: the checks keep the allowance, the record and the notes give the reason", async () => {
    const reason = "the two-dimensional reference did not finish within 60 s and was stopped";
    const m = manager({ independent: runnerWith(() => ({ done: Promise.resolve({ ok: false, reason: "deadline", message: reason, ms: 60000 }), cancel: () => undefined })) });
    const s = m.start(example());
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("completed");
    const res: any = m.results(s.id);
    expect(res.axial.reference).toEqual({ kind: "allowance", reason });
    expect(res.axial.allowance.field).toBeGreaterThan(0);
    expect(rec.notes.join(" ")).toContain(reason);
    expect(rec.notes.join(" ")).toMatch(/the checks keep the allowance/);
  }, 120_000);

  it("a reference that the solver refuses (a cap, a solver failure) is the same: an answer with the reason, the allowance, a completed run", async () => {
    const m = manager({ independent: runnerWith(() => ({ done: Promise.resolve({ ok: true, what: "stackReference", set: { fallback: "the two-dimensional reference could not be computed: boom" }, mode: "worker", ms: 5 }), cancel: () => undefined })) });
    const s = m.start(example());
    if (!s.ok) throw new Error("refused");
    expect((await m.done(s.id)).state).toBe("completed");
    expect((m.results(s.id) as any).axial.reference).toEqual({ kind: "allowance", reason: "the two-dimensional reference could not be computed: boom" });
  }, 120_000);

  it("a worker that fails is the same", async () => {
    const m = manager({ independent: runnerWith(() => ({ done: Promise.resolve({ ok: false, reason: "worker-failed", message: "the two-dimensional reference failed: the worker thread failed: x", ms: 5 }), cancel: () => undefined })) });
    const s = m.start(example());
    if (!s.ok) throw new Error("refused");
    expect((await m.done(s.id)).state).toBe("completed");
    expect((m.results(s.id) as any).axial.reference.kind).toBe("allowance");
  }, 120_000);

  it("cancel during the reference stops it too, and the run ends cancelled with no result", async () => {
    let cancelled = false;
    let release!: (o: any) => void;
    let started = false;
    const m = manager({
      independent: runnerWith(() => {
        started = true;
        const done = new Promise((res) => (release = res));
        return { done, cancel: () => ((cancelled = true), release({ ok: false, reason: "cancelled", message: "cancelled", ms: 0 })) };
      }),
    });
    const s = m.start(example());
    if (!s.ok) throw new Error("refused");
    for (let i = 0; i < 400 && !started; i++) await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    await m.cancel(s.id);
    const rec = await m.done(s.id);
    expect(cancelled).toBe(true);
    expect(rec.state).toBe("cancelled");
    expect(rec.failure!.code).toBe("E_CANCELLED");
    expect(m.results(s.id)).toBeUndefined();
    expect(existsSync(join((m as any).opts.runsRoot, s.id, "results.json"))).toBe(false);
  }, 60_000);

  it("a pin stack starts no reference job: only the one-dimensional runs are asked for, and its record has no reference section (the pin keeps the allowance)", async () => {
    const asked: string[] = [];
    const real = new IndependentRunner({ deadlineMs: 60_000 });
    const spy = { start: (c: NormalizedCase, o: any = {}) => (asked.push(o.what), real.start(c, o)) } as unknown as IndependentRunner;
    const doc = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse-operating.json"), "utf8"));
    doc.axial = { length: { value: 0.381, unit: "m" }, slices: 10, powerShape: { kind: "cosine" } };
    const m = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-stackref-")), backend: new SavedBackend(join(root, "tests", "golden", "offbeat-stack-transient", "pulse"), 1000, 1e-4), independent: spy });
    const s = m.start(doc);
    if (!s.ok) throw new Error("refused");
    const rec = await m.done(s.id);
    expect(rec.state).toBe("completed");
    expect(asked).toEqual(["full"]);
    expect((m.results(s.id) as any).axial.reference).toBeUndefined();
    expect(rec.notes.join(" ")).not.toMatch(/two-dimensional reference/);
  }, 120_000);
});
