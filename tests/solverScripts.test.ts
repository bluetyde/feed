// The solver scripts' own checks (F0 exit review, 2026-10-06): the pins are enforced and agree with PINS.md, a run that stopped at an
// intermediate time is never a result, the determinism comparison can fail, and the oracle generator has no default end time.
// These run without the solver (bash and, where present, python); the real solver path is exercised by the FEED_SOLVER tests.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const solver = join(root, "solver");
const text = (p: string) => readFileSync(join(root, p), "utf8");
const fwd = (p: string) => p.replace(/\\/g, "/");

/** Git Bash on Windows (not the WSL launcher that "bash" can resolve to), plain bash elsewhere. */
const bash: string | undefined =
  process.platform === "win32" ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"), "C:\\Program Files\\Git\\bin\\bash.exe"].find((p) => existsSync(p)) : "bash";
const python = ["python3", "python"].find((c) => {
  const r = spawnSync(c, ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0 && /Python 3/.test(r.stdout + r.stderr);
});
const sh = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(bash!, [fwd(join(solver, script)), ...args.map(fwd)], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const tmp = () => mkdtempSync(join(tmpdir(), "feed-solver-scripts-"));

describe("the pins are enforced and agree with PINS.md", () => {
  const pins = Object.fromEntries(
    text("solver/pins.env")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const md = text("solver/PINS.md");

  it("pins.env states the OFFBEAT commit, the OpenFOAM package and version, and the run user", () => {
    expect(pins.OFFBEAT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(pins.OPENFOAM_VERSION).toMatch(/^[0-9]{8}$/);
    expect(pins.OPENFOAM_PACKAGE).toBe("openfoam9");
    expect(pins.FEED_USER).toBe("feed");
    expect(pins.FEED_UID).toBe("1000");
  });

  it("PINS.md records exactly the values the scripts enforce", () => {
    expect(md).toContain(pins.OFFBEAT_COMMIT!);
    expect(md).toContain(pins.OPENFOAM_VERSION!);
    expect(md).toContain(pins.OFFBEAT_REPO!);
    expect(md).toMatch(/`feed` \(uid 1000\)/);
  });

  it("the build checks out the commit (detached), verifies it, and checks the package version; it no longer follows master", () => {
    const b = text("solver/build-offbeat.sh");
    expect(b).toContain('. "$HERE/pins.env"');
    expect(b).toContain('git checkout --detach "$OFFBEAT_COMMIT"');
    expect(b).not.toMatch(/git checkout master/);
    expect(b).toMatch(/\[ "\$got" != "\$OFFBEAT_COMMIT" \]/);
    expect(b).toMatch(/\[ "\$have" != "\$OPENFOAM_VERSION" \]/);
    expect((b.match(/PIN MISMATCH/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("setup installs the pinned package version, verifies it, and creates the run user with the pinned uid", () => {
    const s = text("solver/setup-feed-solver.sh");
    expect(s).toContain('. "$HERE/pins.env"');
    expect(s).toContain('apt-get install -y "$OPENFOAM_PACKAGE=$OPENFOAM_VERSION"');
    expect(s).not.toMatch(/apt-get install -y openfoam9\s*$/m);
    expect(s).toMatch(/\[ "\$have" != "\$OPENFOAM_VERSION" \]/);
    expect(s).toContain('useradd -m -u "$FEED_UID" -s /bin/bash "$FEED_USER"');
  });

  it("PINS.md shows the --exec invocation that the backend uses, not the '--' form", () => {
    expect(md).toContain("--exec bash");
    expect(md).not.toMatch(/-u <user> -- bash/);
  });

  it.skipIf(!bash)("every script is valid bash", () => {
    for (const f of readdirSync(solver).filter((n) => n.endsWith(".sh"))) {
      const r = spawnSync(bash!, ["-n", fwd(join(solver, f))], { encoding: "utf8" });
      expect({ f, status: r.status, err: r.stderr }).toEqual({ f, status: 0, err: "" });
    }
  });
});

describe.skipIf(!bash)("compare-runs.sh can fail (determinism gate)", () => {
  const home = tmp();
  const put = (run: string, file: string, content: string) => {
    mkdirSync(join(home, "runs", run), { recursive: true });
    writeFileSync(join(home, "runs", run, file), content);
  };
  put("a", "T", "300\n");
  put("b", "T", "300\n");
  put("a", "C", "1\n");
  put("b", "C", "2\n");
  put("a", "only-a", "x\n");
  const cmp = (...files: string[]) => sh("compare-runs.sh", ["a", "b", ...files], { HOME: fwd(home) });

  it("identical files: exit 0", () => {
    const r = cmp("T");
    expect(r.code).toBe(0);
    expect(r.out).toContain("identical: T");
  });
  it("a differing file: exit 1", () => {
    const r = cmp("C");
    expect(r.code).toBe(1);
    expect(r.out).toContain("DIFFERENT: C");
  });
  it("a file missing from one run, or from both: exit 1, named MISSING", () => {
    expect(cmp("only-a").code).toBe(1);
    expect(cmp("only-a").out).toContain("MISSING: only-a");
    expect(cmp("nowhere").out).toContain("MISSING: nowhere");
  });
  it("one failure among passes still fails", () => {
    expect(cmp("T", "C", "T").code).toBe(1);
  });
  it("no files to compare is a usage error, not a pass", () => {
    expect(sh("compare-runs.sh", ["a", "b"], { HOME: fwd(home) }).code).toBe(2);
    expect(sh("compare-runs.sh", [], { HOME: fwd(home) }).code).toBe(2);
  });
});

describe.skipIf(!bash)("check-final-time.sh: an intermediate time is never a result", () => {
  const run = (endTime: string | undefined, dirs: string[]) => {
    const d = tmp();
    mkdirSync(join(d, "system"));
    if (endTime !== undefined) writeFileSync(join(d, "system", "controlDict"), `FoamFile {}\nstartTime 0;\nendTime         ${endTime};\ndeltaT 1;\n`);
    for (const t of dirs) mkdirSync(join(d, t));
    return sh("check-final-time.sh", [d]);
  };
  it("the intended time written (plain or scientific names): exit 0", () => {
    expect(run("5e+07", ["0", "50000000"]).code).toBe(0);
    expect(run("50000000.0", ["0", "1000", "5e+07"]).code).toBe(0);
    expect(run("1", ["0", "1"]).code).toBe(0);
  });
  it("only an earlier time written (a timeout, a kill, a fatal error): exit 4 and the message names both times", () => {
    const r = run("5e+07", ["0", "2e+07"]);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/NOT REACHED: latest written time 2e\+07, intended 5e\+07/);
  });
  it("a late write that is still short of the end is refused; one written an ulp early is not", () => {
    expect(run("5e+07", ["0", "4.9e+07"]).code).toBe(4);
    expect(run("5e+07", ["0", "49999999.9999"]).code).toBe(0);
  });
  it("nothing but the start time, or no time directory at all: exit 4", () => {
    expect(run("5e+07", ["0"]).code).toBe(4);
    expect(run("5e+07", []).code).toBe(4);
  });
  it("an unreadable controlDict or one without an endTime: exit 5", () => {
    expect(run(undefined, ["0", "5e+07"]).code).toBe(5);
    const d = tmp();
    mkdirSync(join(d, "system"));
    writeFileSync(join(d, "system", "controlDict"), "FoamFile {}\nstartTime 0;\n");
    mkdirSync(join(d, "5e+07"));
    expect(sh("check-final-time.sh", [d]).code).toBe(5);
  });
  it("the oracle and case scripts run it before extracting, refuse nonzero exits other than the known crash, and refuse FOAM FATAL", () => {
    for (const f of ["solver/run-oracle.sh", "solver/run-case.sh"]) {
      const s = text(f);
      expect(s).toContain('check-final-time.sh" "$RUN"');
      expect(s).toMatch(/\[ "\$code" != "0" \] && \[ "\$code" != "139" \]/);
      expect(s).toContain("FOAM FATAL");
      expect(s.indexOf("check-final-time.sh")).toBeLessThan(s.indexOf("extract-result.py"));
    }
  });
});

describe("the oracle generator has no default end time", () => {
  const params = JSON.parse(text("solver/cases/synthetic-pin.mesh1.params.json"));
  const gen = (over: Record<string, unknown>, drop: string[] = []) => {
    const d = tmp();
    const p: Record<string, unknown> = { ...params, ...over };
    for (const k of drop) delete p[k];
    writeFileSync(join(d, "p.json"), JSON.stringify(p));
    return spawnSync(python!, [join(solver, "make-oracle-case.py"), join(d, "p.json"), join(d, "out")], { encoding: "utf8" });
  };
  it("the source no longer carries the 2000 s default", () => {
    expect(text("solver/make-oracle-case.py")).not.toMatch(/get\("endTime", 2000/);
  });
  it.skipIf(!python)("a params file without endTime is refused before anything is generated", () => {
    const r = gen({}, ["endTime"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must give endTime/);
  });
  it.skipIf(!python)("2000 s, or any end time under 1e7 s, is refused for a steady oracle", () => {
    for (const t of [2000, 9.9e6]) {
      const r = gen({ endTime: t });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/too short for a steady oracle/);
    }
  });
  it.skipIf(!python)("a non-numeric end time is refused", () => {
    for (const t of ["5e7", true, null]) expect(gen({ endTime: t }).status).not.toBe(0);
  });
  it("every params file in solver/cases states the verified horizon of at least 5e7 s", () => {
    const files = readdirSync(join(solver, "cases")).filter((n) => n.endsWith(".params.json"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) expect({ f, t: JSON.parse(text("solver/cases/" + f)).endTime >= 5e7 }).toEqual({ f, t: true });
  });
});

describe("the scripts that run OFFBEAT's own cases never delete, and refuse an existing run folder", () => {
  for (const f of ["solver/run-example.sh", "solver/run-upstream-verification.sh"]) {
    it(f + ": no rm, an existing folder is refused with exit 3, runs happen in a copy of the case", () => {
      const s = text(f);
      expect(s).not.toMatch(/\brm\b/);
      expect(s).toMatch(/if \[ -e "\$RUN" \]; then .*exit 3; fi/);
      expect(s).toMatch(/cp -rL "\$SRC" "\$RUN"/);
    });
  }
  it("run-upstream-verification.sh checks the OFFBEAT pin before it copies or runs anything", () => {
    const s = text("solver/run-upstream-verification.sh");
    expect(s).toContain('. "$HERE/pins.env"');
    expect(s.indexOf("PIN MISMATCH")).toBeGreaterThan(-1);
    expect(s.indexOf("PIN MISMATCH")).toBeLessThan(s.indexOf("cp -rL"));
    expect(s).toContain("bash ./Allrun"); // upstream's own script, not a re-implementation of it
  });
});
