// The independent finite-volume runs off the server's thread (src/core/independentRunner.ts): the same numbers as in this thread, a deadline that
// really stops the thread, cancel, a queue, a newer preview replacing a waiting one, a failing worker reported, and the event loop staying free.
// These run the compiled worker (dist/core/independentWorker.js): `npm run build` first, as for the headless tests.
import { readFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { describe, expect, it } from "vitest";
import { IndependentRunner, forWorker, resolveWorkerFile } from "../src/core/independentRunner";
import { computeIndependent, independentSolution } from "../src/core/transientResults";
import { NormalizedCase, validateCase } from "../src/core/validate";

const root = join(__dirname, "..");
const base = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse.json"), "utf8"));
/** The synthetic pulse on a mesh and step count of our choosing (the history runs to the end time). */
function pulseCase(fuelCells: number, claddingCells: number, steps: number, endMs = 100): NormalizedCase {
  const d = JSON.parse(JSON.stringify(base));
  d.mesh = { fuelCells, claddingCells };
  d.transient.endTime = { value: endMs, unit: "ms" };
  d.transient.timeStep = { value: endMs / steps, unit: "ms" };
  d.transient.outputs = 20;
  d.transient.powerHistory[d.transient.powerHistory.length - 1].time = { value: endMs, unit: "ms" };
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  return v.normalized!;
}
const small = () => pulseCase(20, 6, 1000);
/** The largest case the validator allows (cells x steps = 2.99e6): about 3.5 s of work in one thread. */
const heavy = () => pulseCase(100, 30, 23000);

const waitFor = async (f: () => boolean, ms = 1500) => {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  return f();
};

describe("the build the worker needs", () => {
  it("the compiled worker is where the runner looks for it (run `npm run build` if this fails)", () => {
    expect(resolveWorkerFile()).not.toBeNull();
  });
});

describe("the worker gives the numbers this thread gives", () => {
  it("the three runs of the results: every state of every run equal, trace included", async () => {
    const c = small();
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const out = await r.start(c).done;
    expect(out.ok).toBe(true);
    if (!out.ok || out.what !== "full") throw new Error("not ok");
    expect(out.mode).toBe("worker");
    expect(out.set).toEqual(computeIndependent(c));
    expect(out.ms).toBeGreaterThan(0);
  });

  it("the preview's single run", async () => {
    const c = small();
    const out = await new IndependentRunner({ deadlineMs: 60_000 }).start(c, { what: "single" }).done;
    expect(out.ok).toBe(true);
    if (!out.ok || out.what !== "single") throw new Error("not ok");
    expect(out.set.fv).toEqual(independentSolution(c));
  });

  it("a case with a generated pulse (the integrated curve is not sent to the thread, and the answer is the same)", async () => {
    const d = JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse-kinetics.json"), "utf8"));
    const c = validateCase(d).normalized!;
    expect(c.transient!.generated!.trace.time.length).toBeGreaterThan(1000);
    const out = await new IndependentRunner({ deadlineMs: 60_000 }).start(c, { what: "single" }).done;
    if (!out.ok || out.what !== "single") throw new Error("not ok");
    expect(out.set.fv).toEqual(independentSolution(c));
  });
});

describe("what is sent to the thread", () => {
  it("a generated pulse's integrated curve is left behind (thousands of numbers the worker does not use); the caller's case is not changed", () => {
    const c = validateCase(JSON.parse(readFileSync(join(root, "examples", "synthetic-pulse-kinetics.json"), "utf8"))).normalized!;
    const sent = forWorker(c);
    expect(sent.transient!.generated).toBeUndefined();
    expect(sent.transient!.times).toEqual(c.transient!.times);
    expect(c.transient!.generated).toBeDefined();
    const plain = small();
    expect(forWorker(plain)).toBe(plain); // a case with nothing to leave behind is passed as it is
  });
});

describe("the deadline", () => {
  it("stops a job that is too slow: the outcome says so, and the thread really is gone", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const t0 = Date.now();
    const out = await r.start(heavy(), { deadlineMs: 150 }).done;
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("deadline");
    expect(out.message).toMatch(/did not finish within 0\.150 s/);
    expect(Date.now() - t0).toBeLessThan(2500); // not the 3.5 s the work needs
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
    expect(r.activity()).toEqual({ running: 0, queued: 0 });
  }, 20_000);

  it("the runner is not poisoned by it: the next job completes", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    await r.start(heavy(), { deadlineMs: 100 }).done;
    const out = await r.start(small()).done;
    expect(out.ok).toBe(true);
  }, 30_000);

  it("a finished job leaves no deadline timer behind (a leftover one would hold the process open until the deadline)", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    const before = timers();
    const r = new IndependentRunner({ deadlineMs: 600_000 });
    expect((await r.start(small()).done).ok).toBe(true);
    await new Promise((x) => setTimeout(x, 60));
    expect(timers()).toBeLessThanOrEqual(before);
  });

  it("a job that finishes in time is not stopped, and its timer is gone (nothing fires later)", async () => {
    const r = new IndependentRunner({ deadlineMs: 400 });
    const out = await r.start(small()).done;
    expect(out.ok).toBe(true);
    await new Promise((x) => setTimeout(x, 600));
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
  });
});

