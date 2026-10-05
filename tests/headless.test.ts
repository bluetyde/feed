// The headless runner (src/cli/headless.ts, compiled to dist/cli/headless.js): what the SEED adapter calls.
// The first group needs no solver; the second runs the real solver and needs FEED_SOLVER=1.
import { execFile, execFileSync, spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const cli = join(root, "dist", "cli", "headless.js");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").at(-1)!) : null };
};
const tmp = () => mkdtempSync(join(tmpdir(), "feed-headless-"));
const solver = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

describe("headless runner without a solver", () => {
  it("is built", () => expect(existsSync(cli)).toBe(true));

  it("describe: one JSON object with the format, the capability and the thermal-only statement", () => {
    const r = run("describe");
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.json).toMatchObject({ ok: true, engine: { name: "feed-headless", capability: "steady-thermal-1d-radial-pin" }, caseFormat: { format: "feed.case", version: "0.1" } });
    expect(typeof r.json.solver.available).toBe("boolean");
    expect(r.json.thermalOnly).toMatch(/Not a stress, failure or integrity assessment/);
  });

  it("validate: a good case is ok with its warnings", () => {
    expect(run("validate", join(root, "examples", "synthetic-pin.json")).json).toEqual({ ok: true, warnings: [] });
    const w = run("validate", join(root, "schema", "vectors", "good", "power-warning.json"));
    expect(w.code).toBe(0);
    expect(w.json.warnings.map((x: any) => x.code)).toEqual(["W_POWER_RANGE"]);
  });

  for (const [file, code] of [
    ["units-missing", "E_UNITS"],
    ["boundary-bulk-only", "E_BOUNDARY_INCOMPLETE"],
    ["prop-missing-conductivity", "E_PROP_MISSING"],
    ["mesh-fuel-high", "E_MESH"],
    ["geometry-overlap", "E_GEOMETRY"],
    ["transient-missing-section", "E_TRANSIENT_INCOMPLETE"],
  ] as const) {
    it(`validate: ${file} is refused with ${code}, exit 2`, () => {
      const r = run("validate", join(root, "schema", "vectors", "bad", file + ".json"));
      expect(r.code).toBe(2);
      expect(r.json.ok).toBe(false);
      expect(r.json.errors[0]).toMatchObject({ code });
      expect(typeof r.json.errors[0].field).toBe("string");
    });
  }

  it("validate: a missing file and invalid JSON are refused, not crashes", () => {
    expect(run("validate", join(tmp(), "nope.json")).json.errors[0].code).toBe("E_NOT_FOUND");
    const bad = join(tmp(), "bad.json");
    writeFileSync(bad, "{nope");
    const r = run("validate", bad);
    expect(r.code).toBe(2);
    expect(r.json.errors[0].code).toBe("E_SCHEMA_INVALID");
  });

  it("an unknown verb is refused with usage", () => {
    const r = run("frobnicate");
    expect(r.code).toBe(1);
    expect(r.json.errors[0].code).toBe("E_VERB_UNKNOWN");
  });

  it("run: refuses a relative --out, a bad run id, an odd timeout and a refused case before touching anything", () => {
    const good = join(root, "examples", "synthetic-pin.json");
    expect(run("run", good, "--out", "relative/dir").json.errors[0].code).toBe("E_PATH_INVALID");
    expect(run("run", good, "--out", tmp(), "--run-id", "../x").json.errors[0].code).toBe("E_PATH_INVALID");
    expect(run("run", good, "--out", tmp(), "--timeout-seconds", "1").json.errors[0].code).toBe("E_BOUNDS_EXCEEDED");
    const out = tmp();
    const r = run("run", join(root, "schema", "vectors", "bad", "units-missing.json"), "--out", out);
    expect(r.code).toBe(2);
    expect(r.json.errors[0].code).toBe("E_UNITS");
    expect(existsSync(join(out, "feed"))).toBe(false);
    expect(existsSync(join(out, "work"))).toBe(false);
  });

  it("cancel: with nothing running it says so; a forged active-run.json is refused", () => {
    const out = tmp();
    expect(run("cancel", "--out", out).json).toMatchObject({ ok: true, cancelled: false });
    writeFileSync(join(out, "active-run.json"), JSON.stringify({ feedRunId: "../../etc", nativeDir: "C:/Windows" }));
    const r = run("cancel", "--out", out);
    expect(r.code).toBe(1);
    expect(r.json.errors[0].code).toBe("E_NOT_OWNED");
  });
});

