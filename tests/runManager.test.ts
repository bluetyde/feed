import type { ResultsRecord } from "../src/core/resultsParser";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { convergedLog, FakeBackend, Script } from "./helpers/fakeBackend";

const root = join(__dirname, "..");
const pin = () => JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8"));
const dirs: string[] = [];
const make = (script: Script | ((n: number) => Script), timeoutMs?: number) => {
  const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
  dirs.push(runsRoot);
  const backend = new FakeBackend(script);
  return { runsRoot, backend, mgr: new RunManager({ runsRoot, backend, timeoutMs }) };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const runOne = async (script: Script) => {
  const t = make(script);
  const s = t.mgr.start(pin());
  if (!s.ok) throw new Error("start refused");
  const rec = await t.mgr.done(s.id);
  return { ...t, id: s.id, rec };
};

describe("run manager: classification by output", () => {
  it("completed: complete output accepted even when the solver exited 139 (known shutdown crash)", async () => {
    const { rec, mgr, id } = await runOne("good");
    expect(rec.state).toBe("completed");
    expect(rec.exitCode).toBe(139);
    expect(rec.notes.join(" ")).toMatch(/SIGSEGV.*complete output/);
    const res = mgr.results(id)! as ResultsRecord;
    expect(res.summary.centreCellT).toBeCloseTo(1307.2076, 3);
    expect(res.thermalOnly).toMatch(/Thermal-only/);
  });

  it("completed with a clean exit has no abnormal-exit note", async () => {
    const { rec } = await runOne("good-exit-0");
    expect(rec.state).toBe("completed");
    expect(rec.notes).toEqual([]);
  });

  const failures: [Script, string, RegExp][] = [
    ["fatal", "E_APP_FAILED", /stopped before writing any result \(exit 1\)/],
    ["sigabrt", "E_APP_FAILED", /SIGABRT/],
    ["sigfpe", "E_APP_FAILED", /SIGFPE/],
    ["mesh-fails", "E_APP_FAILED", /mesh could not be built/],
    ["no-exit-record", "E_APP_FAILED", /no exit record/],
    ["infra-error", "E_APP_FAILED", /could not run the case: wsl.exe not found/],
    ["early-end", "E_OUTPUT_INCOMPLETE", /stopped at 1000 s, before the intended 50000000 s/],
    ["truncated", "E_OUTPUT_INCOMPLETE", /not a complete result.*(not closed|truncated)/],
    ["nan", "E_OUTPUT_INCOMPLETE", /not a complete result.*not finite/],
  ];
  for (const [script, code, msg] of failures) {
    it(`${script}: failed with ${code}, never a result`, async () => {
      const { rec, mgr, id } = await runOne(script);
      expect(rec.state).toBe("failed");
      expect(rec.failure!.code).toBe(code);
      expect(rec.failure!.message).toMatch(msg);
      expect(mgr.results(id)).toBeUndefined();
    });
  }

  it("keeps the solver's own words for a native failure", async () => {
    const { rec } = await runOne("fatal");
    expect(rec.failure!.native).toMatch(/FOAM FATAL IO ERROR/);
    expect(rec.failure!.native).toMatch(/keyword lhgr is undefined/);
  });
});

describe("run manager: run directory and records", () => {
  it("snapshots the case with hashes under the run id and writes results.json", async () => {
    const { runsRoot, id } = await runOne("good");
    const dir = join(runsRoot, id);
    for (const f of ["inputs/case.json", "inputs/constant/solverDict", "inputs/0/T", "feed-manifest.json", "normalized.json", "run.json", "results.json", "native/exit.json"]) expect(existsSync(join(dir, f)), f).toBe(true);
    const man = JSON.parse(readFileSync(join(dir, "feed-manifest.json"), "utf8"));
    expect(Object.keys(man.files)).toContain("constant/solverDict");
    expect(man.caseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(man.choices.endTime).toBe(5e7);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).state).toBe("completed");
  });

  it("refuses an invalid case without creating a run", () => {
    const { mgr, runsRoot } = make("good");
    const d = pin();
    delete d.boundary.heatTransferCoefficient;
    const s = mgr.start(d);
    expect(s.ok).toBe(false);
    expect(s.ok === false && s.errors.map((e) => e.code)).toEqual(["E_BOUNDARY_INCOMPLETE"]);
    expect(readdirSync(runsRoot)).toEqual([]);
  });

  it("accepts a temperature-dependent conductivity case and snapshots the converted coefficients", async () => {
    const t = make("good");
    const d = JSON.parse(readFileSync(join(root, "schema/vectors/good/linear-conductivity.json"), "utf8"));
    const s = t.mgr.start(d);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(readFileSync(join(t.runsRoot, s.id, "inputs/constant/solverDict"), "utf8")).toMatch(/par1 3\.83611; par2 -0\.0006;/);
    await t.mgr.done(s.id);
  });

  it("run ids are 12 hex characters and unique", () => {
    const { mgr } = make("hang");
    const a = mgr.start(pin());
    const b = mgr.start(pin());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.id).toMatch(/^[0-9a-f]{12}$/);
      expect(a.id).not.toBe(b.id);
    }
  });
});

