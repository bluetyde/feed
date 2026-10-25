// Case writer: a validated thermal case in, OFFBEAT case files out (docs/plans/03-editor-and-adapter.md, A3).
// Only modelled options are written. Everything OFFBEAT needs that the case does not define is a named placeholder,
// listed in `placeholders` and in the mapping so nothing is a hidden default (see docs/spike/F0-note.md).
// Pinned against OpenFOAM Foundation 9 + OFFBEAT 80e84450 (solver/PINS.md).

import { MIN_STEADY_END_TIME, steadyEndTime } from "./steadyState";
import { NFI_OXIDE_TO_HEAVY_METAL, NFI_PARAMETERS } from "./uo2Nfi";
import { initialState } from "./transientResults";
import { tableForSolver } from "./boundaryHistory";
import { hottestLoad, normalizedShape, sliceCase, sliceLoads } from "./axial";
import { PLATE_WIDTH_M } from "./geometry";
import { EffectiveSolid, effectiveMechanics } from "./mechanicalEval";
import { Conductivity, HeatCapacity, NormalizedCase } from "./validate";

export interface WrittenCase {
  /** Relative path (forward slashes) to file content, LF line endings. */
  files: Record<string, string>;
  /** Case field -> where it went, for the run record. */
  mapping: { field: string; file: string; note?: string }[];
  /** Values OFFBEAT requires that the case does not define. They do not affect a steady thermal result. */
  placeholders: { name: string; value: string; why: string }[];
  /** Constants the writer chose (documented). */
  choices: Record<string, number | string>;
}

/** Wedge angle in degrees, as in the upstream generic_pwr_1D case. */
export const WEDGE_ANGLE_DEG = 0.25;
/** Axial height of the one-cell slice in mm (power is per metre of rod; OFFBEAT scales by the reference height). */
export const SLICE_HEIGHT_MM = 1000;
/** The height of the mesh in mm: the heated length of an axial stack, else the one-cell slice. */
const heightMm = (c: NormalizedCase): number => (c.axial ? Number((c.axial.length * 1000).toPrecision(12)) : SLICE_HEIGHT_MM);
/** The layers of each solid along the height: the stack's slices, else one. */
const layers = (c: NormalizedCase): number => c.axial?.slices ?? 1;

/** Density written for every material. OFFBEAT wants rho and a mass-based Cp; a transient's volumetric heat capacity c is carried as Cp = c / rho. */
export const WRITER_DENSITY = 10000;
/** Steady runs use an end time far beyond any thermal time constant: a short one leaves a heat-storage term (F0 note). */
/** The shortest steady end time; a case whose pin needs longer gets its own (src/core/steadyState.ts steadyEndTime). */
export const STEADY_END_TIME = MIN_STEADY_END_TIME;

export const FOAM_HEADER = (cls: string, obj: string, loc?: string) =>
  `FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};
${loc ? `    location    "${loc}";\n` : ""}    object      ${obj};
}
`;

export const num = (v: number) => {
  if (!Number.isFinite(v)) throw new RangeError("non-finite number cannot be written");
  return String(v);
};

function blockMeshDict(c: NormalizedCase): string {
  const a = (WEDGE_ANGLE_DEG / 180) * Math.PI;
  const half = a / 2;
  // Wedge-volume correction, derived here (not taken from any other tool). The vertices lie on the two wedge planes, at
  // (x, +-x tan(half)) with x = r c cos(half). The planar hex between radii ri and ro then has volume per unit height
  // tan(half) (xo^2 - xi^2) = c^2 sin(half) cos(half) (ro^2 - ri^2), while the sector it stands for has half (ro^2 - ri^2) (the
  // full wedge angle is 2 half). Setting them equal gives c^2 = half / (sin(half) cos(half)). At the 0.25 degree wedge used
  // here c differs from 1 by about 1e-6, so this is a refinement, checked against the exact volume in tests/caseWriter.test.ts
  // and against OFFBEAT's own rodMaker.py output (which uses a slightly different factor) to 2e-5.
  const corr = Math.sqrt(half / (Math.sin(half) * Math.cos(half)));
  const cx = Math.cos(half) * corr;
  const sy = Math.sin(half) * corr;
  const mm = (r: number) => r * 1000;
  // a plate (plan 12, A4): a Cartesian block, x from the insulated mid-plane, one metre wide in y; the side faces are `empty` (nothing varies across the width), as the end faces are
  const halfWidth = (PLATE_WIDTH_M * 1000) / 2;
  const sides = c.plate ? "empty" : "wedge";
  const block = (ri: number, ro: number, z0: number, z1: number) => {
    if (c.plate) return [[mm(ri), -halfWidth, z0], [mm(ro), -halfWidth, z0], [mm(ro), halfWidth, z0], [mm(ri), halfWidth, z0], [mm(ri), -halfWidth, z1], [mm(ro), -halfWidth, z1], [mm(ro), halfWidth, z1], [mm(ri), halfWidth, z1]];
    const xi = mm(ri) * cx, yi = mm(ri) * sy, xo = mm(ro) * cx, yo = mm(ro) * sy;
    return [
      [xi, -yi, z0], [xo, -yo, z0], [xo, yo, z0], [xi, yi, z0],
      [xi, -yi, z1], [xo, -yo, z1], [xo, yo, z1], [xi, yi, z1],
    ];
  };
  const v = [...block(c.fuelInnerRadius, c.fuelRadius, 0, heightMm(c)), ...block(c.claddingInnerRadius, c.claddingOuterRadius, 0, heightMm(c))];
  const verts = v.map((p) => `    (${p.map(num).join(" ")})`).join("\n");
  const face = (...i: number[]) => `            (${i.join(" ")})`;
  const patch = (name: string, type: string, faces: string, extra = "") =>
    `    ${name}\n    {\n        type ${type};\n${extra}        faces\n        (\n${faces}\n        );\n    }\n`;
  // Annular fuel: the surface of the central hole is a plain patch; its temperature condition is zeroGradient (insulated), set in 0/T.
  const fuelInnerPatch = c.fuelInnerRadius > 0 ? patch("fuelInner", "patch", face(0, 4, 7, 3)) + String.fromCharCode(10) : "";
  const coupled = (name: string, other: string, owner: boolean) =>
    `        neighbourPatch ${other};\n        neighbourRegion region0;\n        owner ${owner};\n        updateAMI true;\n`;
  return `${FOAM_HEADER("dictionary", "blockMeshDict")}
convertToMeters 0.001;

vertices
(
${verts}
);

blocks
(
    hex (0 1 2 3 4 5 6 7) fuel (${c.mesh.fuelCells} 1 ${layers(c)}) simpleGrading (1 1 1)
    hex (8 9 10 11 12 13 14 15) cladding (${c.mesh.claddingCells} 1 ${layers(c)}) simpleGrading (1 1 1)
);

edges
(
);

boundary
(
${patch("fuelBottom", "empty", face(0, 3, 2, 1))}
${patch("fuelTop", "empty", face(4, 5, 6, 7))}
${fuelInnerPatch}${patch("fuelOuter", "regionCoupledOFFBEAT", face(1, 2, 6, 5), coupled("fuelOuter", "cladInner", true))}
${patch("fuelFront", sides, face(0, 1, 5, 4))}
${patch("fuelBack", sides, face(3, 7, 6, 2))}
${patch("cladBottom", "empty", face(8, 11, 10, 9))}
${patch("cladTop", "empty", face(12, 13, 14, 15))}
${patch("cladInner", "regionCoupledOFFBEAT", face(8, 12, 15, 11), coupled("cladInner", "fuelOuter", false))}
${patch("cladOuter", "patch", face(9, 10, 14, 13))}
${patch("cladFront", sides, face(8, 9, 13, 12))}
${patch("cladBack", sides, face(11, 15, 14, 10))}
);

mergePatchPairs
(
);
`;
}