describe.skipIf(!solver)("headless runner with the real solver (needs FEED_SOLVER=1)", () => {
  it("run: completes, and every file in the manifest hashes as listed", () => {
    const out = tmp();
    const r = run("run", join(root, "examples", "synthetic-pin.json"), "--out", out);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, status: "completed", runId: "feed" });
    const dir = join(out, "feed");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ format: "feed-headless-run", status: "completed" });
    expect(m.files.map((f: any) => f.path).sort()).toEqual(["case.json", "derived.json", "feed-manifest.json", "results.json", "run.json"]);
    for (const f of m.files) expect(sha(readFileSync(join(dir, f.path))), f.path).toBe(f.sha256);
    expect(m.caseSha256).toBe(sha(readFileSync(join(root, "examples", "synthetic-pin.json"))));
    const res = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
    expect(res.schema).toBe("feed.results/0.1");
    expect(res.checks.every((c: any) => c.verdict === "pass")).toBe(true);
    const d = JSON.parse(readFileSync(join(dir, "derived.json"), "utf8"));
    expect(d.linearHeatRate).toBe(20000);
    expect(d.heatFluxOuter).toBeCloseTo(20000 / (2 * Math.PI * 0.00475), 3);
  }, 120_000);

  it("run: refuses to write into an existing run folder", () => {
    const out = tmp();
    expect(run("run", join(root, "examples", "synthetic-pin.json"), "--out", out).json.status).toBe("completed");
    const again = run("run", join(root, "examples", "synthetic-pin.json"), "--out", out);
    expect(again.code).toBe(1);
    expect(again.json.errors[0].code).toBe("E_EXISTS");
  }, 120_000);

  it("run: a run that does not finish inside its time limit is exit 0 with status failed, a reason, and no result files", () => {
    const out = tmp();
    const d = JSON.parse(read("examples/synthetic-pin.json"));
    d.mesh = { fuelCells: 20000, claddingCells: 10000 };
    const f = join(out, "big.json");
    writeFileSync(f, JSON.stringify(d));
    const r = run("run", f, "--out", join(out, "o"), "--timeout-seconds", "10");
    // on a fast machine it can finish inside 10 s; both outcomes are honest
    expect(r.code).toBe(0);
    expect(["completed", "failed"]).toContain(r.json.status);
    if (r.json.status === "failed") {
      expect(r.json.reason).toMatch(/E_TIMEOUT|time limit/);
      expect(existsSync(join(out, "o", "feed"))).toBe(false);
    }
  }, 180_000);

  it("cancel: stops a running solver run from another process; the run reports cancelled and nothing is left", async () => {
    const out = tmp();
    const d = JSON.parse(read("examples/synthetic-pin.json"));
    d.mesh = { fuelCells: 20000, claddingCells: 10000 };
    const f = join(out, "big.json");
    writeFileSync(f, JSON.stringify(d));
    const dir = join(out, "o");
    const child = spawn(process.execPath, [cli, "run", f, "--out", dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    const closed = new Promise<number | null>((res) => child.on("close", res));
    // wait until the solver run is registered, then until OFFBEAT is really running
    let id = "";
    for (let i = 0; i < 400 && !id; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        id = JSON.parse(readFileSync(join(dir, "active-run.json"), "utf8")).feedRunId;
      } catch {
        /* not yet */
      }
    }
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    const probe = 'for i in $(seq 1 400); do for p in $(pgrep -x offbeat); do if readlink /proc/$p/cwd 2>/dev/null | grep -q "feed-$1"; then echo found; exit 0; fi; done; sleep 0.05; done; echo timeout';
    const { stdout: seen } = await promisify(execFile)("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", probe, "_", id], { encoding: "utf8" });
    expect(seen.trim()).toBe("found");
    const c = await promisify(execFile)(process.execPath, [cli, "cancel", "--out", dir], { encoding: "utf8" });
    expect(JSON.parse(c.stdout.trim())).toMatchObject({ ok: true, cancelled: true });
    await closed;
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, status: "cancelled" });
    expect(existsSync(join(dir, "feed"))).toBe(false);
    await new Promise((r) => setTimeout(r, 2000));
    const { stdout: left } = await promisify(execFile)("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", 'for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done | grep -c "feed-$1" || true', "_", id], { encoding: "utf8" });
    expect(left.trim()).toBe("0");
  }, 240_000);
});