describe("run manager: queue, cancel, timeout, recovery", () => {
  it("runs one at a time, in order", async () => {
    const t = make("good");
    const a = t.mgr.start(pin());
    const b = t.mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    expect(t.mgr.get(b.id)!.state).toBe("queued");
    await t.mgr.done(a.id);
    await t.mgr.done(b.id);
    expect(t.backend.runs).toEqual([a.id, b.id]);
  });

  it("cancels a queued run without starting it", async () => {
    const t = make("hang");
    const a = t.mgr.start(pin());
    const b = t.mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    const rec = await t.mgr.cancel(b.id);
    expect(rec!.state).toBe("cancelled");
    expect(rec!.failure!.code).toBe("E_CANCELLED");
    await t.mgr.cancel(a.id);
    await t.mgr.done(a.id);
    expect(t.backend.runs).toEqual([a.id]);
  });

  it("cancels a running run: state cancelled, no result", async () => {
    const t = make("hang");
    const a = t.mgr.start(pin());
    if (!a.ok) throw new Error();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.mgr.get(a.id)!.state).toBe("running");
    await t.mgr.cancel(a.id);
    const rec = await t.mgr.done(a.id);
    expect(rec.state).toBe("cancelled");
    expect(rec.failure!.code).toBe("E_CANCELLED");
    expect(t.backend.cancels).toEqual([a.id]);
    expect(t.mgr.results(a.id)).toBeUndefined();
  });

  it("a cancelled run never turns into a result even if the solver had output", async () => {
    const t = make((n) => (n === 0 ? "hang" : "good"));
    const a = t.mgr.start(pin());
    if (!a.ok) throw new Error();
    await new Promise((r) => setTimeout(r, 20));
    await t.mgr.cancel(a.id);
    expect((await t.mgr.done(a.id)).state).toBe("cancelled");
  });

  it("times out a hung run: failed with E_TIMEOUT and the backend is asked to stop it", async () => {
    const t = make("hang", 80);
    const a = t.mgr.start(pin());
    if (!a.ok) throw new Error();
    const rec = await t.mgr.done(a.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_TIMEOUT");
    expect(t.backend.cancels).toEqual([a.id]);
  });

  it("the next run starts after a failed one", async () => {
    const t = make((n) => (n === 0 ? "fatal" : "good"));
    const a = t.mgr.start(pin());
    const b = t.mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    expect((await t.mgr.done(a.id)).state).toBe("failed");
    expect((await t.mgr.done(b.id)).state).toBe("completed");
  });

  it("a restarted manager marks runs left queued or running as interrupted, and keeps finished ones", async () => {
    const t = make("good");
    const done = t.mgr.start(pin());
    if (!done.ok) throw new Error();
    await t.mgr.done(done.id);
    // simulate a crash mid-run: a run.json left in state running
    const stale = JSON.parse(readFileSync(join(t.runsRoot, done.id, "run.json"), "utf8"));
    stale.id = "aaaaaaaaaaaa";
    stale.state = "running";
    delete stale.endedAt;
    const staleDir = join(t.runsRoot, stale.id);
    const { mkdirSync } = await import("fs");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "run.json"), JSON.stringify(stale));
    const fresh = new RunManager({ runsRoot: t.runsRoot, backend: new FakeBackend("good") });
    expect(fresh.get(stale.id)!.state).toBe("interrupted");
    expect(fresh.get(stale.id)!.notes.join(" ")).toMatch(/No result was collected/);
    expect(fresh.get(done.id)!.state).toBe("completed");
    expect(fresh.results(stale.id)).toBeUndefined();
  });
});

