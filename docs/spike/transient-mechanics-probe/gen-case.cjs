// Throw-away probe of plan 17 M0 (docs/spike/transient-mechanics-probe.md). Writes an OFFBEAT case folder for the TRIGA pulse example WITH the mechanics on, which FEED's
// validator refuses for a transient (E_UNSUPPORTED): FEED's writer is used twice (the pulse as a thermal-only transient, and a steady mechanics sibling with the same geometry and
// materials) and the two case folders are merged here by text edits. Nothing in src/ is changed. Needs `npm run build` (reads dist/core).
//
// usage: node gen-case.cjs --out DIR [--gap-um 0] [--penalty 0.7] [--mech 1] [--outputs 40] [--ref-ms 100] [--laws 0] [--cool-s 0] [--cool-dt-ms 50] [--cool-outputs 60]
//                          [--end-ms 100] [--relax 0.5] [--e-fuel X --alpha-fuel X]
//   --mech 0      the thermal-only case exactly as FEED writes it (the control)
//   --ref-ms      the time of the independent (finite-volume) profile at which the fuel's constants E and alpha are reduced (FEED's rule, at that time)
//   --laws 1      the fuel's E(T) and thermal strain given to OFFBEAT as its own temperature-dependent models (YoungModulusTobbe1515Ti, thermalExpansionGehr1515Ti) instead of constants
//   --cool-s N    adds stage2/controlDict (a restart from the last time of stage 1 with a larger step until N seconds) and extends the power table with a ramp to zero at the end of the pulse
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const { validateCase } = require(path.join(root, "dist/core/validate.js"));
const { writeOffbeatCase } = require(path.join(root, "dist/core/caseWriter.js"));
const tr = require(path.join(root, "dist/core/transientResults.js"));

const arg = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i < 0 ? d : process.argv[i + 1];
};
const out = arg("out");
if (!out) throw new Error("--out DIR");
const gapUm = Number(arg("gap-um", "0"));
const penalty = Number(arg("penalty", "0.7"));
const mech = arg("mech", "1") === "1";
const outputs = Number(arg("outputs", "40"));
const refMs = Number(arg("ref-ms", "100"));
const laws = arg("laws", "0") === "1";
const coolS = Number(arg("cool-s", "0"));
const coolDtMs = Number(arg("cool-dt-ms", "50"));
const coolOutputs = Number(arg("cool-outputs", "60"));
const endMs = Number(arg("end-ms", "100"));
const relaxD = arg("relax", "0.5");
const maxOuter = arg("max-outer");
const nCorr = arg("ncorr");
const relaxIf = arg("relax-interface");
const INNER_ZG = "    fuelInner\n    {\n        type            zeroGradient;\n    }";
const INNER_TRACTION = "    fuelInner\n    {\n        type            tractionDisplacement;\n        traction        uniform (0 0 0);\n        pressure        uniform 0;\n        relax           1.0;\n        value           uniform (0 0 0);\n    }";
const innerBc = arg("inner-bc", "zeroGradient"); // the hole of the TRIGA fuel: the writer's zeroGradient or a traction-free tractionDisplacement
const TREF = 293.15; // 20 C: the temperature the pulse starts at

const q = (value, unit) => ({ value, unit });
const example = JSON.parse(fs.readFileSync(path.join(root, "examples/ut-triga-pulse-4p40-limits.json"), "utf8"));
const lib = JSON.parse(fs.readFileSync(path.join(root, "library/materials.json"), "utf8"));
const mechSets = (id) => {
  const m = lib.find((e) => e.material && e.material.materialId === id).material;
  const s = {};
  for (const [k, v] of Object.entries(m.sets)) if (k.startsWith("mechanical.")) s[k] = v;
  return s;
};
const fuelMech = mechSets("triga-uzrh-h16");
const cladMech = mechSets("ss304-k166");

// ---- the thermal pulse case (FEED's own writer, the example's geometry and power history, the gap as asked) ----
const base = JSON.parse(JSON.stringify(example));
delete base.limits;
base.geometry.claddingInnerRadius = q(18.161 + gapUm / 1000, "mm");
// --keep-thickness 1: the cladding keeps its 0.508 mm wall (the outer radius moves with the gap); otherwise the gap is cut from the wall and the outer radius stays 18.669 mm (the runs of the gap sweep)
if (arg("keep-thickness", "0") === "1") base.geometry.claddingOuterRadius = q(18.669 + gapUm / 1000, "mm");
base.transient.outputs = outputs;
if (endMs !== 100) base.transient.endTime = q(endMs, "ms");
const v = validateCase(base);
if (!v.normalized) throw new Error("thermal case refused: " + JSON.stringify(v.errors));
const c = v.normalized;
const files = writeOffbeatCase(c).files;

