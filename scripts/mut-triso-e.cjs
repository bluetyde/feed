// Mutation run for plan 14, stage E (the layered-sphere solution, the particle's mechanics section, constants, writer, results reader and checks).
// usage: node scripts/mut-triso-e.cjs [name regex]     (commit first and keep a green baseline; one mutation run at a time on this machine)
// Each mutant is [file, from, to, name]: `from` is a unique single-line anchor in `file`. The file is changed, the focus tests are run, and the file is restored from the copy read
// before (never from git). A mutant is KILLED when the run exits non-zero AND prints a "Tests N ..." summary; it SURVIVES when the run exits 0; a run with no summary line is BROKEN
// (a crashed run must not count as a kill). Judge the result by the printed table.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

const FOCUS = ["tests/layeredSphere.test.ts", "tests/trisoMechanics.test.ts", "tests/trisoMechanicsResults.test.ts", "tests/coatings.test.ts", "tests/validate.test.ts", "tests/triso.test.ts", "tests/writtenCasesUnchanged.test.ts"];
const L = "src/core/layeredSphere.ts";
const M = "src/core/trisoMechanics.ts";
const R = "src/core/trisoMechanicsResults.ts";
const W = "src/core/trisoMechanicsWriter.ts";
const V = "src/core/validate.ts";
const RM = "src/core/runManager.ts";