describe("run manager: cleanup policy", () => {
  const makeMax = (maxRuns: number, script: Script | ((n: number) => Script) = "good") => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
    dirs.push(runsRoot);
    return { runsRoot, backend: new FakeBackend(script), mk: (backend: FakeBackend) => new RunManager({ runsRoot, backend, maxRuns }) };
  };

  it("keeps only the newest maxRuns finished runs and deletes the oldest directories", async () => {
    const t = makeMax(3);
    const mgr = t.mk(t.backend);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = mgr.start(pin());
      if (!s.ok) throw new Error();
      ids.push(s.id);
      await mgr.done(s.id);
      await new Promise((r) => setTimeout(r, 3)); // distinct createdAt
    }
    const left = readdirSync(t.runsRoot).sort();
    expect(left.length).toBe(3);
    expect(left).toEqual(ids.slice(2).sort());
    expect(mgr.get(ids[0]!)).toBeUndefined();
    expect(mgr.get(ids[4]!)!.state).toBe("completed");
  });

  it("never deletes a queued or running run, even over the limit", async () => {
    const t = makeMax(1, "hang");
    const mgr = t.mk(t.backend);
    const a = mgr.start(pin());
    const b = mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    await new Promise((r) => setTimeout(r, 30));
    expect(mgr.prune()).toEqual([]);
    expect(readdirSync(t.runsRoot).length).toBe(2);
    const waits = [mgr.done(a.id), mgr.done(b.id)]; // register before cancelling: finished runs may be pruned at once
    await mgr.cancel(b.id);
    await mgr.cancel(a.id);
    await Promise.all(waits);
    expect(readdirSync(t.runsRoot).length).toBe(1); // both finished; the limit applies again
  });

  it("only removes run directories: other folders and files in the runs root are left alone", async () => {
    const t = makeMax(1);
    const { mkdirSync } = await import("fs");
    mkdirSync(join(t.runsRoot, "keep-me"), { recursive: true });
    writeFileSync(join(t.runsRoot, "notes.txt"), "x");
    mkdirSync(join(t.runsRoot, "abcdef012345"), { recursive: true });
    writeFileSync(join(t.runsRoot, "abcdef012345", "run.json"), "not json");
    const mgr = t.mk(t.backend);
    for (let i = 0; i < 3; i++) {
      const s = mgr.start(pin());
      if (!s.ok) throw new Error();
      await mgr.done(s.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    const left = readdirSync(t.runsRoot);
    expect(left).toContain("keep-me");
    expect(left).toContain("notes.txt");
    expect(left).toContain("abcdef012345"); // unreadable run.json: not ours to delete
  });

  it("prunes on start-up too", async () => {
    const t = makeMax(2);
    const first = t.mk(t.backend);
    for (let i = 0; i < 4; i++) {
      const s = first.start(pin());
      if (!s.ok) throw new Error();
      await first.done(s.id);
      await new Promise((r) => setTimeout(r, 3));
    }
    // a manager with a smaller limit prunes when it starts
    const second = new RunManager({ runsRoot: t.runsRoot, backend: new FakeBackend("good"), maxRuns: 1 });
    expect(readdirSync(t.runsRoot).length).toBe(1);
    expect(second.list().length).toBe(1);
  });
});