// ---- the constants: FEED's rule (E at the area-mean temperature, alpha giving the mean thermal strain) on the independent profile at refMs ----
const fv = tr.independentSolution(c, 1, 1, false);
const stateAt = (ms) => fv.states.reduce((a, b) => (Math.abs(b.time - ms / 1e3) < Math.abs(a.time - ms / 1e3) ? b : a));
const nf = c.mesh.fuelCells;
const faces = Array.from({ length: nf + 1 }, (_, i) => c.fuelInnerRadius + ((c.fuelRadius - c.fuelInnerRadius) * i) / nf);
const area = (i) => faces[i + 1] ** 2 - faces[i] ** 2;
const aF = lib.find((e) => e.material.materialId === "triga-uzrh-h16").material.sets["mechanical.thermalExpansion"].linearExpansion;
const alphaA = aF.a.value, alphaB = aF.b.value;
const eF = fuelMech["mechanical.elasticity"];
const Ea = eF.a.value, Eb = eF.b.value;
const strainOf = (T) => alphaA * (T - TREF) + 0.5 * alphaB * (T * T - TREF * TREF);
function reduce(ms) {
  const st = stateAt(ms);
  let wsum = 0, tsum = 0, esum = 0;
  for (let i = 0; i < nf; i++) {
    wsum += area(i);
    tsum += area(i) * st.T[i];
    esum += area(i) * strainOf(st.T[i]);
  }
  const Tm = tsum / wsum;
  const E = Ea + Eb * Tm;
  const alpha = Math.abs(Tm - TREF) < 1e-9 ? alphaA + alphaB * Tm : esum / wsum / (Tm - TREF);
  return { time: st.time, meanT: Tm, E, alpha };
}
let fuelE = reduce(refMs);
if (arg("e-fuel")) fuelE = { ...fuelE, E: Number(arg("e-fuel")), alpha: Number(arg("alpha-fuel")), time: "given" };
const clad = { E: 190e9, nu: 0.3, alpha: 17.2e-6 };
const fuel = { E: fuelE.E, nu: 0.32, alpha: fuelE.alpha };

