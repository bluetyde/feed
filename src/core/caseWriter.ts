// Case writer: a validated thermal case in, OFFBEAT case files out (docs/plans/03-editor-and-adapter.md, A3).
// Only modelled options are written. Everything OFFBEAT needs that the case does not define is a named placeholder,
// listed in `placeholders` and in the mapping so nothing is a hidden default (see docs/spike/F0-note.md).
// Pinned against OpenFOAM Foundation 9 + OFFBEAT 80e84450 (solver/PINS.md).

import { MIN_STEADY_END_TIME, steadyEndTime } from "./steadyState";
import { initialState } from "./transientResults";
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
/** Density written for every material. OFFBEAT wants rho and a mass-based Cp; a transient's volumetric heat capacity c is carried as Cp = c / rho. */
export const WRITER_DENSITY = 10000;
/** Steady runs use an end time far beyond any thermal time constant: a short one leaves a heat-storage term (F0 note). */
/** The shortest steady end time; a case whose pin needs longer gets its own (src/core/steadyState.ts steadyEndTime). */
export const STEADY_END_TIME = MIN_STEADY_END_TIME;

const FOAM_HEADER = (cls: string, obj: string, loc?: string) =>
  `FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};
${loc ? `    location    "${loc}";\n` : ""}    object      ${obj};
}
`;

const num = (v: number) => {
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
  const block = (ri: number, ro: number, z0: number, z1: number) => {
    const xi = mm(ri) * cx, yi = mm(ri) * sy, xo = mm(ro) * cx, yo = mm(ro) * sy;
    return [
      [xi, -yi, z0], [xo, -yo, z0], [xo, yo, z0], [xi, yi, z0],
      [xi, -yi, z1], [xo, -yo, z1], [xo, yo, z1], [xi, yi, z1],
    ];
  };
  const v = [...block(c.fuelInnerRadius, c.fuelRadius, 0, SLICE_HEIGHT_MM), ...block(c.claddingInnerRadius, c.claddingOuterRadius, 0, SLICE_HEIGHT_MM)];
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
    hex (0 1 2 3 4 5 6 7) fuel (${c.mesh.fuelCells} 1 1) simpleGrading (1 1 1)
    hex (8 9 10 11 12 13 14 15) cladding (${c.mesh.claddingCells} 1 1) simpleGrading (1 1 1)
);

edges
(
);