describe("run manager: Codex review findings", () => {
  it("#1 an error while reading native output fails the run instead of leaving it running", async () => {
    const t = make("log-is-dir");
    const s = t.mgr.start(pin());
    if (!s.ok) throw new Error();
    const rec = await Promise.race([t.mgr.done(s.id), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("run never settled; state " + t.mgr.get(s.id)?.state)), 2000))]);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.failure!.message).toMatch(/EISDIR|illegal operation|Reading the solver output failed|could not be classified/i);
    expect(t.mgr.results(s.id)).toBeUndefined();
  });

  it("#1 the manager keeps working after such a failure", async () => {
    const t = make((n) => (n === 0 ? "log-is-dir" : "good"));
    const a = t.mgr.start(pin());
    const b = t.mgr.start(pin());
    if (!a.ok || !b.ok) throw new Error();
    expect((await t.mgr.done(a.id)).state).toBe("failed");
    expect((await t.mgr.done(b.id)).state).toBe("completed");
  });

  it("#4 the shell's own timeout (exit 124) is a timeout failure even when fields were written", async () => {
    const { rec, mgr, id } = await runOne("exit-124");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_TIMEOUT");
    expect(rec.failure!.message).toMatch(/time limit/);
    expect(mgr.results(id)).toBeUndefined();
  });

  it("#4 a solver killed from outside (exit 137) is a failure even when fields were written", async () => {
    const { rec, mgr, id } = await runOne("exit-137");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.failure!.message).toMatch(/killed/i);
    expect(mgr.results(id)).toBeUndefined();
  });

  it("#7 an exit record without the solver exit code is not accepted", async () => {
    const { rec } = await runOne("bad-exit-record");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.message).toMatch(/exit record/);
  });

  it("#7 a manifest without the intended end time is not accepted (a short final time must not pass)", async () => {
    const { rec } = await runOne("no-endtime");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.message).toMatch(/intended end time/);
  });

  it("#9 recovery only trusts a directory whose run.json id matches its name, and prune never deletes another directory", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
    dirs.push(runsRoot);
    const { mkdirSync } = await import("fs");
    mkdirSync(join(runsRoot, "bbbbbbbbbbbb"));
    writeFileSync(join(runsRoot, "bbbbbbbbbbbb", "run.json"), "not json");
    mkdirSync(join(runsRoot, "zz-backup"));
    writeFileSync(join(runsRoot, "zz-backup", "run.json"), JSON.stringify({ id: "bbbbbbbbbbbb", caseId: "x", caseHash: "h", state: "completed", createdAt: "2026-01-01T00:00:00Z", solver: "s", notes: [] }));
    mkdirSync(join(runsRoot, "cccccccccccc"));
    writeFileSync(join(runsRoot, "cccccccccccc", "run.json"), JSON.stringify({ id: "dddddddddddd", caseId: "x", caseHash: "h", state: "completed", createdAt: "2026-01-01T00:00:00Z", solver: "s", notes: [] }));
    const m = new RunManager({ runsRoot, backend: new FakeBackend("good"), maxRuns: 0 });
    expect(readdirSync(runsRoot).sort()).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "zz-backup"]); // nothing deleted
    expect(m.list()).toEqual([]); // neither copy was registered
  });
});

