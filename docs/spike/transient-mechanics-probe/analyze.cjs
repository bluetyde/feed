// Throw-away analysis of plan 17 M0 (docs/spike/transient-mechanics-probe.md): OFFBEAT's fields at every written time against FEED's independent thermo-elastic solution
// (dist/core/thermoElastic.js, solveSlice) evaluated (a) with OFFBEAT's own temperatures of that time and (b) with FEED's independent finite-volume temperatures of that time
// (dist/core/transientFv.js, same power table, same steps as the run), with the constants OFFBEAT was given. The tolerances are the steady plan's (docs/mechanics.md): displacement 1 %
// of the solid's largest |ur| + 1e-9 m, stress 3 % of the solid's stress scale + 10 kPa, equilibrium 2 % + 10 kPa, contact pressure 3 % + 10 kPa, gap 2 % + 1e-8 m.
// usage: node analyze.cjs <inDir> <outDir> [--json result.json] [--no-fv]
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const { solveSlice } = require(path.join(root, "dist/core/thermoElastic.js"));
const { solveTransientFv } = require(path.join(root, "dist/core/transientFv.js"));
const tr = require(path.join(root, "dist/core/transientResults.js"));
const { validateCase } = require(path.join(root, "dist/core/validate.js"));

const inDir = process.argv[2];
const outDir = process.argv[3];
const noFv = process.argv.includes("--no-fv");
const meta = JSON.parse(fs.readFileSync(path.join(inDir, "probe-meta.json"), "utf8"));

