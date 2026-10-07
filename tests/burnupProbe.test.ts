// M0 of docs/plans/10-burnup.md: what the real OFFBEAT does with its UO2MATPRO conductivity model, burnup through `burnup constant` and a `Bu` file, on FEED's own
// thermal-only pin (FEED_SOLVER=1). Not FEED's burnup feature (that does not exist): FEED's case with the fuel's conductivity lines replaced, run through
// solver/probe-mechanics.sh. The expected values are the MATPRO v11 equation as OFFBEAT codes it, written HERE and sharing no code with FEED; OFFBEAT writes its own
// conductivity field `k`, so the model's arithmetic is compared cell by cell, apart from the temperature solution. Findings: docs/spike/burnup-probe.md.
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { writeOffbeatCase } from "../src/core/caseWriter";
import { validateCase } from "../src/core/validate";
import { cells, ProbeRun, runProbe } from "./helpers/mechanicsProbe";

const solverOn = (() => {
  if (process.env.FEED_SOLVER !== "1" || process.platform !== "win32") return false;
  try {
    return execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" }).split(/\r?\n/).some((l) => l.trim() === "feed-solver");
  } catch {
    return false;
  }
})();

// MATPRO v11 as OFFBEAT codes it (conductivityMatproUO2.C): the defaults of its 13 parameters
const PAR = [0.0452, 0.000246, 0.00187, 1.1599, 0.9, 0.04, 0.038, 0.28, 396.0, 6380.0, 3.5e9, 2.0, 16360.0];
const FRACTION = 0.95; // fraction of theoretical density

/** k(T, B) in W/m/K: B in MWd/kgU, f the density fraction, Gd the gadolinia content. */
const kHand = (T: number, B: number, f = FRACTION, Gd = 0, p = PAR): number => {
  const [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13] = p as [number, number, number, number, number, number, number, number, number, number, number, number, number];
  const phonon = 1 / (p1 + p2 * T + p3 * B + p4 * Gd + ((1 - p5 * Math.exp(-p6 * B)) * p7 * Math.pow(B, p8)) / (1 + p9 * Math.exp(-p10 / T)));
  const electronic = (p11 / Math.pow(T, p12)) * Math.exp(-p13 / T);
  return ((phonon + electronic) * 1.0789 * f) / (1 + 0.5 * (1 - f));
};

