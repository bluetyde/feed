import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { RunManager } from "../src/core/runManager";
import { FakeBackend, Script } from "./helpers/fakeBackend";

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
    const res = mgr.results(id)!;
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