if (mech) {
  // ---- the steady mechanics sibling: the same geometry and materials, for the D file, the fvSolution and the rheology sections ----
  const sib = JSON.parse(JSON.stringify(base));
  delete sib.transient;
  sib.assumptions = { thermalOnly: false, steadyState: true, geometry: "1D-radial" };
  sib.power = { radialShape: "uniform", linearHeatRate: q(1, "kW/m") };
  Object.assign(sib.materials.fuel.sets, fuelMech);
  Object.assign(sib.materials.cladding.sets, cladMech);
  sib.mechanics = { referenceTemperature: q(TREF, "K"), plane: "free-axial", contact: { penaltyFactor: q(penalty, "1") }, coolantPressure: q(0, "Pa") };
  const vs = validateCase(sib);
  if (!vs.normalized) throw new Error("steady mechanics sibling refused: " + JSON.stringify(vs.errors));
  const sf = writeOffbeatCase(vs.normalized).files;
  files["0/D"] = sf["0/D"];
  files["system/fvSolution"] = sf["system/fvSolution"].replace(/fields \{ D [0-9.]+; \}/, `fields { D ${relaxD}; }`);
  if (maxOuter) files["system/fvSolution"] = files["system/fvSolution"].replace(/maxOuterIter    \d+;/, `maxOuterIter    ${maxOuter};`);
  if (nCorr) files["system/fvSolution"] = files["system/fvSolution"].replace(/nCorrectors \{ D \d+; default 1; \}/, `nCorrectors { D ${nCorr}; default 1; }`);
  if (innerBc === "traction") files["0/D"] = files["0/D"].replace(INNER_ZG, INNER_TRACTION);
  if (arg("implicit", "0") === "1") files["0/D"] = files["0/D"].replace("type            gapContact;", "type            implicitGapContact;").replace("frictionCoefficient        0;", "frictionCoefficient        0;\n        penaltyFactorFriction 0.1;");
  if (relaxIf) files["0/D"] = files["0/D"].replace(/relaxInterfacePressure\s+[0-9.e-]+;/, `relaxInterfacePressure           ${relaxIf};`);
  let sd = files["constant/solverDict"];
  const block = /rheologyOptions[\s\S]*?(?=heatSourceOptions)/.exec(sf["constant/solverDict"])[0];
  if (!sd.includes("mechanicsSolver         fromLatestTime;")) throw new Error("unexpected solverDict");
  sd = sd.replace("mechanicsSolver         fromLatestTime;", "mechanicsSolver         smallStrain;");
  sd = sd.replace("heatSourceOptions", block + "heatSourceOptions");
  const setConst = (text, name, m) =>
    text.replace(new RegExp(`(    ${name}\\n    \\{[\\s\\S]*?\\n    \\})`), (blk) =>
      blk
        .replace(/E           E     \[1 -1 -2 0 0\]  [^;]+;/, `E           E     [1 -1 -2 0 0]  ${m.E};`)
        .replace(/nu          nu    \[0 0 0 0 0\]    [^;]+;/, `nu          nu    [0 0 0 0 0]    ${m.nu};`)
        .replace(/G           G     \[1 -1 -2 0 0\]  [^;]+;/, `G           G     [1 -1 -2 0 0]  ${m.E / (2 * (1 + m.nu))};`)
        .replace(/alpha       alpha \[0 0 0 0 0\]    [^;]+;/, `alpha       alpha [0 0 0 0 0]    ${m.alpha};`)
        .replace(/Tref        Tref  \[0 0 0 1 0\]    [^;]+;/, `Tref        Tref  [0 0 0 1 0]    ${TREF};`),
    );
  sd = setConst(sd, "fuel", fuel);
  sd = setConst(sd, "cladding", clad);
  if (laws) {
    // OFFBEAT's own models, picked by name from the constant material: E = (par1 - par2 T[C]) 1e9 and a thermal strain par1 + par2 T[C] + par3 T[C]^2 from 20 C
    const T0 = TREF - 273.15;
    const k1 = (-Eb * 1e-9) /* GPa per K, positive slope magnitude */;
    const par2E = -Eb / 1e9; // GPa per C (E falls with T)
    const par1E = (Ea + Eb * 273.15) / 1e9; // GPa at 0 C
    // strain(T) = alphaA (T-Tref) + alphaB/2 (T^2 - Tref^2), T in K -> in C: t = T - 273.15
    // = alphaA (t - t0) + alphaB/2 ((t+273.15)^2 - (t0+273.15)^2) = alphaB/2 t^2 + (alphaA + alphaB 273.15) t - [alphaA t0 + alphaB/2 (t0^2 + 2 t0 273.15)]
    const p3 = alphaB / 2, p2 = alphaA + alphaB * 273.15, p1 = -(alphaA * T0 + (alphaB / 2) * (T0 * T0 + 2 * T0 * 273.15));
    const add = `        YoungModulusModel steel1515TiTobbe;\n        YoungModulus { par1 ${par1E}; par2 ${par2E}; }\n        thermalExpansionModel steel1515TiGehr;\n        thermalExpansion { par1 ${p1}; par2 ${p2}; par3 ${p3}; }\n`;
    sd = sd.replace(/(    fuel\n    \{\n        material constant;\n)/, `$1${add}`);
    void k1;
  }
  if (arg("dynamic", "0") === "1") {
    // inertia: the displacement equation of smallStrain has d2dt2(rho, D) and FEED's fvSchemes switch it off (steadyState). Here: Euler, and the real densities (the fuel 5996 kg/m3 and the
    // cladding 7900 kg/m3, the figures the example quotes from the K-State SAR) with the heat capacities rescaled so that rho c, the only thing the heat equation sees, is unchanged
    files["system/fvSchemes"] = files["system/fvSchemes"].replace("d2dt2Schemes { default steadyState; }", "d2dt2Schemes { default Euler; }");
    const rho = { fuel: 5996, cladding: 7900 };
    sd = sd.replace(/(    (fuel|cladding)\n    \{[\s\S]*?\n    \})/g, (blk, _x, name) => {
      const k = 10000 / rho[name];
      let b = blk.replace(/rho         rho   \[1 -3 0 0 0\]   10000;/, `rho         rho   [1 -3 0 0 0]   ${rho[name]};`);
      b = b.replace(/heatCapacity \{ par1 ([^;]+); par2 ([^;]+); par3 0; \}/, (m0, p1, p2) => `heatCapacity { par1 ${Number(p1) * k}; par2 ${Number(p2) * k}; par3 0; }`);
      b = b.replace(/(    Cp          Cp    \[0 2 -2 -1 0\]  )([0-9.eE+-]+);/, (m0, pre, v) => `${pre}${Number(v) * k};`);
      return b;
    });
  }
  files["constant/solverDict"] = sd;
}


  // the power table: with a cooldown, the pulse's own points, then a ramp to zero 0.5 ms after the pulse and zero for good
  if (coolS > 0) {
    let sd = files["constant/solverDict"];
    const m = /timePoints  \(([^)]*)\);\n    lhgr        \(([^)]*)\);/.exec(sd);
    const tp = m[1].trim().split(/\s+/).map(Number);
    const lh = m[2].trim().split(/\s+/).map(Number);
    // drop the writer's appended flat point (one step beyond the end), keep the pulse to endMs
    const endT = endMs / 1e3;
    const keep = tp.map((t, i) => [t, lh[i]]).filter(([t]) => t < endT - 1e-12);
    const qEnd = lh[tp.findIndex((t) => Math.abs(t - endT) < 1e-12)];
    keep.push([endT, qEnd], [endT + 5e-4, 0], [coolS * 2, 0]);
    sd = sd.replace(m[0], `timePoints  (${keep.map((k) => k[0]).join(" ")});\n    lhgr        (${keep.map((k) => k[1]).join(" ")});`);
    const cd = files["system/controlDict"];
    const steps = Math.round((coolS - endT) / (coolDtMs / 1e3));
    const every = Math.max(1, Math.round(steps / coolOutputs));
    files["stage2/controlDict"] = cd
      .replace(/startFrom       latestTime;/, "startFrom       latestTime;")
      .replace(/endTime         [^;]+;/, `endTime         ${coolS};`)
      .replace(/deltaT          [^;]+;/, `deltaT          ${coolDtMs / 1e3};`)
      .replace(/writeInterval   [^;]+;/, `writeInterval   ${every};`);
    files["constant/solverDict"] = sd;
  }