const simpson = (g: (x: number) => number, a: number, b: number, n = 2000) => {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * g(a + i * h);
  return (s * h) / 3;
};
/** The fuel temperature at radius r of the 20 kW/m pin at burnup B, closed form with the integral of k done by Simpson and a bisection. */
const fuelT = (B: number, r: number, f = FRACTION, p = PAR): number => {
  const q = 20000, Rf = 4.1e-3, Rci = 4.18e-3, Rco = 4.75e-3, hGap = 5000, hFilm = 30000, kClad = 15, Tb = 573;
  const Tco = Tb + q / (2 * Math.PI * Rco * hFilm);
  const Tci = Tco + (q * Math.log(Rco / Rci)) / (2 * Math.PI * kClad);
  const Ts = Tci + q / (2 * Math.PI * Rf * hGap);
  const target = (q / (4 * Math.PI)) * (1 - (r * r) / (Rf * Rf));
  let lo = Ts;
  let hi = Ts + 3000;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (simpson((T) => kHand(T, B, f, 0, p), Ts, mid, 400) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
};

const baseFiles = () => {
  const d = JSON.parse(readFileSync(join(__dirname, "..", "examples", "synthetic-pin.json"), "utf8"));
  d.mesh = { fuelCells: 100, claddingCells: 20 };
  d.power.linearHeatRate = { value: 20, unit: "kW/m" };
  const v = validateCase(d);
  if (!v.normalized) throw new Error(JSON.stringify(v.errors));
  return writeOffbeatCase(v.normalized).files;
};

/** FEED's case with the fuel on UO2MATPRO, `burnup constant`, and (when given) a Bu file whose fuel cells hold `bu` MWd/t, taken from the default one OFFBEAT wrote. */
const files = (o: { omit?: number; par?: number[]; bu?: number; defaultBu?: string; frac?: number }) => {
  const f = baseFiles();
  const par = o.par ?? PAR;
  const lines = par.map((v, i) => (o.omit === i + 1 ? "" : "par" + (i + 1) + " " + v + ";")).join(" ");
  f["constant/solverDict"] = f["constant/solverDict"]!
    .replace("burnup                  none;", "burnup                  constant;")
    .replace(/(    fuel\n    \{[\s\S]*?)        k           k     \[1 1 -3 -1 0\]  [^;]+;\n/, `$1        conductivityModel UO2MATPRO;\n        densityFraction ${o.frac ?? FRACTION};\n        conductivity { ${lines} }\n`);
  if (o.bu !== undefined && o.defaultBu) {
    const vals = [...Array.from({ length: 100 }, () => String(o.bu)), ...Array.from({ length: 20 }, () => "0")].join("\n");
    f["0/Bu"] = o.defaultBu.replace(/internalField\s+uniform\s+0;/, `internalField   nonuniform List<scalar> \n120\n(\n${vals}\n)\n;`).replace(/location\s+"[^"]*";/, 'location    "0";');
  }
  return f;
};
const run = (o: Parameters<typeof files>[0]): Promise<ProbeRun> => runProbe(files(o), 280);
const col = (r: ProbeRun, name: string) => cells(r, name).map((x) => x[0]!);
const rel = (a: number, b: number) => Math.abs(a / b - 1);

describe.skipIf(!solverOn)("OFFBEAT's UO2MATPRO on FEED's thermal-only pin (needs FEED_SOLVER=1)", () => {
  let fresh: ProbeRun;
  let defaultBu: string;
  const burnt: Record<number, ProbeRun> = {};

  it("runs thermal-only with `burnup constant` and no Bu file (Bu is 0), writes its own k field, and k is the MATPRO equation at B = 0 in every cell", async () => {
    fresh = await run({});
    expect(fresh.exit.offbeatExit === 0 || fresh.exit.offbeatExit === 139).toBe(true);
    expect(fresh.log).not.toMatch(/FOAM FATAL/);
    defaultBu = readFileSync(join(fresh.final!, "Bu"), "utf8");
    const T = col(fresh, "T");
    const k = col(fresh, "k");
    expect(k.length).toBe(120);
    for (let i = 0; i < 100; i++) expect(rel(k[i]!, kHand(T[i]!, 0)), "cell " + i).toBeLessThan(1e-5); // the field holds 7 digits
    expect(col(fresh, "Bu").every((b) => b === 0)).toBe(true);
  }, 300_000);

  for (const B of [20, 40, 60]) {
    it(`at ${B} MWd/kgHM written as Bu = B x 0.881 x 1000: k is the equation at B in every fuel cell, Bu is unchanged by the run, and the temperatures follow the closed form`, async () => {
      const r = await run({ bu: B * 1000 * 0.881, defaultBu });
      burnt[B] = r;
      expect(r.exit.offbeatExit === 0 || r.exit.offbeatExit === 139).toBe(true);
      expect(r.log).not.toMatch(/FOAM FATAL/);
      const T = col(r, "T");
      const k = col(r, "k");
      const Bu = col(r, "Bu");
      for (let i = 0; i < 100; i++) {
        expect(Math.abs(Bu[i]! / (B * 881) - 1), "Bu cell " + i).toBeLessThan(1e-6); // 7 printed digits
        expect(rel(k[i]!, kHand(T[i]!, B)), "k, cell " + i).toBeLessThan(1e-5);
      }
      for (let i = 100; i < 120; i++) expect(Bu[i]).toBe(0);
      const C = col(r, "C");
      // temperatures: the cell values against the closed form at the cell centres (the discretisation error of 100 cells, bound 5 x rise / N^2 = about 0.5 K, sets the tolerance)
      let worst = 0;
      for (let i = 0; i < 100; i++) worst = Math.max(worst, Math.abs(T[i]! - fuelT(B, C[i]!)));
      expect(worst).toBeLessThan(0.5);
      // eslint-disable-next-line no-console
      console.log(`BURNUP ${B} MWd/kgHM: peak cell ${T[0]!.toFixed(2)} K, worst cell against the closed form ${worst.toFixed(3)} K, k at the centre cell ${k[0]!.toFixed(4)}`);
    }, 300_000);
  }

  it("the burnt pin runs hotter, increasingly so, and the fresh pin is the B = 0 closed form: the cost in kelvin", () => {
    const peak = (r: ProbeRun) => col(r, "T")[0]!;
    const p0 = peak(fresh), p20 = peak(burnt[20]!), p40 = peak(burnt[40]!), p60 = peak(burnt[60]!);
    expect(p20).toBeGreaterThan(p0);
    expect(p40).toBeGreaterThan(p20);
    expect(p60).toBeGreaterThan(p40);
    expect(Math.abs(p0 - fuelT(0, col(fresh, "C")[0]!))).toBeLessThan(0.5);
    // eslint-disable-next-line no-console
    console.log(`PEAK K: 0 -> ${p0.toFixed(1)}, 20 -> ${p20.toFixed(1)}, 40 -> ${p40.toFixed(1)}, 60 -> ${p60.toFixed(1)} (rises ${(p20 - p0).toFixed(1)}, ${(p40 - p0).toFixed(1)}, ${(p60 - p0).toFixed(1)} K over fresh)`);
  });

  it("the model divides Bu by 0.881 and not 0.8815: a Bu written as B x 0.8815 x 1000 gives k at B x 0.8815 / 0.881", async () => {
    const B = 40;
    const r = await run({ bu: B * 1000 * 0.8815, defaultBu });
    const T = col(r, "T");
    const k = col(r, "k");
    const seen = (B * 0.8815) / 0.881;
    for (let i = 0; i < 100; i += 7) {
      expect(rel(k[i]!, kHand(T[i]!, seen)), "k, cell " + i).toBeLessThan(1e-5);
      expect(rel(k[i]!, kHand(T[i]!, B)), "differs from the intended burnup, cell " + i).toBeGreaterThan(2e-5);
    }
    // eslint-disable-next-line no-console
    console.log(`0.8815 against 0.881 at ${B} MWd/kgHM: k at the centre cell differs by ${(rel(kHand(T[0]!, seen), kHand(T[0]!, B)) * 1e6).toFixed(0)} ppm`);
  }, 300_000);

  it("a parameter that is left out takes MATPRO's default silently: no refusal, no warning, the same k as with it written; one that is written and changed does change k", async () => {
    const B = 40;
    const omitted = await run({ bu: B * 1000 * 0.881, defaultBu, omit: 1 });
    expect(omitted.exit.offbeatExit === 0 || omitted.exit.offbeatExit === 139).toBe(true);
    expect(omitted.log).not.toMatch(/FOAM FATAL/);
    expect(omitted.log).not.toMatch(/par1/);
    const T = col(omitted, "T");
    const k = col(omitted, "k");
    for (let i = 0; i < 100; i += 9) expect(rel(k[i]!, kHand(T[i]!, B)), "default par1, cell " + i).toBeLessThan(1e-5);
    const changed = await run({ bu: B * 1000 * 0.881, defaultBu, par: [0.06, ...PAR.slice(1)] });
    const kc = col(changed, "k");
    const Tc = col(changed, "T");
    for (let i = 0; i < 100; i += 9) {
      expect(rel(kc[i]!, kHand(Tc[i]!, B, FRACTION, 0, [0.06, ...PAR.slice(1)])), "written par1, cell " + i).toBeLessThan(1e-5);
      expect(rel(kc[i]!, kHand(Tc[i]!, B)), "differs from the default, cell " + i).toBeGreaterThan(0.01);
    }
  }, 600_000);
});