describe("run manager: re-review findings", () => {
  for (const [script, label] of [["status--1", "-1 after a successful mesh"], ["status-0.5", "0.5"], ["status-256", "256"]] as const) {
    it("S5 an impossible solver exit status (" + label + ") is not accepted as a completed run", async () => {
      const { rec, mgr, id } = await runOne(script);
      expect(rec.state).toBe("failed");
      expect(rec.failure!.message).toMatch(/exit (record|status)|never ran/);
      expect(mgr.results(id)).toBeUndefined();
    });
  }

  it("S2 a backend whose cancel throws synchronously cannot crash the timeout handler or strand the run", async () => {
    class ThrowingCancel extends FakeBackend {
      constructor() {
        super("hang");
      }
      override run(a: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }) {
        // the solver ends on its own shortly after the time limit, as the shell timeout would end it
        return new Promise<{ cancelled: boolean }>((resolve) => setTimeout(() => resolve({ cancelled: false }), 250));
      }
      override cancel(_id: string): Promise<void> {
        throw new Error("EACCES: cannot write cancel.flag");
      }
    }
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
    dirs.push(runsRoot);
    const mgr = new RunManager({ runsRoot, backend: new ThrowingCancel(), timeoutMs: 80 });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error();
    const rec = await mgr.done(s.id);
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_TIMEOUT");
    expect(rec.notes.join(" ")).toMatch(/could not be confirmed.*EACCES/);
  });

  it("S2 manager.cancel() with a throwing backend records the problem and does not throw", async () => {
    class ThrowingCancel extends FakeBackend {
      constructor() {
        super("hang");
      }
      override cancel(_id: string): Promise<void> {
        throw new Error("EACCES: cannot write cancel.flag");
      }
    }
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
    dirs.push(runsRoot);
    const backend = new ThrowingCancel();
    const mgr = new RunManager({ runsRoot, backend, timeoutMs: 400 });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error();
    await new Promise((r) => setTimeout(r, 30));
    const rec = await mgr.cancel(s.id);
    expect(rec!.notes.join(" ")).toMatch(/Cancel could not confirm.*EACCES/);
    // the run is still running: nothing claimed it stopped. The time limit then ends it.
    expect(["running", "failed"]).toContain(mgr.get(s.id)!.state);
  });
});