describe("cancel", () => {
  it("a running job: the thread is terminated and the outcome is cancelled", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const h = r.start(heavy());
    await new Promise((x) => setTimeout(x, 200));
    expect(r.liveThreads()).toBe(1);
    h.cancel();
    const out = await h.done;
    expect(out).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
  }, 20_000);

  it("a queued job never starts", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000, maxConcurrent: 1 });
    const a = r.start(heavy());
    const b = r.start(small());
    expect(r.activity()).toEqual({ running: 1, queued: 1 });
    b.cancel();
    expect(await b.done).toMatchObject({ ok: false, reason: "cancelled" });
    expect(r.activity()).toEqual({ running: 1, queued: 0 });
    a.cancel();
    await a.done;
    expect(await waitFor(() => r.liveThreads() === 0)).toBe(true);
  }, 20_000);

  it("cancelling a finished job does nothing", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000 });
    const h = r.start(small());
    const out = await h.done;
    h.cancel();
    expect(out.ok).toBe(true);
  });
});

describe("the queue", () => {
  it("at most maxConcurrent threads at once; the rest wait, and all finish", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000, maxConcurrent: 2 });
    const hs = [0, 1, 2, 3, 4].map(() => r.start(small()));
    expect(r.activity()).toEqual({ running: 2, queued: 3 });
    expect(r.liveThreads()).toBeLessThanOrEqual(2);
    const outs = await Promise.all(hs.map((h) => h.done));
    expect(outs.every((o) => o.ok)).toBe(true);
  }, 30_000);

  it("a newer preview replaces one still waiting; the running one and a non-preview job are left alone", async () => {
    const r = new IndependentRunner({ deadlineMs: 60_000, maxConcurrent: 1 });
    const running = r.start(small(), { what: "single", supersede: true });
    const waiting1 = r.start(small(), { what: "single", supersede: true });
    const full = r.start(small(), { what: "full" });
    const waiting2 = r.start(small(), { what: "single", supersede: true });
    expect(await waiting1.done).toMatchObject({ ok: false, reason: "superseded" });
    const outs = await Promise.all([running.done, full.done, waiting2.done]);
    expect(outs.every((o) => o.ok)).toBe(true);
  }, 30_000);
});

describe("failures are reported, not thrown", () => {
  it("a case the worker cannot solve", async () => {
    const steady = validateCase(JSON.parse(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8"))).normalized!;
    const out = await new IndependentRunner({ deadlineMs: 60_000 }).start(steady).done;
    expect(out).toMatchObject({ ok: false, reason: "worker-failed" });
    if (!out.ok) expect(out.message).toMatch(/not a transient|Cannot read/);
  });

  it("a worker file that is not there", async () => {
    const out = await new IndependentRunner({ deadlineMs: 60_000, workerFile: join(root, "dist", "core", "nope.js") }).start(small()).done;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("worker-failed");
  });

  it("no worker build at all: the job runs in this thread, and says so (the numbers are the same, no deadline applies)", async () => {
    const r = new IndependentRunner({ deadlineMs: 1, workerFile: null });
    expect(r.mode).toBe("in-process");
    const c = small();
    const out = await r.start(c).done;
    expect(out.ok).toBe(true);
    if (!out.ok || out.what !== "full") throw new Error("not ok");
    expect(out.mode).toBe("in-process");
    expect(out.set).toEqual(computeIndependent(c));
  });
});

describe("the event loop stays free (the reason for the worker)", () => {
  /** The longest gap between ticks of a 10 ms timer while `work` runs. */
  async function longestGap(work: () => Promise<unknown>): Promise<number> {
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 10);
    await work();
    await new Promise((r) => setTimeout(r, 40)); // let the first tick after a blocked stretch land, or its lateness is never seen
    clearInterval(timer);
    return worst;
  }

  it("with the largest case the validator allows, a timer is never late by more than 300 ms in a worker, and is late by seconds in this thread", async () => {
    const c = heavy();
    const inWorker = await longestGap(async () => {
      const out = await new IndependentRunner({ deadlineMs: 60_000 }).start(c).done;
      expect(out.ok).toBe(true);
    });
    const inThread = await longestGap(async () => {
      const out = await new IndependentRunner({ deadlineMs: 60_000, workerFile: null }).start(c).done;
      expect(out.ok).toBe(true);
    });
    expect(inWorker).toBeLessThan(300);
    expect(inThread).toBeGreaterThan(1000); // the measurement can see the problem it is guarding against
  }, 60_000);
});