// a restart at the end of stage 1 (--end-ms) with the same step to --restart-to-ms, and optionally new fuel constants (--stage2-e, --stage2-alpha) in a stage2 solverDict
const restartTo = arg("restart-to-ms");
if (restartTo) {
  const cd = files["system/controlDict"];
  files["stage2/controlDict"] = cd.replace(/endTime         [^;]+;/, `endTime         ${Number(restartTo) / 1e3};`);
  if (arg("stage2-e")) {
    const E2 = Number(arg("stage2-e")), a2 = Number(arg("stage2-alpha"));
    files["stage2/solverDict"] = files["constant/solverDict"].replace(/(    fuel\n    \{[\s\S]*?\n    \})/, (blk) =>
      blk
        .replace(/E           E     \[1 -1 -2 0 0\]  [^;]+;/, `E           E     [1 -1 -2 0 0]  ${E2};`)
        .replace(/G           G     \[1 -1 -2 0 0\]  [^;]+;/, `G           G     [1 -1 -2 0 0]  ${E2 / (2 * 1.32)};`)
        .replace(/alpha       alpha \[0 0 0 0 0\]    [^;]+;/, `alpha       alpha [0 0 0 0 0]    ${a2};`),
    );
  }
}

fs.mkdirSync(out, { recursive: true });
for (const [rel, text] of Object.entries(files)) {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const meta = { gapUm, penalty, mech, laws, refMs, reduced: fuelE, fuel, clad, Tref: TREF, outputs, cooldownSeconds: coolS, nf, nc: c.mesh.claddingCells, fuelRadius: c.fuelRadius, claddingInnerRadius: c.claddingInnerRadius, claddingOuterRadius: c.claddingOuterRadius, fuelInnerRadius: c.fuelInnerRadius, steps: c.transient.steps, timeStep: c.transient.timeStep };
fs.writeFileSync(path.join(out, "probe-meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(JSON.stringify(meta));