// F0 exit review, finding 2: complete, finite output at the intended end time is NOT a result unless the solver converged, and only
// exit 0 and the demonstrated shutdown crash (139) are accepted. The logs are real OFFBEAT logs from the non-convergence probe.
describe("run manager: convergence and exit status (F0 finding 2)", () => {
  it("a converged run that exits 139 after its last write is a result (the baseline for the cases below)", async () => {
    const { rec, mgr, id } = await runOne("good");
    expect(rec.state).toBe("completed");
    expect(mgr.results(id)).toBeDefined();
  });

  it("THE PROBE CASE: the last step hit the iteration cap unconverged, the output is complete and the exit is 139, yet the run FAILS and yields no result", async () => {
    const { rec, mgr, id, runsRoot } = await runOne("unconverged");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_NOT_CONVERGED");
    expect(rec.failure!.message).toMatch(/did not converge at t = 1/);
    expect(rec.failure!.message).toMatch(/absErrT 11\.1641/);
    expect(rec.failure!.message).toMatch(/without a warning/);
    expect(rec.failure!.native).toMatch(/absErrT is 11\.1641/); // the evidence from the log is kept
    expect(mgr.results(id)).toBeUndefined();
    expect(existsSync(join(runsRoot, id, "results.json"))).toBe(false);
  });

  it("a nonzero exit other than 139 after a complete write is a failure, not 'the known shutdown crash'", async () => {
    const { rec, mgr, id } = await runOne("exit-1-complete");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.failure!.message).toMatch(/code 1/);
    expect(rec.failure!.message).toMatch(/Only exit 0 and the known shutdown crash/);
    expect(mgr.results(id)).toBeUndefined();
  });

  it("a FOAM FATAL in the log fails the run even when the exit is 139 and the output looks complete", async () => {
    const { rec, mgr, id } = await runOne("fatal-in-log");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_APP_FAILED");
    expect(rec.failure!.message).toMatch(/FOAM FATAL/);
    expect(mgr.results(id)).toBeUndefined();
  });

  it("a log with no outer-iteration records cannot show convergence: refused, not assumed fine", async () => {
    const { rec, mgr, id } = await runOne("no-iteration-records");
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_OUTPUT_INCOMPLETE");
    expect(rec.failure!.message).toMatch(/no outer-iteration records/);
    expect(mgr.results(id)).toBeUndefined();
  });

  it("a steady run whose last step printed no change gets a passing steadyState check (a bound of 0 K)", async () => {
    const { mgr, id } = await runOne("good");
    const c = (mgr.results(id) as ResultsRecord).checks.find((x) => x.id === "steadyState")!;
    expect(c).toMatchObject({ verdict: "pass", value: 0, unit: "K" });
  });

  it("a steady run whose last step still printed a drift is a result with a FAILED steadyState check, not a silent pass", async () => {
    const { rec, mgr, id } = await runOne("drifting");
    expect(rec.state).toBe("completed");
    const c = (mgr.results(id) as ResultsRecord).checks.find((x) => x.id === "steadyState")!;
    expect(c.verdict).toBe("fail");
    expect(c.value).toBeGreaterThan(0.01);
    expect(c.note).toMatch(/still to change/);
  });

  it("a steady run whose log has no temperature-rate record cannot show it settled: the check fails, it is not skipped", async () => {
    const { rec, mgr, id } = await runOne("no-rate-record");
    expect(rec.state).toBe("completed");
    const c = (mgr.results(id) as ResultsRecord).checks.find((x) => x.id === "steadyState")!;
    expect(c.verdict).toBe("fail");
    expect(c.note).toMatch(/cannot be judged/);
  });

  // the tolerances are the ones in THIS run's system/fvSolution, read after the solver ran
  class EditsFvSolution extends FakeBackend {
    constructor(private edit: (inputsDir: string, nativeDir: string) => void) {
      super("good");
    }
    async run(a: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }) {
      const out = await super.run(a);
      this.edit(a.inputsDir, a.nativeDir);
      return out;
    }
  }
  const withEdit = async (edit: (inputsDir: string, nativeDir: string) => void) => {
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-runs-"));
    dirs.push(runsRoot);
    const mgr = new RunManager({ runsRoot, backend: new EditsFvSolution(edit) });
    const s = mgr.start(pin());
    if (!s.ok) throw new Error("start refused");
    return { rec: await mgr.done(s.id), mgr, id: s.id };
  };

  it("the same converged log fails when this run's own tolerances are far stricter", async () => {
    const { rec } = await withEdit((d, native) => {
      writeFileSync(join(native, "log.offbeat"), convergedLog()); // a last step with absErrT 8e-8 (a steady run's last step has exactly 0, which meets any tolerance)
      const f = join(d, "system", "fvSolution");
      writeFileSync(f, readFileSync(f, "utf8").replace(/relT\s+1e-6;/, "relT 1e-30;").replace(/\bT\s+1e-5;/, "T 1e-30;"));
    });
    expect(rec.state).toBe("failed");
    expect(rec.failure!.code).toBe("E_NOT_CONVERGED");
    expect(rec.failure!.message).toMatch(/T 1e-30/);
  });

  it("a run whose system/fvSolution is missing or unreadable cannot be judged and is refused", async () => {
    const missing = await withEdit((d) => rmSync(join(d, "system", "fvSolution")));
    expect(missing.rec.failure!.code).toBe("E_OUTPUT_INCOMPLETE");
    expect(missing.rec.failure!.message).toMatch(/fvSolution is missing/);
    const noKey = await withEdit((d) => writeFileSync(join(d, "system", "fvSolution"), "solvers { }"));
    expect(noKey.rec.failure!.code).toBe("E_OUTPUT_INCOMPLETE");
    expect(noKey.rec.failure!.message).toMatch(/no stressAnalysis dictionary/);
  });
});