/**
 * Conductivity lines for one region. Constant: the `constant` model with `k`. Linear k = a + b T (T in K): OFFBEAT has no generic
 * linear model, but its steel1515TiTobbe model is k = par1 + par2 * T[degC] and reads par1 and par2 from a `conductivity` block,
 * so par2 = b and par1 = a + 273.15 b reproduce any linear law. Checked against the conductivity-integral oracle in OFFBEAT
 * (docs/spike/F0-note.md, tests/offbeatOracle.test.ts). The model's name is a misnomer here; the manifest says so.
 */
export function conductivityLines(c: Conductivity): string {
  if (c.kind === "constant") return `        k           k     [1 1 -3 -1 0]  ${num(c.k)};\n`;
  if (c.kind === "uo2-nfi") {
    // OFFBEAT's UO2MATPRO model is FRAPCON-3.4's modified NFI conductivity (its name is a misnomer: docs/spike/burnup-sourcing.md). All 13 parameters are written, with the
    // report's value 16361 for the last (OFFBEAT's default is 16360), and so are densityFraction and GdContent: an omitted one takes a default silently (docs/spike/burnup-probe.md).
    const par = NFI_PARAMETERS.map((v, i) => "par" + (i + 1) + " " + num(v) + ";").join(" ");
    return `        conductivityModel UO2MATPRO;\n        densityFraction ${num(c.densityFraction)};\n        GdContent ${num(c.gadolinia)};\n        conductivity { ${par} }\n`;
  }
  if (c.kind === "reciprocal") {
    // SiCPARFUME evaluates par1 / T + par2 (T in K). Both are written: an omitted one takes a silicon-carbide default (17885, 2) without a word.
    return `        conductivityModel SiCPARFUME;\n        conductivity { par1 ${num(c.a)}; par2 ${num(c.b)}; }\n`;
  }
  if (c.kind === "polynomial") {
    // ZyRELAP evaluates par1 + par2 T - par3 T^2 + par4 T^3 (T in K), so the T^2 parameter is MINUS the coefficient; all four are always written because an omitted
    // or mistyped parameter takes a Zircaloy default silently (docs/spike/property-model-survey.md).
    const [a0, a1, a2, a3] = c.coefficients as [number, number, number, number];
    return `        conductivityModel ZyRELAP;\n        conductivity { par1 ${num(a0)}; par2 ${num(a1)}; par3 ${num(-a2)}; par4 ${num(a3)}; }\n`;
  }
  return `        conductivityModel steel1515TiTobbe;\n        conductivity { par1 ${num(c.a + 273.15 * c.b)}; par2 ${num(c.b)}; }\n`;
}

/** Heat capacity lines. Steady cases keep placeholders. A transient carries the volumetric c: constant as Cp = c / rho; linear c = a + b T
 *  through OFFBEAT's steel1515TiBanerjee model (Cp = par1 + par2 T + par3 T^-2, T in K) with par3 = 0; the model's name is a misnomer. */