// ---- parsing OpenFOAM fields ----
function listField(text, width) {
  const m = /internalField\s+nonuniform\s+List<[a-zA-Z]+>\s*(\d+)\s*\(/.exec(text);
  if (!m) {
    const u = /internalField\s+uniform\s+([^;]+);/.exec(text);
    if (u) return [u[1].replace(/[()]/g, "").trim().split(/\s+/).map(Number)];
    throw new Error("no internalField");
  }
  const body = text.slice(m.index + m[0].length);
  const end = body.indexOf("\n)");
  const inner = body.slice(0, end);
  if (width === 1) return inner.trim().split(/\s+/).map((x) => [Number(x)]);
  return [...inner.matchAll(/\(([^()]*)\)/g)].map((r) => r[1].trim().split(/\s+/).map(Number));
}
function patchScalar(text, patch) {
  const b = text.slice(text.indexOf("boundaryField"));
  const m = new RegExp(`\\b${patch}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(b);
  if (!m) return null;
  const u = /value\s+uniform\s+([-+.\deE]+)\s*;/.exec(m[1]);
  if (u) return Number(u[1]);
  const l = /value\s+nonuniform\s+List<scalar>\s*(\d+)\s*\(([^)]*)\)/.exec(m[1]);
  return l ? Number(l[2].trim().split(/\s+/)[0]) : null;
}

// ---- the case ----
const nf = meta.nf, nc = meta.nc, n = nf + nc;
const Cc = listField(fs.readFileSync(path.join(outDir, "C"), "utf8"), 3);
const r = Cc.map((v) => Math.hypot(v[0], v[1]));
const Tref = meta.Tref;
const times = fs.readdirSync(path.join(outDir, "times")).map((d) => ({ d, t: Number(d) })).sort((a, b) => a.t - b.t);

// ---- the independent finite-volume temperatures at the run's own times ----
// base case = the thermal case FEED writes for this geometry (no mechanics), the power table that the run used (read from its solverDict, which may carry a cooldown ramp)
const ex = JSON.parse(fs.readFileSync(path.join(root, "examples/ut-triga-pulse-4p40-limits.json"), "utf8"));
delete ex.limits;
ex.geometry.claddingInnerRadius = { value: 18.161 + meta.gapUm / 1000, unit: "mm" };
ex.geometry.claddingOuterRadius = { value: meta.claddingOuterRadius * 1e3, unit: "mm" };
const c = validateCase(ex).normalized;
const sd = fs.readFileSync(path.join(inDir, "constant/solverDict"), "utf8");
const pm = /timePoints  \(([^)]*)\);\n    lhgr        \(([^)]*)\);/.exec(sd);
const tp = pm[1].trim().split(/\s+/).map(Number), lh = pm[2].trim().split(/\s+/).map(Number);
const power = (t) => {
  if (t <= tp[0]) return lh[0];
  for (let i = 1; i < tp.length; i++) if (t <= tp[i]) return lh[i - 1] + ((lh[i] - lh[i - 1]) * (t - tp[i - 1])) / (tp[i] - tp[i - 1]);
  return lh[lh.length - 1];
};
const pin = { ...tr.pinOf(c), power };
// the stages: stage 1 at the case's step to the end of the pulse, stage 2 (if any) from the controlDicts the run used
const cd = (f) => {
  const t = fs.readFileSync(f, "utf8");
  const g = (k) => Number(new RegExp(`${k}\\s+([^;]+);`).exec(t)[1]);
  return { dt: g("deltaT"), end: g("endTime"), every: g("writeInterval") };
};
const s1 = cd(path.join(inDir, "system/controlDict"));
const st2 = fs.existsSync(path.join(inDir, "stage2/controlDict")) ? cd(path.join(inDir, "stage2/controlDict")) : null;
let fvStates = [];
if (!noFv) {
  const run1 = solveTransientFv(pin, { dt: s1.dt, steps: Math.round(s1.end / s1.dt), initialTemperature: 293.15, outputEvery: s1.every });
  fvStates = run1.states.map((s) => ({ time: s.time, T: s.T }));
  if (st2) {
    const last = run1.states[run1.states.length - 1];
    // the restart state is the end of stage 1: re-run the last output interval's end exactly (the run's final state is an output when the end is a multiple of the interval)
    const shifted = { ...pin, power: (t) => power(t + s1.end) };
    const run2 = solveTransientFv(shifted, { dt: st2.dt, steps: Math.round((st2.end - s1.end) / st2.dt), initialField: last.T, outputEvery: st2.every });
    fvStates.push(...run2.states.slice(1).map((s) => ({ time: s.time + s1.end, T: s.T })));
  }
}
const fvAt = (t) => {
  if (!fvStates.length) return null;
  const s = fvStates.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
  return Math.abs(s.time - t) < 1e-7 ? s : null;
};

// ---- the independent thermo-elastic solution from a list of cell temperatures ----
const CELLWISE = !process.argv.includes("--interp"); // default: the thermal strain piecewise constant per cell (the finite-volume temperatures as they are); --interp: linear between cell centres
function thetaFrom(rs, Ts) {
  if (CELLWISE) {
    // piecewise constant: the value of the cell the radius is in (cell faces halfway between centres, the first and last cell to the solid's surfaces)
    return (x) => {
      let i = 0;
      while (i + 1 < rs.length && x > 0.5 * (rs[i] + rs[i + 1])) i++;
      return Ts[i] - Tref;
    };
  }
  // piecewise linear between cell centres, linear extrapolation to the faces
  return (x) => {
    let i = rs.findIndex((v) => v >= x);
    if (i <= 0) i = 1;
    if (i < 0 || i >= rs.length) i = rs.length - 1;
    const a = i - 1;
    return Ts[a] + ((Ts[i] - Ts[a]) * (x - rs[a])) / (rs[i] - rs[a]) - Tref;
  };
}
const fuelProps = meta.fuel, cladProps = meta.clad;
// a restart with new constants (stage2/solverDict): the fuel's constants after the end of stage 1
let fuelProps2 = null;
if (fs.existsSync(path.join(inDir, "stage2/solverDict"))) {
  const t2 = fs.readFileSync(path.join(inDir, "stage2/solverDict"), "utf8");
  const blk = /    fuel\n    \{[\s\S]*?\n    \}/.exec(t2)[0];
  const g = (k) => Number(new RegExp(`${k}\\s+${k}\\s*\\[[^\\]]*\\]\\s+([^;]+);`).exec(blk)[1]);
  fuelProps2 = { E: g("E"), nu: g("nu"), alpha: g("alpha") };
}
function independent(Tcells, props = { fuel: fuelProps, clad: cladProps }) {
  if (props.fuel === undefined) props = { fuel: fuelProps, clad: cladProps };
  const fuel = { a: meta.fuelInnerRadius, b: meta.fuelRadius, E: props.fuel.E, nu: props.fuel.nu, alpha: props.fuel.alpha, theta: thetaFrom(r.slice(0, nf), Tcells.slice(0, nf)) };
  const clad = { a: meta.claddingInnerRadius, b: meta.claddingOuterRadius, E: props.clad.E, nu: props.clad.nu, alpha: props.clad.alpha, theta: thetaFrom(r.slice(nf), Tcells.slice(nf)) };
  if (meta.laws) {
    // the fuel's E(T) and thermal strain as the library's laws, cell by cell (the probe-local finite-element solution, vp.cjs); the fuel record keeps the constants only for the stress scale
    const { solveSliceVP } = require("./vp.cjs");
    const lib = JSON.parse(fs.readFileSync(path.join(root, "library/materials.json"), "utf8"));
    const fm = lib.find((e) => e.material && e.material.materialId === "triga-uzrh-h16").material.sets;
    const Ea = fm["mechanical.elasticity"].a.value, Eb = fm["mechanical.elasticity"].b.value;
    const aA = fm["mechanical.thermalExpansion"].linearExpansion.a.value, aB = fm["mechanical.thermalExpansion"].linearExpansion.b.value;
    const strain = (T) => aA * (T - Tref) + 0.5 * aB * (T * T - Tref * Tref);
    const tf = fuel.theta, tc = clad.theta;
    const vp = solveSliceVP(
      { a: fuel.a, b: fuel.b, nu: fuel.nu, E: (x) => Ea + Eb * (tf(x) + Tref), th: (x) => strain(tf(x) + Tref) },
      { a: clad.a, b: clad.b, nu: clad.nu, E: () => clad.E, th: (x) => clad.alpha * tc(x) },
      0,
      240,
    );
    return { sol: vp, fuel, clad };
  }
  const sol = solveSlice(fuel, clad, "free-axial", 0, 0);
  return { sol, fuel, clad };
}

// ---- compare ----
const TOL = { dispFrac: 0.01, dispFloor: 1e-9, stressFrac: 0.03, stressFloor: 1e4, thermalFrac: 0.01, eqFrac: 0.02, pFrac: 0.03, pFloor: 1e4, gapFrac: 0.02, gapFloor: 1e-8, nearlyClosed: 0.5e-6 };
function compare(Toff, D, S, gapW, intP, Tindep, props) {
  const { sol, fuel, clad } = independent(Tindep, props);
  const fuelProps = (props && props.fuel) || meta.fuel;
  const res = { freeGapUm: sol.freeGap * 1e6, indepContact: sol.contact, indepP: sol.contactPressure, indepGapUm: sol.gap * 1e6 };
  const solids = [
    { name: "fuel", idx: [...Array(nf).keys()], f: sol.fuel, p: fuelProps, th: fuel.theta },
    { name: "cladding", idx: [...Array(nc).keys()].map((i) => nf + i), f: sol.cladding, p: cladProps, th: clad.theta },
  ];
  let worstUrel = 0, worstSrel = 0, pass = { u: true, s: true, eq: true };
  for (const s of solids) {
    const ref = s.idx.map((i) => s.f.at(r[i]));
    const uScale = Math.max(...ref.map((x) => Math.abs(x.ur)));
    const thMax = Math.max(...s.idx.map((i) => Math.abs(s.th(r[i]))));
    const sScale = Math.max(Math.max(...ref.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))), TOL.thermalFrac * s.p.E * s.p.alpha * thMax);
    const uTol = TOL.dispFrac * uScale + TOL.dispFloor;
    const sTol = TOL.stressFrac * sScale + TOL.stressFloor;
    let du = 0, ds = 0;
    s.idx.forEach((i, k) => {
      du = Math.max(du, Math.abs(D[i][0] - ref[k].ur));
      ds = Math.max(ds, Math.abs(S[i][0] - ref[k].sigmaR), Math.abs(S[i][3] - ref[k].sigmaTheta), Math.abs(S[i][5] - ref[k].sigmaZ));
    });
    res[s.name] = { uScale, uDev: du, uTol, uOk: du <= uTol, sScale, sDev: ds, sTol, sOk: ds <= sTol, sMaxIndepMPa: Math.max(...ref.flatMap((x) => [x.sigmaR, x.sigmaTheta, x.sigmaZ].map(Math.abs))) / 1e6 };
    if (du > uTol) pass.u = false;
    if (ds > sTol) pass.s = false;
    // equilibrium of OFFBEAT's own stress
    let worst = 0;
    const pts = s.idx.map((i) => ({ r: r[i], sr: S[i][0], st: S[i][3], sz: S[i][5] }));
    const scaleO = Math.max(Math.max(...pts.flatMap((x) => [x.sr, x.st, x.sz].map(Math.abs))), TOL.thermalFrac * s.p.E * s.p.alpha * thMax);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const h = b.r - a.r;
      worst = Math.max(worst, Math.abs(b.sr - a.sr + (h / 2) * ((a.sr - a.st) / a.r + (b.sr - b.st) / b.r)));
    }
    res[s.name].eqRes = worst;
    res[s.name].eqTol = TOL.eqFrac * scaleO + TOL.stressFloor;
    res[s.name].eqOk = worst <= res[s.name].eqTol;
    if (!res[s.name].eqOk) pass.eq = false;
  }
  // contact: OFFBEAT's interface pressure and gap width at fuelOuter
  const nearly = Math.abs(sol.freeGap) < TOL.nearlyClosed;
  // a pressure above the 10 kPa floor of the steady checks means touching; a smaller one (OFFBEAT writes 1e-6 Pa to 1e-3 Pa at an open gap while its relaxed pressure decays) and a gap at or below zero with no pressure do not, the same floor as the contact tolerance
  const touch = intP !== null ? intP > TOL.pFloor : gapW !== null && gapW <= 0;
  res.offContact = touch;
  res.offP = intP;
  res.offGapUm = gapW === null ? null : gapW * 1e6;
  let cOk, cNote;
  if (!nearly && touch !== sol.contact) { cOk = false; cNote = "touch state differs"; }
  else if (sol.contact && touch) {
    const dev = Math.abs((intP ?? 0) - sol.contactPressure);
    const bound = TOL.pFrac * sol.contactPressure + TOL.pFloor;
    cOk = dev <= bound; cNote = `dP ${(dev / 1e6).toFixed(3)} MPa (bound ${(bound / 1e6).toFixed(3)})`;
    res.pErrRel = (intP - sol.contactPressure) / sol.contactPressure;
  } else if (!sol.contact && !touch && gapW !== null) {
    const dev = Math.abs(gapW - sol.gap);
    const bound = TOL.gapFrac * Math.abs(sol.gap) + TOL.gapFloor;
    cOk = dev <= bound; cNote = `dGap ${(dev * 1e6).toFixed(3)} um (bound ${(bound * 1e6).toFixed(3)})`;
  } else { cOk = nearly; cNote = nearly ? "nearly closed, not judged" : "not comparable"; }
  res.contactOk = cOk;
  res.contactNote = cNote;
  res.allOk = pass.u && pass.s && pass.eq && cOk;
  res.uOk = pass.u; res.sOk = pass.s; res.eqOk = pass.eq;
  return res;
}

if (process.argv.includes("--tonly")) {
  // only the temperatures: OFFBEAT's T of each written time against FEED's finite-volume T (a run with or without mechanics)
  let worst = 0;
  const pts = [];
  for (const { d, t } of times) {
    const fv = fvAt(t);
    if (!fv) continue;
    const Tt = listField(fs.readFileSync(path.join(outDir, "times", d, "T"), "utf8"), 1).map((v) => v[0]);
    const dT = Math.max(...Tt.map((x, i) => Math.abs(x - fv.T[i])));
    worst = Math.max(worst, dT);
    pts.push([t, dT]);
  }
  const at = (t) => pts.reduce((p, q) => (Math.abs(q[0] - t) < Math.abs(p[0] - t) ? q : p));
  console.log(JSON.stringify({ worstDiffK: worst, at: [0.03, 0.06, 0.1, 1, 10, 30, 100].map((t) => at(t)) }));
  process.exit(0);
}
const rows = [];
for (const { d, t } of times) {
  const dir = path.join(outDir, "times", d);
  const rd = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : null);
  const Tt = rd("T"), Dt = rd("D"), St = rd("sigmaCyl") || rd("sigma"), Gt = rd("gapWidth"), It = rd("interfaceP");
  if (!Tt || !Dt || !St) { rows.push({ time: t, missing: true }); continue; }
  const Toff = listField(Tt, 1).map((v) => v[0]);
  const D = listField(Dt, 3), S = listField(St, 6);
  const gapW = Gt ? patchScalar(Gt, "fuelOuter") : null;
  const intP = It ? patchScalar(It, "fuelOuter") : null;
  const props = fuelProps2 && t > s1.end + 1e-9 ? { fuel: fuelProps2, clad: cladProps } : undefined;
  const a = compare(Toff, D, S, gapW, intP, Toff, props);
  const row = { time: t, dir: d, Tfuel: { min: Math.min(...Toff.slice(0, nf)), max: Math.max(...Toff.slice(0, nf)) }, Tclad: { min: Math.min(...Toff.slice(nf)), max: Math.max(...Toff.slice(nf)) }, withOffbeatT: a };
  const fv = fvAt(t);
  if (fv) {
    row.withFvT = compare(Toff, D, S, gapW, intP, fv.T, props);
    row.dTfvMax = Math.max(...Toff.map((x, i) => Math.abs(x - fv.T[i])));
  }
  row.ur = { fuelOuter: D[nf - 1][0], cladInner: D[nf][0] };
  row.sigmaMaxMPa = { fuelHoopMin: Math.min(...S.slice(0, nf).map((x) => x[3])) / 1e6, fuelHoopMax: Math.max(...S.slice(0, nf).map((x) => x[3])) / 1e6, cladHoopMax: Math.max(...S.slice(nf).map((x) => x[3])) / 1e6 };
  rows.push(row);
}
const j = process.argv.indexOf("--json");
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify({ meta, rows }, null, 1) + "\n");
const f = (x, d = 3) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));
console.log("time_ms  Tfuel[min,max]  dTfv  | OFFBEAT-T: P_off  P_ind  err%  gap_off  gap_ind  u s eq c | FV-T: P_ind err% u s eq c");
for (const w of rows) {
  if (w.missing) { console.log(w.time, "missing fields"); continue; }
  const a = w.withOffbeatT, b = w.withFvT;
  const ok = (x) => (x ? "Y" : "n");
  console.log(
    `${f(w.time * 1e3, 2).padStart(8)} ${f(w.Tfuel.min, 1)},${f(w.Tfuel.max, 1)} ${f(w.dTfvMax, 3)} | ${f((a.offP ?? 0) / 1e6, 2)} ${f(a.indepP / 1e6, 2)} ${f((a.pErrRel ?? NaN) * 100, 2)} ${f(a.offGapUm, 2)} ${f(a.indepGapUm, 2)} ${ok(a.uOk)}${ok(a.sOk)}${ok(a.eqOk)}${ok(a.contactOk)} | ${b ? `${f(b.indepP / 1e6, 2)} ${f((b.pErrRel ?? NaN) * 100, 2)} ${ok(b.uOk)}${ok(b.sOk)}${ok(b.eqOk)}${ok(b.contactOk)}` : "-"}`,
  );
}
