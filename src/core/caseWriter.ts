// Case writer: a validated thermal case in, OFFBEAT case files out (docs/plans/03-editor-and-adapter.md, A3).
// Only modelled options are written. Everything OFFBEAT needs that the case does not define is a named placeholder,
// listed in `placeholders` and in the mapping so nothing is a hidden default (see docs/spike/F0-note.md).
// Pinned against OpenFOAM Foundation 9 + OFFBEAT 80e84450 (solver/PINS.md).

import { Conductivity, NormalizedCase } from "./validate";

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
/** Steady runs use an end time far beyond any thermal time constant: a short one leaves a heat-storage term (F0 note). */
export const STEADY_END_TIME = 5e7;

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
  return `        conductivityModel steel1515TiTobbe;\n        conductivity { par1 ${num(c.a + 273.15 * c.b)}; par2 ${num(c.b)}; }\n`;
}

function constantMaterial(name: string, k: Conductivity): string {
  return `    ${name}
    {
        material constant;
        rho         rho   [1 -3 0 0 0]   10000;
        Cp          Cp    [0 2 -2 -1 0]  300;
${conductivityLines(k)}        emissivity  emissivity [0 0 0 0 0] 0.8;
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

heatSource              constantLhgr;
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
    lhgr        ${num(c.qPrime)};
    axialProfile { type flat; }
    radialProfile { type flat; }
    materials ( fuel );
}

materials
{
${constantMaterial("fuel", kf)}
${constantMaterial("cladding", kc)}}
`;
}

function temperatureField(c: NormalizedCase, t0: number): string {
  const inner = c.fuelInnerRadius > 0 ? `    fuelInner
    {
        type            zeroGradient;
    }
` : "";
  const gap = (n: string) => `    ${n}
    {
        type            resistiveGap;
        patchType       regionCoupledOFFBEAT;
        coupled         true;
        kappa           k;
        alpha           uniform ${num(c.gapConductance)};
        value           $internalField;
    }
`;
  const outer =
    c.boundary.kind === "convective"
      ? `type convectiveHTC;
        T0 uniform ${num(c.boundary.bulkTemperature)};
        h uniform ${num(c.boundary.heatTransferCoefficient)};
        value uniform ${num(t0)};`
      : `type fixedValue;
        value uniform ${num(c.boundary.surfaceTemperature)};`;
  return `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   uniform ${num(t0)};

boundaryField
{
    ".*Front|.*Back"
    {
        type            wedge;
        value           $internalField;
    }
${inner}${gap("fuelOuter")}${gap("cladInner")}    cladOuter
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

const controlDict = (endTime: number) => `${FOAM_HEADER("dictionary", "controlDict", "system")}
application     offbeat;
startFrom       latestTime;
startTime       0;
stopAt          endTime;
endTime         ${num(endTime)};
deltaT          1;
writeControl    timeStep;
writeInterval   1000;
purgeWrite      0;
writeFormat     ascii;
writeCompression off;
timeFormat      general;
timePrecision   20;
writePrecision  8;

adjustableTimeStep true;
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
  const t0 = c.boundary.kind === "convective" ? c.boundary.bulkTemperature : c.boundary.surfaceTemperature;
  const files: Record<string, string> = {
    "system/blockMeshDict": blockMeshDict(c),
    "system/controlDict": controlDict(STEADY_END_TIME),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolution,
    "constant/solverDict": solverDict(c, kf, kc),
    "0/T": temperatureField(c, t0),
    "0/D": displacementField(c),
  };
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry.fuelRadius", file: "system/blockMeshDict", note: "block 'fuel' outer radius (mm), wedge " + WEDGE_ANGLE_DEG + " deg" },
    ...(c.fuelInnerRadius > 0 ? [{ field: "geometry.fuelInnerRadius", file: "system/blockMeshDict", note: "block 'fuel' inner radius (central hole); patch fuelInner, zeroGradient in 0/T (insulated) and 0/D" }] : []),
    { field: "geometry.claddingInnerRadius", file: "system/blockMeshDict", note: "block 'cladding' inner radius" },
    { field: "geometry.claddingOuterRadius", file: "system/blockMeshDict", note: "block 'cladding' outer radius" },
    { field: "mesh.fuelCells", file: "system/blockMeshDict" },
    { field: "mesh.claddingCells", file: "system/blockMeshDict" },
    { field: "power.linearHeatRate", file: "constant/solverDict", note: "heatSourceOptions.lhgr, flat profiles" },
    { field: "materials.fuel thermal.conductivity", file: "constant/solverDict", note: kf.kind === "constant" ? "materials.fuel.k (constant)" : "materials.fuel: steel1515TiTobbe with par1 = a + 273.15 b, par2 = b (linear k(T))" },
    { field: "materials.cladding thermal.conductivity", file: "constant/solverDict", note: kc.kind === "constant" ? "materials.cladding.k (constant)" : "materials.cladding: steel1515TiTobbe with par1 = a + 273.15 b, par2 = b (linear k(T))" },
    { field: "gap.conductance", file: "0/T", note: "resistiveGap alpha on fuelOuter and cladInner" },
    { field: "boundary", file: "0/T", note: c.boundary.kind === "convective" ? "cladOuter convectiveHTC (T0, h)" : "cladOuter fixedValue" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    { name: "rho", value: "10000 kg/m3", why: "required by the constant material model; storage only, no effect on the steady result" },
    { name: "Cp", value: "300 J/kg/K", why: "same" },
    { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    { name: "initial temperature", value: String(t0) + " K", why: "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: { wedgeAngleDeg: WEDGE_ANGLE_DEG, sliceHeightMm: SLICE_HEIGHT_MM, endTime: STEADY_END_TIME } };
}