export function heatCapacityLines(cp: HeatCapacity | undefined): string {
  const cpLine = (v: number) => `        Cp          Cp    [0 2 -2 -1 0]  ${num(v)};\n`;
  if (cp === undefined) return cpLine(300);
  if (cp.kind === "constant") return cpLine(cp.c / WRITER_DENSITY);
  if (cp.kind === "polynomial") {
    // SiCSnead evaluates par1 + par2 T + par3 T^2 + par4 T^-2 (T in K); par4 = 0 leaves the quadratic. All four are written (an omitted one takes a default silently).
    const [c0, c1, c2] = cp.coefficients as [number, number, number];
    return cpLine(300) + `        heatCapacityModel SiCSnead;\n        heatCapacity { par1 ${num(c0 / WRITER_DENSITY)}; par2 ${num(c1 / WRITER_DENSITY)}; par3 ${num(c2 / WRITER_DENSITY)}; par4 0; }\n`;
  }
  return cpLine(300) + `        heatCapacityModel steel1515TiBanerjee;\n        heatCapacity { par1 ${num(cp.a / WRITER_DENSITY)}; par2 ${num(cp.b / WRITER_DENSITY)}; par3 0; }\n`;
}

/** What was written for a region's conductivity, for the run's mapping record. */
export function conductivityNote(region: string, k: Conductivity): string {
  if (k.kind === "constant") return `materials.${region}.k (constant)`;
  if (k.kind === "linear") return `materials.${region}: steel1515TiTobbe with par1 = a + 273.15 b, par2 = b (linear k(T))`;
  if (k.kind === "uo2-nfi") return `materials.${region}: UO2MATPRO, which is FRAPCON-3.4's modified NFI model (NUREG/CR-7024 Eq. 2.3-10 and 2.3-11; the name is a misnomer) with densityFraction ${k.densityFraction}, GdContent ${k.gadolinia} and all 13 parameters written (par13 = 16361, the report's, not OFFBEAT's default 16360); the burnup is read from 0/Bu`;
  if (k.kind === "reciprocal") return `materials.${region}: SiCPARFUME (k = par1 / T + par2, T in K; the model's name is a misnomer) with par1 = a, par2 = b, both written`;
  return `materials.${region}: ZyRELAP (k = par1 + par2 T - par3 T^2 + par4 T^3, T in K) with par1 = a, par2 = b, par3 = -c, par4 = d, all four written` + (k.fit ? `; fitted to a table of ${k.fit.points.length} points, degree ${k.fit.degree}, largest deviation ${(k.fit.maxRelativeDeviation * 100).toPrecision(3)}% at ${k.fit.worstAt} K (tolerance ${(k.fit.tolerance * 100).toPrecision(3)}%)` : "");
}

/** The mechanical constants a `constant` material needs: the placeholders of a thermal run (unused with mechanics off), or the case's own, reduced to constants (mechanicalEval.ts). */
function mechanicalConstants(m?: EffectiveSolid, Tref?: number): string {
  if (!m || Tref === undefined) {
    return `        E           E     [1 -1 -2 0 0]  2e11;
        nu          nu    [0 0 0 0 0]    0.3;
        G           G     [1 -1 -2 0 0]  7.69e10;
        alpha       alpha [0 0 0 0 0]    1e-5;
        Tref        Tref  [0 0 0 1 0]    300;
`;
  }
  return `        E           E     [1 -1 -2 0 0]  ${num(m.E)};
        nu          nu    [0 0 0 0 0]    ${num(m.nu)};
        G           G     [1 -1 -2 0 0]  ${num(m.G)};
        alpha       alpha [0 0 0 0 0]    ${num(m.alpha)};
        Tref        Tref  [0 0 0 1 0]    ${num(Tref)};
`;
}

export function constantMaterial(name: string, k: Conductivity, cp?: HeatCapacity, mech?: EffectiveSolid, Tref?: number): string {
  return `    ${name}
    {
        material constant;
        rho         rho   [1 -3 0 0 0]   ${WRITER_DENSITY};
${heatCapacityLines(cp)}${conductivityLines(k)}        emissivity  emissivity [0 0 0 0 0] 0.8;
${mechanicalConstants(mech, Tref)}        rheologyModel elasticity;
    }
`;
}

/**
 * The `Bu` file that `burnup constant` reads (constantBurnup.H): one value per cell, fuel cells first, in MWd per tonne of OXIDE, which is how OFFBEAT's field is defined
 * (docs/spike/burnup-probe.md, tests/burnupBasis.test.ts). The UO2MATPRO conductivity divides it by 0.881 to get GWd/tU, so a burnup on a heavy-metal basis is written as
 * B x 1000 x 0.881 whatever the fuel (the model's own constant, not OFFBEAT's 0.8815 of its Lassmann model). The cladding cells are 0.
 */
function burnupField(c: NormalizedCase, burnupMWdPerKgHM: number): string {
  const value = burnupMWdPerKgHM * 1000 * NFI_OXIDE_TO_HEAVY_METAL;
  const cells = [...Array.from({ length: c.mesh.fuelCells }, () => num(value)), ...Array.from({ length: c.mesh.claddingCells }, () => "0")];
  const zg = (n: string) => `    ${n}${NL}    {${NL}        type            zeroGradient;${NL}    }${NL}`;
  const other = (n: string, t: string) => `    ${n}${NL}    {${NL}        type            ${t};${NL}    }${NL}`;
  return `${FOAM_HEADER("volScalarField", "Bu", "0")}
dimensions      [0 0 0 0 0 0 0];

internalField   nonuniform List<scalar>${NL}${cells.length}${NL}(${NL}${cells.join(NL)}${NL})${NL};

boundaryField
{
${other("fuelBottom", "empty")}${other("fuelTop", "empty")}${c.fuelInnerRadius > 0 ? zg("fuelInner") : ""}${zg("fuelOuter")}${other("fuelFront", "wedge")}${other("fuelBack", "wedge")}${other("cladBottom", "empty")}${other("cladTop", "empty")}${zg("cladInner")}${zg("cladOuter")}${other("cladFront", "wedge")}${other("cladBack", "wedge")}${other("defaultFaces", "empty")}}
`;
}