const mutants = [
  // ---- the layered-sphere solution
  [L, "return (2 * (1 - 2 * l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));", "return (1 * (1 - 2 * l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));", "k: factor 2 lost"],
  [L, "return (2 * (1 - 2 * l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));", "return (2 * (1 - l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));", "k: (1 - nu) for (1 - 2 nu)"],
  [L, "return (2 * (1 - 2 * l.nu) * ((l.eR ?? 0) - (l.eT ?? 0))) / (3 * (1 - l.nu));", "return (2 * (1 - 2 * l.nu) * ((l.eT ?? 0) - (l.eR ?? 0))) / (3 * (1 - l.nu));", "k: sign"],
  [L, "if (this.noLog) return 0;", "if (false) return 0;", "the negative-test hook does nothing"],
  [L, "return this.k(i) * x * Math.log(r / l.a) + (l.theta ? (g * this.thetaIntegral(i, r)) / (x * x) : 0);", "return this.k(i) * x * Math.log(r / l.a) + (l.theta ? (g * this.thetaIntegral(i, r)) / x : 0);", "u_p: thermal part divided by x"],
  [L, "return this.k(i) * x * Math.log(r / l.a) + (l.theta ? (g * this.thetaIntegral(i, r)) / (x * x) : 0);", "return this.k(i) * x * Math.log(r / l.a) + (l.theta ? (this.thetaIntegral(i, r)) / (x * x) : 0);", "u_p: thermal part without (1 + nu)/(1 - nu)"],
  [L, "er += g * (l.theta(r) - (2 * I) / (x * x * x));", "er += g * (l.theta(r) - I / (x * x * x));", "strain_p radial: 2 I lost"],
  [L, "et += (g * I) / (x * x * x);", "et += (g * I) / (x * x);", "strain_p tangential: x^2"],
  [L, "let er = k * (lg + 1);", "let er = k * lg;", "strain_p radial: the +1 of r ln r"],
  [L, "let et = k * lg;", "let et = k * (lg + 1);", "strain_p tangential: a +1"],
  [L, "ca: c * (1 + l.nu),", "ca: c * (1 - l.nu),", "sigma_r: A coefficient"],
  [L, "cb: (-2 * c * (1 - 2 * l.nu)) / (x * x * x),", "cb: (-1 * c * (1 - 2 * l.nu)) / (x * x * x),", "sigma_r: B coefficient"],
  [L, "rhs: c * ((1 - l.nu) * (sp.er - fs.er) + 2 * l.nu * (sp.et - fs.et)),", "rhs: c * ((1 - l.nu) * (sp.er - fs.er) + l.nu * (sp.et - fs.et)),", "sigma_r: tangential coupling 2 nu lost"],
  [L, "rhs: c * ((1 - l.nu) * (sp.er - fs.er) + 2 * l.nu * (sp.et - fs.et)),", "rhs: c * ((1 - l.nu) * (sp.er) + 2 * l.nu * (sp.et - fs.et)),", "sigma_r: radial free strain not subtracted"],
  [L, "return l.E / ((1 + l.nu) * (1 - 2 * l.nu));", "return l.E / ((1 + l.nu) * (1 - l.nu));", "c: (1 - 2 nu)"],
  [L, "sigmaT: c * (epsT - fs.et + l.nu * (epsR - fs.er)),", "sigmaT: c * (epsT - fs.et - l.nu * (epsR - fs.er)),", "sigma_t: Poisson sign"],
  [L, "sigmaR: c * ((1 - l.nu) * (epsR - fs.er) + 2 * l.nu * (epsT - fs.et)),", "sigmaR: c * ((1 - l.nu) * (epsR - fs.er) + l.nu * (epsT - fs.et)),", "at: sigma_r coupling"],
  [L, "u: this.s * (A * x + B / (x * x) + this.uParticular(i, r)),", "u: this.s * (A * x + B / x + this.uParticular(i, r)),", "at: displacement B term"],
  [L, "const epsT = A + B / (x * x * x) + sp.et;", "const epsT = A - B / (x * x * x) + sp.et;", "at: tangential strain B sign"],
  [L, "const epsR = A - (2 * B) / (x * x * x) + sp.er;", "const epsR = A - (1 * B) / (x * x * x) + sp.er;", "at: radial strain B factor"],
  [L, "y[row] = this.uParticular(i + 1, r) - this.uParticular(i, r);", "y[row] = this.uParticular(i, r) - this.uParticular(i + 1, r);", "interface displacement: sign of the particular part"],
  [L, "y[row] = t1.rhs - t0.rhs;", "y[row] = t0.rhs - t1.rhs;", "interface stress: sign of the particular part"],
  [L, "surface(0, layers[0]!.a, -pIn);", "surface(0, layers[0]!.a, pIn);", "inner pressure sign"],
  [L, "surface(n - 1, layers[n - 1]!.b, -pOut);", "surface(n - 1, layers[n - 1]!.b, -pIn);", "outer pressure is the inner"],
  [L, "M[row]![2 * i + 3] = -1 / (x * x);", "M[row]![2 * i + 3] = 1 / (x * x);", "interface displacement: next B sign"],
  [L, "M[row]![2 * i + 2] = -t1.ca;", "M[row]![2 * i + 2] = t1.ca;", "interface stress: next A sign"],
  [L, "sum += GL.w[q]! * half * l.theta(xs * this.s) * xs * xs;", "sum += GL.w[q]! * half * l.theta(xs * this.s) * xs;", "theta integral: s^2 weight"],
  [L, "const panels = 4;", "const panels = 1;", "theta integral: one panel"],
  [L, "const GL = gaussLegendre(24);", "const GL = gaussLegendre(2);", "theta integral: two points"],
  [L, "if (!(l.a > 0 && l.b > l.a)) throw new Error(", "if (false) throw new Error(", "radii not checked"],
  [L, "if (!(l.E > 0 && l.nu >= 0 && l.nu < 0.5)) throw new Error(", "if (false) throw new Error(", "moduli not checked"],
  [L, "if (i > 0 && Math.abs(l.a - layers[i - 1]!.b) > 1e-12 * l.a) throw new Error(", "if (false) throw new Error(", "touching not checked"],
  [L, "for (let i = 0; i < this.L.length; i++) if (r >= this.L[i]!.a * (1 - 1e-12) && r <= this.L[i]!.b * (1 + 1e-12)) return i;", "for (let i = 0; i < this.L.length; i++) if (r >= this.L[i]!.a * (1 - 1e-12)) return i;", "layerOf: no outer bound"],
  [L, "if (!l.theta || r <= l.a) return 0;", "if (!l.theta) return 0;", "theta integral: below the inner radius"],
  // ---- the section and the constants
  [M, "else if (!(ref > 0 && ref <= 10000)) {", "else if (!(ref > 0)) {", "reference temperature upper bound"],
  [M, "if (!(positive ? p > 0 : p >= 0) || p > TRISO_MAX_PRESSURE) {", "if (!(p > 0) || p > TRISO_MAX_PRESSURE) {", "outside pressure must be positive"],
  [M, "if (!(positive ? p > 0 : p >= 0) || p > TRISO_MAX_PRESSURE) {", "if (!(positive ? p > 0 : p >= 0)) {", "pressure upper bound"],
  [M, "if (!(positive ? p > 0 : p >= 0) || p > TRISO_MAX_PRESSURE) {", "if (!(p >= 0) || p > TRISO_MAX_PRESSURE) {", "gas pressure may be zero"],
  [M, "if (!(Math.abs(v) <= TRISO_MAX_FREE_STRAIN)) {", "if (!(v <= TRISO_MAX_FREE_STRAIN)) {", "free strain bound one-sided"],
  [M, "if (!(Math.abs(v) <= TRISO_MAX_FREE_STRAIN)) {", "if (!(Math.abs(v) < TRISO_MAX_FREE_STRAIN)) {", "free strain bound exclusive"],
  [M, "else if (seen.has(layer)) bad(", "else if (false) bad(", "duplicate free strain accepted"],
  [M, "} else if (!layers.includes(layer)) bad(\"E_GEOMETRY\"", "} else if (false) bad(\"E_GEOMETRY\"", "free strain on an absent layer accepted"],
  [M, "if (layer === \"buffer\") bad(\"E_UNSUPPORTED\"", "if (false) bad(\"E_UNSUPPORTED\"", "free strain on the buffer accepted as unknown"],
  [M, "if (typeof f.source !== \"string\" || f.source.trim() === \"\") bad(", "if (false) bad(", "free strain without a source accepted"],
  [M, "if (typeof g.source !== \"string\" || g.source.trim() === \"\") bad(", "if (false) bad(", "gas pressure without a source accepted"],
  [M, "const N = 200;", "const N = 2;", "layer mean: two intervals"],
  [M, "const wt = c * r * r;", "const wt = c * r;", "layer mean: r weight, not r^2"],
  [M, "const c = i === 0 || i === N ? 1 : i % 2 === 1 ? 4 : 2;", "const c = i === 0 || i === N ? 1 : i % 2 === 1 ? 2 : 2;", "layer mean: Simpson weights"],
  [M, "const alpha = Math.abs(dT) < 1e-9 ? alphaAt(p.expansion, s.meanT) : s.mean / dT;", "const alpha = Math.abs(dT) < 1e-9 ? alphaAt(p.expansion, s.meanT) : s.mean / s.meanT;", "alpha: strain over T, not over T - Tref"],
  [M, "const E = elasticityAt(p.elasticity, s.meanT);", "const E = elasticityAt(p.elasticity, s.min);", "E at the coldest temperature"],
  [M, "G: E / (2 * (1 + nu)),", "G: E / (2 * (1 - nu)),", "shear modulus"],
  [M, "elasticityOutOfRange: outside(p.elasticity.range, s.min, s.max),", "elasticityOutOfRange: false,", "elasticity range never reported"],
  [M, "expansionOutOfRange: outside(p.expansion.kind === \"linear\" ? p.expansion.range : undefined, Math.min(s.min, Tref), Math.max(s.max, Tref)),", "expansionOutOfRange: outside(p.expansion.kind === \"linear\" ? p.expansion.range : undefined, s.min, s.max),", "expansion range without the reference temperature"],
  [M, "return solveHot(lawOf(l.conductivity), reg.outerT, (n.power.particlePower / (4 * Math.PI)) * (1 / r - 1 / l.outerRadius));", "return solveHot(lawOf(l.conductivity), reg.outerT, (n.power.particlePower / (4 * Math.PI)) * (1 / r));", "layer temperature: outer face lost"],
  [M, "const reg = cf.regions[index + 1]!;", "const reg = cf.regions[index]!;", "layer temperature: the region before"],
  [M, "theta: (r: number) => c.alpha * (trisoLayerTemperature(n, cf, index, r) - m.referenceTemperature),", "theta: (r: number) => c.alpha * (trisoLayerTemperature(n, cf, index, r) + m.referenceTemperature),", "theta: reference temperature sign"],
  [M, "...(c.freeStrain ? { eR: c.freeStrain.radial, eT: c.freeStrain.tangential } : {}),", "...(c.freeStrain ? { eR: c.freeStrain.tangential, eT: c.freeStrain.radial } : {}),", "free strain components swapped"],
  [M, "return new LayeredSphere(layers, m.gasPressure, m.outsidePressure, options);", "return new LayeredSphere(layers, m.outsidePressure, m.gasPressure, options);", "pressures swapped"],
  // ---- the writer
  [W, "const x = (rUm * Math.cos(TRISO_MECH_WEDGE_HALF)) / WEDGE_S;", "const x = rUm * Math.cos(TRISO_MECH_WEDGE_HALF);", "vertex x not on the sphere"],
  [W, "const y = (rUm * Math.sin(TRISO_MECH_WEDGE_HALF)) / WEDGE_S;", "const y = rUm * Math.sin(TRISO_MECH_WEDGE_HALF);", "vertex y not on the sphere"],
  [W, "export const TRISO_MECH_WEDGE_HALF_ANGLE_DEG = 0.25;", "export const TRISO_MECH_WEDGE_HALF_ANGLE_DEG = 1;", "wedge as wide as the thermal one"],
  [W, "(1 1 ${n.cells[index + 1]}) simpleGrading (1 1 1)`;", "(1 1 ${n.cells[index]}) simpleGrading (1 1 1)`;", "block cell count from the wrong layer"],
  [W, "${patch(TRISO_MECH_PATCHES.inner, \"patch\", face(0, 0, 1, 2, 3))}", "${patch(TRISO_MECH_PATCHES.inner, \"patch\", face(0, 4, 5, 6, 7))}", "inner patch on the wrong face"],
  [W, "${patch(TRISO_MECH_PATCHES.outer, \"patch\", face((ks.length - 1) * 4, 4, 5, 6, 7))}", "${patch(TRISO_MECH_PATCHES.outer, \"patch\", face((ks.length - 1) * 4, 0, 1, 2, 3))}", "outer patch on the wrong face"],
  [W, "${patch(\"top\", \"wedge\", sides(0, 1, 5, 4))}", "${patch(\"top\", \"patch\", sides(0, 1, 5, 4))}", "top plane not a wedge"],
  [W, "return trisoMechanicsCells(n).map((c) => trisoLayerTemperature(n, cf, n.layers.findIndex((l) => l.name === c.layer), trisoCellCentre(c.a, c.b)));", "return trisoMechanicsCells(n).map((c) => trisoLayerTemperature(n, cf, n.layers.findIndex((l) => l.name === c.layer), c.a));", "cell temperature at the cell's inner face"],
  [W, "value           uniform ${num(cf.regions[2]!.innerT)};", "value           uniform ${num(cf.regions[1]!.outerT)};", "inner face temperature from the buffer's side"],
  [W, "value           uniform ${num(cf.wallT)};", "value           uniform ${num(cf.regions[2]!.innerT)};", "outer face temperature"],
  [W, "${traction(TRISO_MECH_PATCHES.outer, m.outsidePressure)}${traction(TRISO_MECH_PATCHES.inner, m.gasPressure)}}", "${traction(TRISO_MECH_PATCHES.outer, m.gasPressure)}${traction(TRISO_MECH_PATCHES.inner, m.outsidePressure)}}", "pressures on the wrong patches"],
  [W, "thermalExpansion on;", "thermalExpansion off;", "thermal expansion off"],
  [W, "thermalSolver           constant;", "thermalSolver           solidConduction;", "conduction solved"],
  [W, "fastFlux                ${free ? \"timeDependentAxialProfile\" : \"none\"};", "fastFlux                none;", "no flux model with a free strain"],
  [W, "radialCoefficients          (${num(fs.radial)} 0 0 0 0 0);", "radialCoefficients          (${num(fs.tangential)} 0 0 0 0 0);", "radial coefficient from the tangential strain"],
  [W, "tangentialCoefficients      (${num(fs.tangential)} 0 0 0 0 0);", "tangentialCoefficients      (${num(fs.radial)} 0 0 0 0 0);", "tangential coefficient from the radial strain"],
  [W, "timePoints  (0 ${num(2 * TRISO_MECH_END_TIME)});", "timePoints  (0 ${num(TRISO_MECH_END_TIME)});", "flux table ends at the end time"],
  [W, "fastFlux    (${num(TRISO_MECH_FLUX)} ${num(TRISO_MECH_FLUX)});", "fastFlux    (${num(TRISO_MECH_FLUX)} 0);", "flux falls to zero"],
  [W, "materials (${zones});", "materials (IPyC);", "flux applied to one zone only"],
  [W, "Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature)};\n\n        rheologyModel", "Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature + 1)};\n\n        rheologyModel", "Tref of a free-strain layer"],
  [W, "alpha       alpha [0 0 0 0 0]    ${num(k.alpha)};\n        Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature)};\n\n        rheologyModel", "alpha       alpha [0 0 0 0 0]    ${num(k.alpha * 1.01)};\n        Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature)};\n\n        rheologyModel", "alpha of a free-strain layer"],
  [W, "\"system/controlDict\": controlDict(TRISO_MECH_END_TIME, { timeStep: TRISO_MECH_END_TIME, writeEvery: 1 }),", "\"system/controlDict\": controlDict(TRISO_MECH_END_TIME, { timeStep: 1, writeEvery: 1 }),", "ten steps of one second"],
  [W, "\"system/fvSolution\": fvSolutionText(true),", "\"system/fvSolution\": fvSolutionText(false),", "thermal relaxation of the displacement"],
  [W, "return n.mechanics ? writeTrisoMechanicsCase(n) : writeTrisoCase(n);", "return n.mechanics ? writeTrisoCase(n) : writeTrisoCase(n);", "mechanics case written as thermal"],
  [W, "return n.mechanics ? writeTrisoMechanicsCase(n) : writeTrisoCase(n);", "return writeTrisoMechanicsCase(n);", "thermal case written as mechanics"],
  // ---- the results reader and the checks
  [R, "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress: { fraction: 0.5, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress tolerance 50 %"],
  [R, "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress: { fraction: 0.01, floor: 1e7, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress floor 10 MPa"],
  [R, "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1e4 },", "wedge allowance huge"],
  [R, "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 0.01, wedgeAllowance: 1.0 },", "stress: { fraction: 0.01, floor: 1e4, thermalFraction: 1, wedgeAllowance: 1.0 },", "thermal stress scale 100 % of E alpha dT"],
  [R, "displacement: { fraction: 0.005, floor: 1e-10 },", "displacement: { fraction: 0.5, floor: 1e-10 },", "displacement tolerance 50 %"],
  [R, "equilibrium: { fraction: 0.02, floor: 1e4 },", "equilibrium: { fraction: 2, floor: 1e4 },", "equilibrium tolerance 200 %"],
  [R, "interface: { stressFraction: 0.02, floor: 1e4, displacementFraction: 0.005 },", "interface: { stressFraction: 2, floor: 1e4, displacementFraction: 0.005 },", "interface stress tolerance 200 %"],
  [R, "interface: { stressFraction: 0.02, floor: 1e4, displacementFraction: 0.005 },", "interface: { stressFraction: 0.02, floor: 1e4, displacementFraction: 5 },", "interface displacement tolerance 500 %"],
  [R, "symmetry: { fraction: 1e-6, floor: 1 },", "symmetry: { fraction: 1e-6, floor: 1e7 },", "symmetry floor 10 MPa"],
  [R, "temperature: 0.01,", "temperature: 100,", "temperature tolerance 100 K"],
  [R, "freeStrain: 1e-9,", "freeStrain: 1,", "free strain tolerance 1"],
  [R, "centre: 1e-3,", "centre: 10,", "centre tolerance 1000 %"],
  [R, "const radius = C.map((p) => Math.hypot(p[0]!, p[1]!, p[2]!));", "const radius = C.map((p) => Math.hypot(p[1]!, p[2]!));", "radius from the wrong components"],
  [R, "const want = TRISO_MECH_WEDGE_SCALE * trisoCellCentre(e.a, e.b);", "const want = TRISO_MECH_WEDGE_SCALE * e.a;", "cell centre at the cell's inner radius"],
  [R, "if (labels.length !== want) bad(", "if (false) bad(", "zone cell count not checked"],
  [R, "if (layerOf[l] !== -1) bad(", "if (false) bad(", "cell in two zones accepted"],
  [R, "for (const z of zones.keys()) if (!wanted.includes(z)) bad(", "for (const z of zones.keys()) if (false) bad(", "foreign zone accepted"],
  [R, "if (T.length !== total) bad(", "if (false) bad(", "cell count of T not checked"],
  [R, "if (C.length !== total) bad(", "if (false) bad(", "cell count of C not checked"],
  [R, "const ur = (D[cell]![0]! * C[cell]![0]! + D[cell]![1]! * C[cell]![1]! + D[cell]![2]! * C[cell]![2]!) / r;", "const ur = D[cell]![1]!;", "displacement from the wrong component"],
  [R, "const rEval = input.hook?.evaluateAt === \"inner-face\" ? TRISO_MECH_WEDGE_SCALE * expected[rank]!.a : r;", "const rEval = r;", "the face-evaluation hook does nothing"],
  [R, "return { sigmaR: p.sigmaR, sigmaT: p.sigmaT, ur: TRISO_MECH_WEDGE_SCALE * p.u };", "return { sigmaR: p.sigmaR, sigmaT: p.sigmaT, ur: p.u };", "independent displacement not scaled to the wedge"],
  [R, "const p = sol.at(rWedge / TRISO_MECH_WEDGE_SCALE, layer);", "const p = sol.at(rWedge, layer);", "independent evaluated at the wedge radius"],
  [R, "const dt = Math.abs(c.sigmaT - c.ind.sigmaT);", "const dt = 0;", "tangential stress not compared"],
  [R, "const dr = Math.abs(c.sigmaR - c.ind.sigmaR);", "const dr = 0;", "radial stress not compared"],
  [R, "const du = Math.abs(c.ur - c.ind.ur);", "const du = 0;", "displacement not compared"],
  [R, "if (dt > p.sTol || dr > p.sTol) {", "if (dt > p.sTol) {", "radial stress cannot fail"],
  [R, "const allowance = tol.stress.wedgeAllowance * a2 * (k.E / (1 - k.nu)) * strainMax;", "const allowance = 0;", "no wedge allowance"],
  [R, "const resid = Math.abs((b.sigmaR - a.sigmaR) / h + (2 * ((a.sigmaR + b.sigmaR) / 2 - (a.sigmaT + b.sigmaT) / 2)) / rm) * thickness;", "const resid = Math.abs((b.sigmaR - a.sigmaR) / h + (2 * ((a.sigmaR + b.sigmaR) / 2 - (a.sigmaT + b.sigmaT) / 2)) / rm) * h;", "equilibrium residual times the spacing"],
  [R, "const resid = Math.abs((b.sigmaR - a.sigmaR) / h + (2 * ((a.sigmaR + b.sigmaR) / 2 - (a.sigmaT + b.sigmaT) / 2)) / rm) * thickness;", "const resid = Math.abs((b.sigmaR - a.sigmaR) / h) * thickness;", "equilibrium without the hoop term"],
  [R, "const face = A.k.outerRadius * TRISO_MECH_WEDGE_SCALE;", "const face = A.k.innerRadius * TRISO_MECH_WEDGE_SCALE;", "interface at the inner radius"],
  [R, "interfaceStress.push((sA + sB) / 2);", "interfaceStress.push(sA + sB);", "interface stress is the sum"],
  [R, "if (Math.abs(sA - sB) > sTol || Math.abs(uA - uB) > uTol) pass = false;", "if (Math.abs(sA - sB) > sTol) pass = false;", "interface displacement cannot fail"],
  [R, "if (Math.abs(sA - sB) > sTol || Math.abs(uA - uB) > uTol) pass = false;", "if (Math.abs(uA - uB) > uTol) pass = false;", "interface stress cannot fail"],
  [R, "const d = Math.abs(c.sigmaT - c.sigmaTz);", "const d = 0;", "symmetry not checked"],
  [R, "worst = Math.max(worst, Math.abs(e[XX]! - wantR), Math.abs(e[YY]! - wantT), Math.abs(e[ZZ]! - wantT));", "worst = Math.max(worst, Math.abs(e[YY]! - wantT), Math.abs(e[ZZ]! - wantT));", "radial free strain not checked"],
  [R, "worst = Math.max(worst, Math.abs(e[XX]! - wantR), Math.abs(e[YY]! - wantT), Math.abs(e[ZZ]! - wantT));", "worst = Math.max(worst, Math.abs(e[XX]! - wantR));", "tangential free strain not checked"],
  [R, "checks.push({ id: \"mechanicsFreeStrain\", label: \"Free strain applied as stated\", value: null, unit: \"\", verdict: \"fail\",", "checks.push({ id: \"mechanicsFreeStrain\", label: \"Free strain applied as stated\", value: null, unit: \"\", verdict: \"pass\",", "an uncollected swelling field passes"],
  [R, "summary: { sicPeakTangential: sic ? sic.sigmaTMax : null, interfaceRadialStress: interfaceStress },", "summary: { sicPeakTangential: sic ? sic.sigmaTMin : null, interfaceRadialStress: interfaceStress },", "SiC peak is the smallest"],
  [R, "sigmaTMax: Math.max(...p.cells.map((c) => c.sigmaT)),", "sigmaTMax: Math.min(...p.cells.map((c) => c.sigmaT)),", "layer maximum is the minimum"],
  [R, "if (k.elasticityOutOfRange) findings.push(", "if (false) findings.push(", "elasticity range finding lost"],
  [R, "domain: { verdict: findings.length === 0 ? \"in-domain\" : \"out-of-domain\", findings },", "domain: { verdict: \"in-domain\", findings },", "domain verdict always in-domain"],
  [R, "if (!(input.time > 0) || !Number.isFinite(input.time)) bad(", "if (false) bad(", "final time not checked"],
  [R, "T.forEach((t, i) => !(t > 0) && bad(", "T.forEach((t, i) => false && bad(", "temperature sign not checked"],
  // ---- the validator and the run manager
  [V, "if (c.assumptions.thermalOnly !== true && !hasMechanics) err(\"E_PROP_MISSING\", \"/mechanics\",", "if (false) err(\"E_PROP_MISSING\", \"/mechanics\",", "the flag without the section accepted"],
  [V, "if (c.assumptions.thermalOnly === true && hasMechanics) err(\"E_SCHEMA_INVALID\", \"/mechanics\",", "if (false) err(\"E_SCHEMA_INVALID\", \"/mechanics\",", "the section with the flag true accepted"],
  [V, "if (hasMechanics && isTransient) err(\"E_UNSUPPORTED\", \"/mechanics\",", "if (false) err(\"E_UNSUPPORTED\", \"/mechanics\",", "mechanics with a transient accepted"],
  [V, "if (hasMechanics && c.limits !== undefined) err(\"E_UNSUPPORTED\", \"/limits\",", "if (false) err(\"E_UNSUPPORTED\", \"/limits\",", "limits with mechanics accepted"],
  [V, "const props = mechanicalSets(m, n, err, qty, n !== \"buffer\");", "const props = mechanicalSets(m, n, err, qty, false);", "mechanical sets not required"],
  [V, "const props = mechanicalSets(m, n, err, qty, n !== \"buffer\");", "const props = mechanicalSets(m, n, err, qty, true);", "buffer's mechanical sets required"],
  [V, "if (props && n !== \"buffer\") mechLayers.push({ name: n as TrisoLayerName, props });", "if (props) mechLayers.push({ name: n as TrisoLayerName, props });", "buffer meshed for mechanics"],
  [V, "...(mechBase && mechLayers.length === mechanicalLayerCount ? { mechanics: { ...mechBase, layers: mechLayers } } : {}) };", "...(mechBase ? { mechanics: { ...mechBase, layers: mechLayers } } : {}) };", "mechanics with missing layers normalised"],
  [V, "if (k.elasticityOutOfRange) result.warnings.push(", "if (false) result.warnings.push(", "elasticity range warning lost"],
  [V, "if (k.expansionOutOfRange) result.warnings.push(", "if (false) result.warnings.push(", "expansion range warning lost"],
  [RM, "const temperaturesGiven = normalizedHead.kind === \"triso\" && hasMechanics;", "const temperaturesGiven = false;", "thermal convergence judged for a mechanics run"],
  [RM, "if (normalized.kind === \"triso\" && normalized.mechanics) {", "if (false) {", "mechanics run read as a thermal particle"],
  [RM, "if (Dtext === undefined || sigma === undefined) return fail(", "if (false) return fail(", "missing stress field accepted"],
  [RM, "r.headline = { centreCellT: tm.cells[0]!.T, claddingOuterWallT: tm.cells[tm.cells.length - 1]!.T };", "r.headline = { centreCellT: tm.cells[0]!.T, claddingOuterWallT: tm.cells[0]!.T };", "headline wall from the first cell"],
];

