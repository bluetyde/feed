// The property-model survey's claims, run (docs/spike/property-model-survey.md). Reading OFFBEAT's source says what a model should do; these
// put each claim that FEED's next steps depend on through the real solver on the synthetic pin: the ZyRELAP cubic and its sign convention, the
// silent default of an omitted parameter, an unknown or unusable model, the absence of any range enforcement, and the quadratic heat capacity.
// The expected values are computed here, independently of OFFBEAT: the conductivity integral of the cubic law solved by bisection, and the
// enthalpy of the quadratic law solved by bisection. Needs FEED_SOLVER=1 and the feed-solver distro.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { compositeConstantK } from "../src/core/closedForm";
import { RunBackend, RunManager } from "../src/core/runManager";
import { ResultsRecord } from "../src/core/resultsParser";
import { TransientResultsRecord } from "../src/core/transientResults";
import { validateCase } from "../src/core/validate";
import { WslBackend } from "../src/core/wslBackend";

const root = join(__dirname, "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

/** A backend that rewrites OFFBEAT's solverDict before the real run. */
class EditBackend implements RunBackend {
  inner = new WslBackend();
  constructor(private edit: (dict: string) => string) {}
  async run(args: Parameters<RunBackend["run"]>[0]) {
    const f = join(args.inputsDir, "constant", "solverDict");
    writeFileSync(f, this.edit(readFileSync(f, "utf8")));
    return this.inner.run(args);
  }
  cancel(id: string) {
    return this.inner.cancel(id);
  }
}

async function run(doc: unknown, edit: (dict: string) => string) {
  const mgr = new RunManager({ runsRoot: mkdtempSync(join(tmpdir(), "feed-probe-")), backend: new EditBackend(edit), timeoutMs: 280_000 });
  const s = mgr.start(doc);
  if (!s.ok) throw new Error("start refused: " + JSON.stringify(s));
  const rec = await mgr.done(s.id);
  const dir = join((mgr as any).opts.runsRoot, s.id);
  const log = (() => {
    try {
      return readFileSync(join(dir, "native", "log.offbeat"), "utf8");
    } catch {
      return "";
    }
  })();
  return { rec, res: mgr.results(s.id) as ResultsRecord | TransientResultsRecord | undefined, log };
}

/** In the fuel's material block, replace the line that gives the conductivity (or the heat capacity) with `text`. */
const inFuelBlock = (dict: string, line: RegExp, text: string) => {
  const m = /\n    fuel\n    \{[\s\S]*?\n    \}/.exec(dict);
  if (!m) throw new Error("no fuel block in the solverDict");
  if (!line.test(m[0])) throw new Error("the fuel block has no line " + line);
  return dict.replace(m[0], m[0].replace(line, text));
};
const K_LINE = /^\s*k\s+k\s+\[1 1 -3 -1 0\]\s+[^;]+;\n/m;
const cubicBlock = (par: Record<string, number | undefined>, model = "ZyRELAP") =>
  `        conductivityModel ${model};\n        conductivity { ${Object.entries(par).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v};`).join(" ")} }\n`;

// ---- the case and its closed form
const pinDoc = () => {
  const d = read("examples/synthetic-pin.json");
  d.mesh = { fuelCells: 40, claddingCells: 12 };
  return d;
};
const pin = validateCase(pinDoc()).normalized!;
/** Everything outside the fuel is constant, so the fuel surface temperature does not depend on the fuel's conductivity law. */
const outside = compositeConstantK({ qPrime: pin.qPrime, fuelK: 3, fuelRadius: pin.fuelRadius, hGap: pin.gapConductance, claddingInnerRadius: pin.claddingInnerRadius, claddingOuterRadius: pin.claddingOuterRadius, claddingK: pin.claddingConductivity.kind === "constant" ? pin.claddingConductivity.k : NaN, hFilm: pin.boundary.kind === "convective" ? pin.boundary.heatTransferCoefficient : NaN, bulkTemperature: pin.boundary.kind === "convective" ? pin.boundary.bulkTemperature : NaN });

/** The cubic law k = a0 + a1 T + a2 T^2 + a3 T^3 (W/m/K, T in K): its integral, and the fuel temperature at radius r from the conductivity integral. */
const cubic = (a: number[]) => ({
  k: (T: number) => a[0]! + a[1]! * T + a[2]! * T * T + a[3]! * T ** 3,
  K: (T: number) => a[0]! * T + (a[1]! * T * T) / 2 + (a[2]! * T ** 3) / 3 + (a[3]! * T ** 4) / 4,
});
function fuelTemperature(a: number[], r: number, qPrime = pin.qPrime): number {
  const { K } = cubic(a);
  const target = K(outside.fuelSurfaceT) + (qPrime * (1 - (r * r) / (pin.fuelRadius * pin.fuelRadius))) / (4 * Math.PI);
  let lo = outside.fuelSurfaceT;
  let hi = outside.fuelSurfaceT + 4000;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (K(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const fuelCells = (res: ResultsRecord) => res.radial.filter((p) => p.region === "fuel");
/** Largest difference between OFFBEAT's fuel cells and the closed form of the law `a`. */
const worst = (res: ResultsRecord, a: number[], qPrime = pin.qPrime) => Math.max(...fuelCells(res).map((p) => Math.abs(p.T - fuelTemperature(a, p.r, qPrime))));

// k = 2 + 0.003 T - 1.2e-6 T^2 + 2e-10 T^3: positive over 300 to 2500 K (2.80 at 300 K, 4.0 at 1000 K, 4.8 at 2000 K), and with a real T^2 term
const A = [2.0, 0.003, -1.2e-6, 2e-10];
/** OFFBEAT's ZyRELAP is par1 + par2 T - par3 T^2 + par4 T^3: for the law A the T^2 parameter is -a2, not a2. */
const PAR_FOR_A = { par1: A[0], par2: A[1], par3: -A[2]!, par4: A[3] };

describe.skipIf(!solverOn)("what OFFBEAT's property models do, on the synthetic pin (needs FEED_SOLVER=1)", () => {
  it("ZyRELAP carries any cubic k(T), with the T^2 coefficient SUBTRACTED: the fuel profile equals the closed form of the intended law", async () => {
    const { rec, res } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, cubicBlock(PAR_FOR_A)));
    expect(rec.state).toBe("completed");
    const steady = res as ResultsRecord;
    expect(steady.summary.maxT).toBeGreaterThan(1000); // a real temperature dependence is in play
    // the discretisation bound the results' own closed-form check uses: 5 dT / N^2 with N = 40 fuel cells
    const dT = steady.summary.centreCellT - outside.fuelSurfaceT;
    expect(worst(steady, A)).toBeLessThan((5 * dT) / 40 ** 2);
  }, 300_000);

  it("the sign matters: with par3 = +a2 (the natural reading) OFFBEAT solves a different law, tens of kelvin away from the intended one and equal to the closed form of the law it was really given", async () => {
    const wrong = { ...PAR_FOR_A, par3: A[2] }; // intended a2 written straight in
    const { res } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, cubicBlock(wrong)));
    const steady = res as ResultsRecord;
    const asGiven = [A[0]!, A[1]!, -A[2]!, A[3]!]; // what OFFBEAT evaluates: par1 + par2 T - par3 T^2 + par4 T^3 with par3 = a2
    expect(worst(steady, A)).toBeGreaterThan(20);
    const dT = steady.summary.centreCellT - outside.fuelSurfaceT;
    expect(worst(steady, asGiven)).toBeLessThan((5 * dT) / 40 ** 2);
  }, 300_000);

  it("an omitted parameter is NOT an error: its Zircaloy default is used silently (par4 = 7.67e-9 here)", async () => {
    const { rec, res } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, cubicBlock({ par1: PAR_FOR_A.par1, par2: PAR_FOR_A.par2, par3: PAR_FOR_A.par3 })));
    expect(rec.state).toBe("completed"); // no refusal, no warning that a parameter was missing
    const steady = res as ResultsRecord;
    const withDefault = [A[0]!, A[1]!, A[2]!, 7.67e-9];
    const dT = steady.summary.centreCellT - outside.fuelSurfaceT;
    expect(worst(steady, withDefault)).toBeLessThan((5 * dT) / 40 ** 2);
    expect(worst(steady, A)).toBeGreaterThan(20); // and it is not the law the user meant
  }, 300_000);

  it("a mistyped parameter name is ignored the same way (par44 is not read, par4 takes its default)", async () => {
    const { rec, res } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, `        conductivityModel ZyRELAP;\n        conductivity { par1 ${PAR_FOR_A.par1}; par2 ${PAR_FOR_A.par2}; par3 ${PAR_FOR_A.par3}; par44 ${A[3]}; }\n`));
    expect(rec.state).toBe("completed");
    expect(worst(res as ResultsRecord, A)).toBeGreaterThan(20);
  }, 300_000);

  it("an unknown model name is fatal, and the log lists exactly the 15 registered conductivity models", async () => {
    const { rec, log } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, cubicBlock({ par1: 1 }, "ZyRELAPP")));
    expect(rec.state).toBe("failed");
    expect(rec.failure?.native ?? "").toMatch(/Unknown conductivityModel type ZyRELAPP/);
    // FEED's run record keeps the head of the message; the complete list is in the solver log
    const list = /Valid types are:\s*(\d+)\s*\(([\s\S]*?)\)/.exec(log);
    expect(list).not.toBeNull();
    const names = list![2]!.trim().split(/\s+/).sort();
    expect(Number(list![1])).toBe(15);
    expect(names).toEqual(["BufferPARFUME", "Mo", "SiCPARFUME", "SwindemanHastelloyN", "UO2MATPRO", "UO2NFIR", "UPuO2Brancheria", "UPuO2Kato", "UPuO2LanningBeyer", "UPuO2MagniMAMOX", "UPuO2Philipponeau", "ZyRELAP", "conductivityUO2IFA601", "constant", "steel1515TiTobbe"].sort());
  }, 300_000);
  it("a burnup- or composition-dependent model (UO2MATPRO) is refused in a thermal-only case, at the first thing it lacks", async () => {
    const { rec } = await run(pinDoc(), (d) => inFuelBlock(d, K_LINE, "        conductivityModel UO2MATPRO;\n"));
    expect(rec.state).toBe("failed");
    // it stops at the first thing missing, the keyword densityFraction; the burnup, porosity and swelling fields it also reads were not reached
    expect(rec.failure?.native ?? "").toMatch(/FOAM FATAL IO ERROR[\s\S]*keyword densityFraction is undefined/);
  }, 300_000);

  it("no range is enforced: above ZyRELAP's stated 1800 K the run completes, with a warning in the log and a result nobody refused", async () => {
    const d = pinDoc();
    d.power.linearHeatRate = { value: 55, unit: "kW/m" };
    const { rec, res, log } = await run(d, (x) => inFuelBlock(x, K_LINE, cubicBlock(PAR_FOR_A)));
    expect(rec.state).toBe("completed");
    expect((res as ResultsRecord).summary.maxT).toBeGreaterThan(1801);
    expect(log).toMatch(/out of range 290 < T < 1800 K/);
  }, 300_000);

  it("SiCSnead carries a QUADRATIC heat capacity (par4 = 0): the interior of the pulse reaches the root of the integral of rho Cp dT = E", async () => {
    const d = read("examples/synthetic-pulse.json");
    d.transient.timeStep = { value: 0.025, unit: "ms" };
    d.transient.outputs = 20;
    const par = { par1: 200, par2: 0.2, par3: 5e-5, par4: 0 };
    const RHO = 10000;
    const { rec, res } = await run(d, (x) => inFuelBlock(x, /^\s*Cp\s+Cp\s+\[0 2 -2 -1 0\]\s+[^;]+;\n/m, `        Cp          Cp    [0 2 -2 -1 0]  300;\n        heatCapacityModel SiCSnead;\n        heatCapacity { par1 ${par.par1}; par2 ${par.par2}; par3 ${par.par3}; par4 ${par.par4}; }\n`));
    expect(rec.state).toBe("completed");
    const E = (0.5 * 10e6 * 0.01) / (Math.PI * 0.0041 ** 2); // J/m3 deposited in the fuel by the triangular pulse
    const H = (T: number) => RHO * (par.par1 * T + (par.par2 * T * T) / 2 + (par.par3 * T ** 3) / 3);
    let lo = 300;
    let hi = 3000;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (H(mid) - H(300) < E) lo = mid;
      else hi = mid;
    }
    const exact = 0.5 * (lo + hi);
    expect(exact).toBeGreaterThan(500);
    expect(Math.abs((res as TransientResultsRecord).summary.maxT - exact)).toBeLessThan(0.005 * (exact - 300)); // first order in the step, as for the linear law
  }, 300_000);
});