/** The gas pressure of the gap, constant for the whole run, as OFFBEAT's tabulated gap gas model wants it (pure helium: the gas only carries the pressure, the gap's heat transfer is the case's stated conductance). */
function gapGasOptions(pressure: number): string {
  const both = (v: string) => "(" + v + " " + v + ")";
  return `gapGasOptions
{
    timePoints (0 1e12);
    gapPressures ${both(num(pressure))};
    Ar ${both("0")};
    He ${both("1")};
    Kr ${both("0")};
    Ne ${both("0")};
    Rn ${both("0")};
    Xe ${both("0")};
    timeInterpolationMethod linear;
}
`;
}

/** The state file OFFBEAT's tabulated gap gas model reads at the start: the mass fractions of the six species and the pressure. */
function gapGasFile(pressure: number): string {
  return `${FOAM_HEADER("dictionary", "gapGas", "0/uniform")}
massFractions
{
    Ar 0;
    He 1;
    Kr 0;
    Ne 0;
    Rn 0;
    Xe 0;
}
gasPressure ${num(pressure)};
`;
}

/** The axial power profile OFFBEAT is given: flat for one slice; for a stack the shape as a table normalised so that its integral over 0 to 1 is 1 (OFFBEAT aborts otherwise), the case's heat rate being the average. */
function axialProfileText(c: NormalizedCase): string {
  if (!c.axial) return "{ type flat; }";
  const s = normalizedShape(c.axial);
  return `{ type constantTabulated; axialLocations (${s.locations.map(num).join(" ")}); data (${s.data.map(num).join(" ")}); axialInterpolationMethod linear; }`;
}

function solverDict(c: NormalizedCase, kf: Conductivity, kc: Conductivity): string {
  const eff = effectiveMechanics(c);
  return `${FOAM_HEADER("dictionary", "solverDict", "constant")}
thermalSolver           solidConduction;
mechanicsSolver         ${eff ? "smallStrain" : "fromLatestTime"};
neutronicsSolver        none;
elementTransport        none;

materialProperties      byZone;
rheology                byMaterial;

heatSource              ${c.transient ? "timeDependentLhgr" : "constantLhgr"};
burnup                  ${c.burnup ? "constant" : "none"};
fastFlux                none;
corrosion               fromLatestTime;
gapGas                  ${eff && eff.internalPressure > 0 ? "timeTabulated" : "none"};
${eff && eff.internalPressure > 0 ? gapGasOptions(eff.internalPressure) : ""}
fgr                     none;
sliceMapper             autoAxialSlices;

globalOptions
{
    pinDirection            (0 0 1);
${c.plate ? "    angularFraction         1;\n" : ""}    reactorType             "LWR";
}

thermalSolverOptions
{
    heatFluxSummary     off;
}

${eff && c.mechanics ? `rheologyOptions
{
    thermalExpansion on;
    planeStress off;
    modifiedPlaneStrain ${c.mechanics.plane === "free-axial" ? "on" : "off"};
    coolantPressureList { values 2 ( (0 0) (1e10 0) ); }
    springModulus 3500;
}

mechanicsSolverOptions
{
    forceSummary off;
    cylindricalStress on;
    RhieChowCorrection false;
}

` : ""}heatSourceOptions
{
${c.transient ? `    timePoints  (${[...c.transient.times, c.transient.times[c.transient.times.length - 1]! + c.transient.timeStep].map(num).join(" ")});
    lhgr        (${[...c.transient.linearHeatRate, c.transient.linearHeatRate[c.transient.linearHeatRate.length - 1]!].map(num).join(" ")});
    timeInterpolationMethod linear;
` : `    lhgr        ${num(c.qPrime)};
`}    axialProfile ${axialProfileText(c)};
    radialProfile { type flat; }
    materials ( fuel );
}

materials
{
${constantMaterial("fuel", kf, c.fuelHeatCapacity, eff?.fuel, eff?.referenceTemperature)}
${constantMaterial("cladding", kc, c.claddingHeatCapacity, eff?.cladding, eff?.referenceTemperature)}}
`;
}

const NL = String.fromCharCode(10);