const only = process.argv[2] ? new RegExp(process.argv[2]) : null; // optional: run only the mutants whose name matches (to re-run survivors)
const todo = mutants.filter((m) => !only || only.test(m[3]));

function runFocus() {
  const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...FOCUS], { cwd: root, encoding: "utf8", timeout: 300000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out) || /Tests\s+(\d+) failed/.exec(out);
  return { code: r.status, summary: m ? m[0] : null, out };
}

const base = runFocus();
console.log("baseline: exit " + base.code + ", " + base.summary);
if (base.code !== 0 || !base.summary) {
  console.log("ABORT: the baseline is not green");
  process.exit(2);
}
const rows = [];
for (const [file, from, to, name] of todo) {
  const p = path.join(root, file);
  const original = fs.readFileSync(p, "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) {
    rows.push([name, "ANCHOR " + count, ""]);
    console.log("ANCHOR " + count + "  " + name);
    continue;
  }
  if (from === to) {
    rows.push([name, "SKIPPED", "equivalent placeholder"]);
    continue;
  }
  try {
    fs.writeFileSync(p, original.replace(from, () => to), "utf8");
    const r = runFocus();
    const verdict = !r.summary ? "BROKEN" : r.code === 0 ? "SURVIVED" : "killed";
    rows.push([name, verdict, r.summary || ""]);
    console.log(verdict.padEnd(9) + name + "   [" + (r.summary || "no summary") + "]");
  } finally {
    fs.writeFileSync(p, original, "utf8");
  }
}
const n = (v) => rows.filter((r) => r[1] === v).length;
console.log("\nmutants " + rows.length + ": killed " + n("killed") + ", survived " + n("SURVIVED") + ", broken " + n("BROKEN") + ", skipped " + n("SKIPPED") + ", bad anchor " + rows.filter((r) => r[1].startsWith("ANCHOR")).length);
for (const r of rows.filter((x) => x[1] !== "killed")) console.log("  " + r[1] + ": " + r[0]);