boundary
(
${patch("fuelBottom", "empty", face(0, 3, 2, 1))}
${patch("fuelTop", "empty", face(4, 5, 6, 7))}
${fuelInnerPatch}${patch("fuelOuter", "regionCoupledOFFBEAT", face(1, 2, 6, 5), coupled("fuelOuter", "cladInner", true))}
${patch("fuelFront", "wedge", face(0, 1, 5, 4))}
${patch("fuelBack", "wedge", face(3, 7, 6, 2))}
${patch("cladBottom", "empty", face(8, 11, 10, 9))}
${patch("cladTop", "empty", face(12, 13, 14, 15))}
${patch("cladInner", "regionCoupledOFFBEAT", face(8, 12, 15, 11), coupled("cladInner", "fuelOuter", false))}
${patch("cladOuter", "patch", face(9, 10, 14, 13))}
${patch("cladFront", "wedge", face(8, 9, 13, 12))}
${patch("cladBack", "wedge", face(11, 15, 14, 10))}
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
function conductivityLines(c: Conductivity): string {
  if (c.kind === "constant") return `        k           k     [1 1 -3 -1 0]  ${num(c.k)};\n`;
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
function heatCapacityLines(cp: HeatCapacity | undefined): string {
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
function conductivityNote(region: string, k: Conductivity): string {
  if (k.kind === "constant") return `materials.${region}.k (constant)`;
  if (k.kind === "linear") return `materials.${region}: steel1515TiTobbe with par1 = a + 273.15 b, par2 = b (linear k(T))`;
  return `materials.${region}: ZyRELAP (k = par1 + par2 T - par3 T^2 + par4 T^3, T in K) with par1 = a, par2 = b, par3 = -c, par4 = d, all four written` + (k.fit ? `; fitted to a table of ${k.fit.points.length} points, degree ${k.fit.degree}, largest deviation ${(k.fit.maxRelativeDeviation * 100).toPrecision(3)}% at ${k.fit.worstAt} K (tolerance ${(k.fit.tolerance * 100).toPrecision(3)}%)` : "");
}

function constantMaterial(name: string, k: Conductivity, cp?: HeatCapacity): string {
  return `    ${name}
    {
        material constant;
        rho         rho   [1 -3 0 0 0]   ${WRITER_DENSITY};
${heatCapacityLines(cp)}${conductivityLines(k)}        emissivity  emissivity [0 0 0 0 0] 0.8;
        E           E     [1 -1 -2 0 0]  2e11;
        nu          nu    [0 0 0 0 0]    0.3;
        G           G     [1 -1 -2 0 0]  7.69e10;
        alpha       alpha [0 0 0 0 0]    1e-5;
        Tref        Tref  [0 0 0 1 0]    300;
        rheologyModel elasticity;
    }
`;
}

function solverDict(c: NormalizedCase, kf: Conductivity, kc: Conductivity): string {
  return `${FOAM_HEADER("dictionary", "solverDict", "constant")}
thermalSolver           solidConduction;
mechanicsSolver         fromLatestTime;
neutronicsSolver        none;
elementTransport        none;

materialProperties      byZone;
rheology                byMaterial;

heatSource              ${c.transient ? "timeDependentLhgr" : "constantLhgr"};
burnup                  none;
fastFlux                none;
corrosion               fromLatestTime;
gapGas                  none;
fgr                     none;
sliceMapper             autoAxialSlices;

globalOptions
{
    pinDirection            (0 0 1);
    reactorType             "LWR";
}

thermalSolverOptions
{
    heatFluxSummary     off;
}

heatSourceOptions
{
${c.transient ? `    timePoints  (${[...c.transient.times, c.transient.times[c.transient.times.length - 1]! + c.transient.timeStep].map(num).join(" ")});
    lhgr        (${[...c.transient.linearHeatRate, c.transient.linearHeatRate[c.transient.linearHeatRate.length - 1]!].map(num).join(" ")});
    timeInterpolationMethod linear;
` : `    lhgr        ${num(c.qPrime)};
`}    axialProfile { type flat; }
    radialProfile { type flat; }
    materials ( fuel );
}

materials
{
${constantMaterial("fuel", kf, c.fuelHeatCapacity)}
${constantMaterial("cladding", kc, c.claddingHeatCapacity)}}
`;
}

const NL = String.fromCharCode(10);

/** The starting temperature: one number for the whole pin, or the temperature of every cell (the blockMesh order: fuel inner to outer, then cladding inner to outer) with the outer wall. */
type StartField = { kind: "uniform"; T: number } | { kind: "field"; T: number[]; wall: number };

function temperatureField(c: NormalizedCase, start: StartField): string {
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
  const outer =
    c.boundary.kind === "convective"
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
        type            wedge;
        value           ${copy(mean)};
    }
${inner}${gap("fuelOuter", cells[nf - 1] ?? 0)}${gap("cladInner", cells[nf] ?? 0)}    cladOuter
    {
        ${outer}
    }
}
`;
}
const displacementField = (c: NormalizedCase) => `${FOAM_HEADER("volVectorField", "D")}
dimensions          [0 1 0 0 0 0 0];

internalField       uniform (0 0 0);

boundaryField
{
    ".*Front|.*Back"
    {
        type            wedge;
    }
    cladOuter
    {
        type            fixedValue;
        value           uniform (0 0 0);
    }
${c.fuelInnerRadius > 0 ? `    fuelInner
    {
        type            zeroGradient;
    }
` : ""}    "fuelOuter|cladInner"
    {
        type            gapContact;
        patchType       regionCoupledOFFBEAT;
        penaltyFactor   0.1;
        frictionCoefficient        0;
        relax           1.0;
        relaxInterfacePressure           0.1;
        value           $internalField;
    }
}
`;

const controlDict = (endTime: number, transient?: { timeStep: number; writeEvery: number }) => `${FOAM_HEADER("dictionary", "controlDict", "system")}
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

const fvSchemes = `${FOAM_HEADER("dictionary", "fvSchemes", "system")}
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

const fvSolution = `${FOAM_HEADER("dictionary", "fvSolution", "system")}
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
    fields { D 0.8; }
}
`;

/**
 * Write the OFFBEAT case files for a validated, normalized case. Constant and linear (a + b T) conductivity are supported;
 * both were checked against closed-form oracles in OFFBEAT.
 */
export function writeOffbeatCase(c: NormalizedCase): WrittenCase {
  const kf = c.fuelConductivity;
  const kc = c.claddingConductivity;
  const tr = c.transient;
  // The starting field: a uniform temperature (a steady case: the coolant or prescribed wall, which the result does not depend on), or a transient's steady operating state.
  const steadyStart = tr !== undefined && tr.initial.kind === "steady" ? initialState(c) : undefined;
  const t0 = tr ? (tr.initial.kind === "uniform" ? tr.initial.temperature : steadyStart!.peak) : c.boundary.kind === "convective" ? c.boundary.bulkTemperature : c.boundary.surfaceTemperature;
  const start: StartField = steadyStart ? { kind: "field", T: steadyStart.T, wall: steadyStart.wall } : { kind: "uniform", T: t0 };
  // A steady case runs to an end time the pin's own time constants require (at least 5e7 s); the validator refuses what cannot settle.
  let steadyEnd = MIN_STEADY_END_TIME;
  if (!tr) {
    const h = steadyEndTime(c);
    if (!h.ok) throw new Error("cannot write a steady case: " + h.message);
    steadyEnd = h.endTime;
  }
  const files: Record<string, string> = {
    "system/blockMeshDict": blockMeshDict(c),
    "system/controlDict": tr ? controlDict(tr.endTime, { timeStep: tr.timeStep, writeEvery: tr.steps / tr.outputs }) : controlDict(steadyEnd),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolution,
    "constant/solverDict": solverDict(c, kf, kc),
    "0/T": temperatureField(c, start),
    "0/D": displacementField(c),
    // marks a transient for the run script (it then keeps the field at every write time); OpenFOAM ignores the file
    ...(tr ? { "feed-transient.json": JSON.stringify({ outputs: tr.outputs, steps: tr.steps, timeStep: tr.timeStep, endTime: tr.endTime }) + "\n" } : {}),
  };
  // With hot dimensions the radii written are the expanded ones; the notes say so and give the cold value.
  const hotNote = (key: "fuelRadius" | "fuelInnerRadius" | "claddingInnerRadius" | "claddingOuterRadius", solid: "fuel" | "cladding"): string =>
    c.hot ? "; HOT value: the case's " + (c.hot.cold[key] * 1e3).toPrecision(8) + " mm expanded by " + c.hot[solid].factor.toPrecision(8) + " (docs/hot-dimensions.md)" : "";
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry.fuelRadius", file: "system/blockMeshDict", note: "block 'fuel' outer radius (mm), wedge " + WEDGE_ANGLE_DEG + " deg" + hotNote("fuelRadius", "fuel") },
    ...(c.fuelInnerRadius > 0 ? [{ field: "geometry.fuelInnerRadius", file: "system/blockMeshDict", note: "block 'fuel' inner radius (central hole); patch fuelInner, zeroGradient in 0/T (insulated) and 0/D" + hotNote("fuelInnerRadius", "fuel") }] : []),
    { field: "geometry.claddingInnerRadius", file: "system/blockMeshDict", note: "block 'cladding' inner radius" + hotNote("claddingInnerRadius", "cladding") },
    { field: "geometry.claddingOuterRadius", file: "system/blockMeshDict", note: "block 'cladding' outer radius" + hotNote("claddingOuterRadius", "cladding") },
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
    { field: "boundary", file: "0/T", note: c.boundary.kind === "convective" ? "cladOuter convectiveHTC (T0, h)" : "cladOuter fixedValue" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    tr
      ? { name: "rho", value: WRITER_DENSITY + " kg/m3", why: "carrier for the volumetric heat capacity: the model wants rho and a mass-based Cp, and only their product rho Cp enters the heat equation" }
      : { name: "rho", value: "10000 kg/m3", why: "required by the constant material model; storage only, no effect on the steady result" },
    ...(tr ? [] : [{ name: "Cp", value: "300 J/kg/K", why: "same" }]),
    { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    steadyStart
      ? { name: "initial temperature field", value: "steady state at " + (tr!.initial as { linearHeatRate: number }).linearHeatRate + " W/m, " + Math.min(...steadyStart.T).toFixed(2) + " to " + steadyStart.peak.toFixed(2) + " K", why: "the transient starts from the steady operating state of this pin at the stated heat rate (independent finite-volume solution, same mesh)" }
      : { name: "initial temperature", value: String(t0) + " K", why: tr ? "the transient's initial temperature, as given" : "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: tr ? { wedgeAngleDeg: WEDGE_ANGLE_DEG, sliceHeightMm: SLICE_HEIGHT_MM, endTime: tr.endTime, timeStep: tr.timeStep, steps: tr.steps, outputs: tr.outputs } : { wedgeAngleDeg: WEDGE_ANGLE_DEG, sliceHeightMm: SLICE_HEIGHT_MM, endTime: steadyEnd } };
}