/** Where the mechanics section and the mechanical property sets went (docs/plans/09-mechanics.md M2). */
function mechanicsMapping(c: NormalizedCase): { field: string; file: string; note?: string }[] {
  const eff = effectiveMechanics(c)!;
  const m = c.mechanics!;
  const solid = (name: "fuel" | "cladding") => {
    const s = eff[name];
    const p = c.mechanical![name];
    const how = (kind: string, what: string) => (kind === "constant" ? what + " as stated" : what + " reduced to a constant (" + (what === "E" ? "its value at the mean temperature " + s.meanTemperature.toFixed(1) + " K" : "the coefficient that gives the mean thermal strain from the reference temperature") + ")");
    return `materials.${name}: E = ${num(s.E)} Pa (${how(p.elasticity.kind, "E")}), nu = ${num(s.nu)}, G = E / (2 (1 + nu)), alpha = ${num(s.alpha)} 1/K (${how(p.expansion.kind, "alpha")})${s.elasticityOutOfRange || s.expansionOutOfRange ? "; the solid's temperatures leave the range a law is stated for" : ""}`;
  };
  return [
    { field: "mechanics", file: "constant/solverDict", note: "mechanicsSolver smallStrain, thermalExpansion on, planeStress off, modifiedPlaneStrain " + (m.plane === "free-axial" ? "on (each solid takes its own axial strain, free of axial force)" : "off (plane strain, axially fixed)") },
    { field: "mechanics.referenceTemperature", file: "constant/solverDict", note: "Tref " + num(m.referenceTemperature) + " K of both materials (the stress-free temperature)" },
    { field: "materials.fuel mechanical.*", file: "constant/solverDict", note: solid("fuel") },
    { field: "materials.cladding mechanical.*", file: "constant/solverDict", note: solid("cladding") },
    { field: "mechanics.contact.penaltyFactor", file: "0/D", note: "gapContact penaltyFactor " + num(m.penaltyFactor) + " on fuelOuter and cladInner (the contact pressure depends on it)" },
    { field: "mechanics.coolantPressure", file: "0/D", note: "cladOuter tractionDisplacement, pressure " + num(m.coolantPressure) + " Pa, no traction" },
    ...(eff.internalPressure > 0
      ? [{ field: "mechanics.internalPressure", file: "constant/solverDict, 0/uniform/gapGas", note: "gapGas timeTabulated with a constant pressure of " + num(eff.internalPressure) + " Pa, " + eff.internalPressureNote + ": OFFBEAT adds it to the traction on fuelOuter and cladInner. The gap's heat transfer stays the case's stated conductance" }]
      : []),
  ];
}

/** The starting temperature: one number for the whole pin, or the temperature of every cell (the blockMesh order: fuel inner to outer, then cladding inner to outer) with the outer wall. */
type StartField = { kind: "uniform"; T: number } | { kind: "field"; T: number[]; wall: number };

function temperatureField(c: NormalizedCase, start: StartField, runEnd: number): string {
  const uniform = start.kind === "uniform";
  const nf = c.mesh.fuelCells;
  const cells = start.kind === "field" ? start.T : [];
  // A uniform start is written as one value and the patches copy it ($internalField). A field cannot be copied into a patch (the sizes differ), so each patch gets a
  // uniform starting value near it: the wedge planes the mean, the gap faces the neighbouring cell, the coolant face the wall. The boundary conditions overwrite them.
  const mean = cells.length ? cells.reduce((x, y) => x + y, 0) / cells.length : 0;
  const internal = start.kind === "uniform" ? `uniform ${num(start.T)}` : `nonuniform List<scalar>${NL}${cells.length}${NL}(${NL}${cells.map(num).join(NL)}${NL})${NL}`;
  const copy = (x: number) => (uniform ? "$internalField" : `uniform ${num(x)}`);
  const inner = c.fuelInnerRadius > 0 ? `    fuelInner
    {
        type            zeroGradient;
    }
` : "";
  const gap = (n: string, near: number) => `    ${n}
    {
        type            resistiveGap;
        patchType       regionCoupledOFFBEAT;
        coupled         true;
        kappa           k;
        alpha           uniform ${num(c.gapConductance)};
        value           ${copy(near)};
    }
`;
  const hist = c.transient?.boundaryHistory;
  const tab = hist ? tableForSolver(hist, c.transient!.endTime, c.transient!.timeStep) : undefined;
  const axial = `(0 ${num(heightMm(c) / 1000)})`;
  const rows = (col: number[]) => "(" + col.map((v) => "(" + num(v) + " " + num(v) + ")").join(" ") + ")";
  const startWall = start.kind === "uniform" ? start.T : start.wall;
  // an axial coolant table (a stack): heights in metres from the bottom (OFFBEAT's unit), the same row for both time points, which reach past the end of the run
  const ab = c.axial?.boundary;
  const heights = ab ? `(${ab.heights.map(num).join(" ")})` : "";
  const axRows = (col: number[]) => `((${col.map(num).join(" ")}) (${col.map(num).join(" ")}))`;
  const axTimes = `(0 ${num(2 * runEnd)})`;
  const outer =
    ab && ab.kind === "convective"
      ? `type timeDependentAxialProfileHTC;
        axialProfileDict
        {
            timePoints ${axTimes};
            axialLocations ${heights};
            hData ${axRows(ab.heatTransferCoefficient)};
            T0Data ${axRows(ab.bulkTemperature)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(ab.bulkTemperature[0]!)};`
      : ab
      ? `type timeDependentAxialProfileT;
        timeDependentProfile
        {
            timePoints ${axTimes};
            axialLocations ${heights};
            axialData ${axRows(ab.surfaceTemperature)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(ab.surfaceTemperature[0]!)};`
      : hist && tab && hist.kind === "convective"
      ? `type timeDependentAxialProfileHTC;
        axialProfileDict
        {
            timePoints (${tab.times.map(num).join(" ")});
            axialLocations ${axial};
            hData ${rows(tab.columns[0]!)};
            T0Data ${rows(tab.columns[1]!)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(startWall)};`
      : hist && tab
      ? `type timeDependentAxialProfileT;
        timeDependentProfile
        {
            timePoints (${tab.times.map(num).join(" ")});
            axialLocations ${axial};
            axialData ${rows(tab.columns[0]!)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(startWall)};`
      : c.boundary.kind === "convective"
      ? `type convectiveHTC;
        T0 uniform ${num(c.boundary.bulkTemperature)};
        h uniform ${num(c.boundary.heatTransferCoefficient)};
        value uniform ${num(start.kind === "uniform" ? start.T : start.wall)};`
      : `type fixedValue;
        value uniform ${num(c.boundary.surfaceTemperature)};`;
  return `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   ${internal};

boundaryField
{
    ".*Front|.*Back"
    {
        type            ${c.plate ? "empty" : "wedge"};
        value           ${copy(mean)};
    }
${inner}${gap("fuelOuter", cells[nf - 1] ?? 0)}${gap("cladInner", cells[nf * layers(c)] ?? 0)}    cladOuter
    {
        ${outer}
    }
}
`;
}
// The displacement field. The surface of a central hole is free (no traction, no pressure) in a mechanics case: zeroGradient there left the radial stress at the hole at -18.9 MPa where the exact value is 0 (plan 17 M0 probe).
const displacementField = (c: NormalizedCase) => `${FOAM_HEADER("volVectorField", "D")}
dimensions          [0 1 0 0 0 0 0];

internalField       uniform (0 0 0);

boundaryField
{
    ".*Front|.*Back"
    {
        type            ${c.plate ? "empty" : "wedge"};
    }
    cladOuter
    {
${c.mechanics ? `        type            tractionDisplacement;
        traction        uniform (0 0 0);
        pressure        uniform ${num(c.mechanics.coolantPressure)};
        relax           1.0;
        value           uniform (0 0 0);` : `        type            fixedValue;
        value           uniform (0 0 0);`}
    }
${c.fuelInnerRadius > 0 ? (c.mechanics ? `    fuelInner
    {
        type            tractionDisplacement;
        traction        uniform (0 0 0);
        pressure        uniform 0;
        relax           1.0;
        value           uniform (0 0 0);
    }
` : `    fuelInner
    {
        type            zeroGradient;
    }
`) : ""}    "fuelOuter|cladInner"
    {
        type            gapContact;
        patchType       regionCoupledOFFBEAT;
        penaltyFactor   ${c.mechanics ? num(c.mechanics.penaltyFactor) : "0.1"};
        frictionCoefficient        0;
        relax           1.0;
        relaxInterfacePressure           0.1;
        value           $internalField;
    }
}
`;

export const controlDict = (endTime: number, transient?: { timeStep: number; writeEvery: number }) => `${FOAM_HEADER("dictionary", "controlDict", "system")}
application     offbeat;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         ${num(endTime)};
deltaT          ${transient ? num(transient.timeStep) : 1};
writeControl    timeStep;
writeInterval   ${transient ? transient.writeEvery : 1000};
purgeWrite      0;
writeFormat     ascii;
writeCompression off;
timeFormat      general;
timePrecision   20;
writePrecision  8;

adjustableTimeStep ${transient ? "false" : "true"};
maxDeltaT         6.048e5;
minDeltaT         0.001;
maxRelativeDeltaTIncrease 1e9;
minRelativeDeltaTDecrease 1e9;
maxRelativePowerIncrease  1e9;
maxRelativePowerDecrease  1e9;
maxBurnupIncrease 0.1;
maxAverageCreep   1e-4;
maxMaximumCreep   1e-4;
maxFGR            1e-8;
runTimeModifiable true;
`;

export const fvSchemes = `${FOAM_HEADER("dictionary", "fvSchemes", "system")}
d2dt2Schemes { default steadyState; }
ddtSchemes { default Euler; }
gradSchemes { default leastSquaresImplicitContact; }
divSchemes { default Gauss linear; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default uncorrected; }
fluxRequired
{
    default no;
    D;
    T;
}
`;

/**
 * The solution settings. With mechanics the displacement is under-relaxed by 0.5 instead of 0.8: with a contact (the gap closed, a penalty condition on the two surfaces) the
 * default settings oscillate and never reach OFFBEAT's convergence criterion in its 1000 outer iterations, which OFFBEAT then accepts silently; with 0.5 the same case converges
 * in 2 and gives the contact pressure to 1 % (docs/spike/mechanics-probe.md, the M2 section). A thermal-only case keeps its settings byte for byte.
 */
export const fvSolutionText = (mechanics: boolean) => `${FOAM_HEADER("dictionary", "fvSolution", "system")}
solvers
{
    D { solver PCG; preconditioner FDIC; tolerance 1e-10; relTol 0.1; }
    T { solver PCG; preconditioner FDIC; tolerance 1e-10; relTol 0.1; }
    neutronFlux0 { solver PCG; preconditioner FDIC; tolerance 1e-10; relTol 0.1; }
}

stressAnalysis
{
    nCorrectors { D 3; default 1; }
    maxOuterIter    1000;
    referencePairs  ();
    D                   (1e-5 1 1e-5);
    T                   1e-5;
    neutronFlux0        1e-5;
    relD                1e-6;
    relT                1e-6;
    relneutronFlux0     1e-6;
}

relaxationFactors
{
    fields { D ${mechanics ? "0.5" : "0.8"}; }
}
`;

/**
 * Write the OFFBEAT case files for a validated, normalized case. Constant and linear (a + b T) conductivity are supported;
 * both were checked against closed-form oracles in OFFBEAT.
 */
export function writeOffbeatCase(c: NormalizedCase): WrittenCase {
  // plan 17 M2: the validator accepts mechanics with a transient, but the run is not built until M4; writing it would give a thermal-only run that looks complete
  if (c.mechanics && c.transient) throw new Error("E_UNSUPPORTED: mechanics through a transient is valid but cannot be solved yet (plan 17, M4); no thermal-only run is made in its place");
  const kf = c.fuelConductivity;
  const kc = c.claddingConductivity;
  const tr = c.transient;
  // The starting field: a uniform temperature (a steady case: the coolant or prescribed wall, which the result does not depend on), or a transient's steady operating state.
  // A stack starts every slice at its own steady state, written for all cells in the mesh's order (every fuel layer, then every cladding layer).
  const steadyStart =
    tr !== undefined && tr.initial.kind === "steady"
      ? c.axial
        ? (() => {
            const sts = sliceLoads(c).map((l) => initialState(sliceCase(c, l)));
            const nf0 = c.mesh.fuelCells;
            return { T: [...sts.flatMap((s) => s.T.slice(0, nf0)), ...sts.flatMap((s) => s.T.slice(nf0))], wall: sts[0]!.wall, peak: Math.max(...sts.map((s) => s.peak)), fuelPeak: Math.max(...sts.map((s) => s.fuelPeak)) };
          })()
        : initialState(c)
      : undefined;
  const t0 = tr ? (tr.initial.kind === "uniform" ? tr.initial.temperature : steadyStart!.peak) : c.boundary.kind === "convective" ? c.boundary.bulkTemperature : c.boundary.surfaceTemperature;
  const start: StartField = steadyStart ? { kind: "field", T: steadyStart.T, wall: steadyStart.wall } : { kind: "uniform", T: t0 };
  // A steady case runs to an end time the pin's own time constants require (at least 5e7 s); the validator refuses what cannot settle.
  let steadyEnd = MIN_STEADY_END_TIME;
  if (!tr) {
    // a stack: the end time the hottest slice (the most heat to settle) needs
    const h = steadyEndTime(c.axial ? sliceCase(c, hottestLoad(c)) : c);
    if (!h.ok) throw new Error("cannot write a steady case: " + h.message);
    steadyEnd = h.endTime;
  }
  const files: Record<string, string> = {
    "system/blockMeshDict": blockMeshDict(c),
    "system/controlDict": tr ? controlDict(tr.endTime, { timeStep: tr.timeStep, writeEvery: tr.steps / tr.outputs }) : controlDict(steadyEnd),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolutionText(c.mechanics !== undefined),
    "constant/solverDict": solverDict(c, kf, kc),
    "0/T": temperatureField(c, start, tr ? tr.endTime : steadyEnd),
    "0/D": displacementField(c),
    ...(effectiveMechanics(c)?.internalPressure ? { "0/uniform/gapGas": gapGasFile(effectiveMechanics(c)!.internalPressure) } : {}),
    ...(c.burnup ? { "0/Bu": burnupField(c, c.burnup.value) } : {}),
    // marks a transient for the run script (it then keeps the field at every write time); OpenFOAM ignores the file
    ...(tr ? { "feed-transient.json": JSON.stringify({ outputs: tr.outputs, steps: tr.steps, timeStep: tr.timeStep, endTime: tr.endTime }) + "\n" } : {}),
  };
  // With hot dimensions the radii written are the expanded ones; the notes say so and give the cold value.
  const hotNote = (key: "fuelRadius" | "fuelInnerRadius" | "claddingInnerRadius" | "claddingOuterRadius", solid: "fuel" | "cladding"): string =>
    c.hot ? "; HOT value: the case's " + (c.hot.cold[key] * 1e3).toPrecision(8) + " mm expanded by " + c.hot[solid].factor.toPrecision(8) + " (docs/hot-dimensions.md)" : "";
  const mapping: WrittenCase["mapping"] = [
    ...(c.plate ? [{ field: "geometry", file: "system/blockMeshDict, constant/solverDict, 0/T, 0/D", note: "a plate: a Cartesian mesh, the meat from the insulated mid-plane x = 0 (no patch there: the face is a default `empty` face, no heat crosses it) to " + (c.fuelRadius * 1000) + " mm, the gap, and the cladding to " + (c.claddingOuterRadius * 1000) + " mm; one metre wide in y (the side and end faces are `empty`); angularFraction 1 because there is no wedge; lhgr is the heat per metre of height per metre of width" }] : []),
    { field: "geometry.fuelRadius", file: "system/blockMeshDict", note: "block 'fuel' outer radius (mm), wedge " + WEDGE_ANGLE_DEG + " deg" + hotNote("fuelRadius", "fuel") },
    ...(c.fuelInnerRadius > 0 ? [{ field: "geometry.fuelInnerRadius", file: "system/blockMeshDict", note: "block 'fuel' inner radius (central hole); patch fuelInner, zeroGradient in 0/T (insulated); in 0/D zeroGradient for a thermal case and a free surface (tractionDisplacement, no traction, no pressure) for a mechanics case" + hotNote("fuelInnerRadius", "fuel") }] : []),
    { field: "geometry.claddingInnerRadius", file: "system/blockMeshDict", note: "block 'cladding' inner radius" + hotNote("claddingInnerRadius", "cladding") },
    { field: "geometry.claddingOuterRadius", file: "system/blockMeshDict", note: "block 'cladding' outer radius" + hotNote("claddingOuterRadius", "cladding") },
    ...(c.axial ? [{ field: "axial", file: "system/blockMeshDict, constant/solverDict, 0/T", note: "mesh: " + c.axial.slices + " layers per solid over " + heightMm(c) + " mm (the end faces stay empty); heatSourceOptions.axialProfile: the " + c.axial.shape.kind + " shape as a table normalised to an integral of 1 over 0 to 1, lhgr = the average heat rate " + c.qPrime + " W/m (OFFBEAT samples it at the cell centres)" + (c.axial.boundary ? "; cladOuter: the coolant table as " + (c.axial.boundary.kind === "convective" ? "timeDependentAxialProfileHTC" : "timeDependentAxialProfileT") + " with heights in metres from the bottom" : "; cladOuter: the case's own boundary on every layer") }] : []),
    { field: "mesh.fuelCells", file: "system/blockMeshDict" },
    { field: "mesh.claddingCells", file: "system/blockMeshDict" },
    ...(tr
      ? [
          { field: tr.kinetics ? "transient.pointKinetics" : "transient.powerHistory", file: "constant/solverDict", note: (tr.kinetics ? "generated by point kinetics (" + tr.times.length + " points, docs/point-kinetics.md) and written as the power table: " : "") + "timeDependentLhgr: timePoints and lhgr, linear interpolation, flat profiles. One flat point is appended one step after the last: the accumulated step time can land a few ulps past the last point, and OFFBEAT aborts on a time outside its table" },
          { field: "transient.timeStep, endTime, outputs", file: "system/controlDict", note: "fixed deltaT (adjustableTimeStep false), endTime, writeInterval = steps / outputs" },
          steadyStart
            ? { field: "transient.initialSteadyLinearHeatRate", file: "0/T", note: "nonuniform internalField: the steady temperature of every cell at that heat rate, from FEED's independent finite-volume solution on this mesh (blockMesh order: fuel cells inner to outer, then cladding cells inner to outer); the patches start from a uniform value near them" }
            : { field: "transient.initialTemperature", file: "0/T", note: "uniform internalField" },
          { field: "materials.* thermal.volumetricHeatCapacity", file: "constant/solverDict", note: "rho " + WRITER_DENSITY + " kg/m3 and Cp = c / rho (constant), steel1515TiBanerjee with par1 = a / rho, par2 = b / rho, par3 = 0 (linear c(T); the model name is a misnomer), or SiCSnead with par1..par3 = a, b, c over rho and par4 = 0 (quadratic c(T), all four written)" },
        ]
      : [{ field: "power.linearHeatRate", file: "constant/solverDict", note: "heatSourceOptions.lhgr, flat profiles" }]),
    { field: "materials.fuel thermal.conductivity", file: "constant/solverDict", note: conductivityNote("fuel", kf) },
    { field: "materials.cladding thermal.conductivity", file: "constant/solverDict", note: conductivityNote("cladding", kc) },
    { field: "gap.conductance", file: "0/T", note: "resistiveGap alpha on fuelOuter and cladInner" },
    ...(c.mechanics ? mechanicsMapping(c) : []),
    ...(c.burnup ? [{ field: "burnup", file: "0/Bu", note: "burnup constant; Bu = " + c.burnup.value + " MWd/kgHM x 1000 x 0.881 = " + num(c.burnup.value * 1000 * NFI_OXIDE_TO_HEAVY_METAL) + " MWd/t of oxide in every fuel cell, 0 in the cladding (the model divides by its own 0.881); source: " + c.burnup.source }] : []),
    { field: "boundary", file: "0/T", note: c.boundary.kind === "convective" ? "cladOuter convectiveHTC (T0, h)" : "cladOuter fixedValue" },
    ...(c.transient?.boundaryHistory ? [{ field: "transient.boundaryHistory", file: "0/T", note: "cladOuter " + (c.transient.boundaryHistory.kind === "convective" ? "timeDependentAxialProfileHTC (hData, T0Data)" : "timeDependentAxialProfileT (timeDependentProfile.axialData)") + ", " + c.transient.boundaryHistory.times.length + " points, linear in time, two equal axial columns; the case's own boundary is the value before the first point (the steady start). OFFBEAT applies the value of the end of each step. One flat point is appended beyond the end time when the last point is not strictly after it: OFFBEAT aborts on a time equal to its last point" }] : []),
  ];
  const placeholders: WrittenCase["placeholders"] = [
    tr
      ? { name: "rho", value: WRITER_DENSITY + " kg/m3", why: "carrier for the volumetric heat capacity: the model wants rho and a mass-based Cp, and only their product rho Cp enters the heat equation" }
      : { name: "rho", value: "10000 kg/m3", why: "required by the constant material model; storage only, no effect on the steady result" },
    ...(tr ? [] : [{ name: "Cp", value: "300 J/kg/K", why: "same" }]),
    c.mechanics
      ? { name: "emissivity", value: "0.8", why: "required by the constant material model; storage only, no effect on the temperatures" }
      : { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    steadyStart
      ? { name: "initial temperature field", value: "steady state at " + (tr!.initial as { linearHeatRate: number }).linearHeatRate + " W/m, " + Math.min(...steadyStart.T).toFixed(2) + " to " + steadyStart.peak.toFixed(2) + " K", why: "the transient starts from the steady operating state of this pin at the stated heat rate (independent finite-volume solution, same mesh)" }
      : { name: "initial temperature", value: String(t0) + " K", why: tr ? "the transient's initial temperature, as given" : "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: tr ? { wedgeAngleDeg: WEDGE_ANGLE_DEG, sliceHeightMm: heightMm(c), endTime: tr.endTime, timeStep: tr.timeStep, steps: tr.steps, outputs: tr.outputs } : { wedgeAngleDeg: WEDGE_ANGLE_DEG, sliceHeightMm: heightMm(c), endTime: steadyEnd } };
}
