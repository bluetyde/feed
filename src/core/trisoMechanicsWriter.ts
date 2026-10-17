// The OFFBEAT case of a coated particle's mechanics (plan 14, stage E, M2): the coating shells only (inner carbon, SiC, outer carbon: the buffer is detached and not meshed), on the
// same 2 degree wedge as the thermal particle (src/core/trisoWedge.ts: FEED's own vertex formulas, nothing copied from OFFBEAT's mesh script), elastic and steady.
//
// What OFFBEAT is given, and why:
//   * the temperature of every cell is FEED's own closed-form temperature of the particle at the cell's volume centroid (src/core/trisoSolve.ts), written as the starting field with
//     `thermalSolver constant` (OFFBEAT keeps the field and solves no conduction): the stress then rests on the particle's thermal solution and not on a second conduction solve.
//   * the gas pressure acts on the inner face of the inner carbon (a `tractionDisplacement` condition), the outside pressure on the outer face of the last layer.
//   * Young's modulus, Poisson's ratio and the expansion coefficient are constants per layer (OFFBEAT's `constant` material has no law of temperature): the reduction is
//     src/core/trisoMechanics.ts (the modulus at the layer's mean temperature, the coefficient of the same mean thermal strain), as for a pin.
//   * a free strain of a layer (radial and tangential, stated by the case) goes in through OFFBEAT's `PyC` material with its polynomial swelling model `PyCCorrelation`: the
//     polynomial's first coefficient is the strain per 1e25 n/m2 of fast fluence and the fluence is one such unit, so the strain is the coefficient. The elastic problem is linear and
//     has no creep or plasticity here, so the strain applies at once, in one step (the epsilonSwelling field is read back and checked against what the case stated). A layer without a
//     free strain is a `constant` material.

import { controlDict, FOAM_HEADER, fvSchemes, fvSolutionText, num, WrittenCase } from "./caseWriter";
import type { NormalizedTriso } from "./triso";
import { trisoCellCentre, trisoLayerTemperature, trisoMechanicsConstants, TrisoLayerConstants } from "./trisoMechanics";
import { trisoClosedForm } from "./trisoSolve";
import { writeTrisoCase, UM, TRISO_ZONE } from "./trisoWriter";

/**
 * The wedge of the mechanics mesh. It is thinner than the thermal particle's (1 degree half angle): OFFBEAT's tangential strain on a wedge differs from u / r by about half the square
 * of the half angle times the total strain (found in M2: 5e-7 of a thermal strain of 3.4e-3 at 1 degree), which for the small stress that thermal mismatch makes between layers is not
 * negligible; at 0.25 degree it is sixteen times smaller. The geometry is the thermal one's (src/core/trisoWedge.ts): the vertices of a level of radius r are (x, +-y, +-y) with
 * x = r cos(a) / s, y = r sin(a) / s, s = sqrt(1 + sin(a)^2), so every vertex lies on the sphere of radius r, and the wedge's sphere has every radius multiplied by cos(a) / s.
 */
export const TRISO_MECH_WEDGE_HALF_ANGLE_DEG = 0.25;
export const TRISO_MECH_WEDGE_HALF = (TRISO_MECH_WEDGE_HALF_ANGLE_DEG / 180) * Math.PI;
const WEDGE_S = Math.sqrt(1 + Math.sin(TRISO_MECH_WEDGE_HALF) ** 2);
export const TRISO_MECH_WEDGE_SCALE = Math.cos(TRISO_MECH_WEDGE_HALF) / WEDGE_S;

/** The four vertices of a level of radius r (micrometres). */
function level(rUm: number): number[][] {
  const x = (rUm * Math.cos(TRISO_MECH_WEDGE_HALF)) / WEDGE_S;
  const y = (rUm * Math.sin(TRISO_MECH_WEDGE_HALF)) / WEDGE_S;
  return [[x, y, -y], [x, y, y], [x, -y, y], [x, -y, -y]];
}

/** The patches the mechanics results read: the inside of the inner carbon and the outside of the last layer. */
export const TRISO_MECH_PATCHES = { inner: "inner", outer: "outer" } as const;
/** One step of this length (s) carries the fluence of one unit of the polynomial (see the header). */
export const TRISO_MECH_END_TIME = 10;
/** The fast flux (n/cm2/s) that gives 1e25 n/m2 of fluence in TRISO_MECH_END_TIME seconds. */
export const TRISO_MECH_FLUX = 1e20;

/** The mesh cells of a mechanical layer, in blockMesh order: [innerRadius, outerRadius] of each cell on the nominal sphere. */
export function trisoMechanicsCells(n: NormalizedTriso): { layer: string; a: number; b: number }[] {
  const out: { layer: string; a: number; b: number }[] = [];
  for (const k of trisoMechanicsConstants(n)) {
    const index = n.layers.findIndex((l) => l.name === k.name);
    const count = n.cells[index + 1]!;
    for (let i = 0; i < count; i++) out.push({ layer: k.name, a: k.innerRadius + ((k.outerRadius - k.innerRadius) * i) / count, b: k.innerRadius + ((k.outerRadius - k.innerRadius) * (i + 1)) / count });
  }
  return out;
}

export function trisoMechanicsBlockMeshDict(n: NormalizedTriso): string {
  const ks = trisoMechanicsConstants(n);
  const radii = [ks[0]!.innerRadius, ...ks.map((k) => k.outerRadius)];
  const verts = radii.flatMap((r) => level(r * UM));
  const vtx = verts.map((p) => `    (${p.map((v) => num(v)).join(" ")})`).join("\n");
  const blocks = ks
    .map((k, j) => {
      const index = n.layers.findIndex((l) => l.name === k.name);
      const b = j * 4;
      return `    hex ( ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => b + i).join(" ")} ) ${TRISO_ZONE[k.name]} (1 1 ${n.cells[index + 1]}) simpleGrading (1 1 1)`;
    })
    .join("\n");
  const face = (b: number, ...i: number[]) => `            (${i.map((x) => b + x).join(" ")})`;
  const patch = (name: string, type: string, faces: string) => `    ${name}\n    {\n        type ${type};\n        faces\n        (\n${faces}\n        );\n    }\n`;
  const sides = (a: number, b: number, c: number, d: number) => ks.map((_, j) => face(j * 4, a, b, c, d)).join("\n");
  return `${FOAM_HEADER("dictionary", "blockMeshDict")}
convertToMeters 1e-06;

vertices
(
${vtx}
);

blocks
(
${blocks}
);

edges
(
);

boundary
(
${patch("top", "wedge", sides(0, 1, 5, 4))}
${patch("front", "wedge", sides(1, 2, 6, 5))}
${patch("back", "wedge", sides(0, 4, 7, 3))}
${patch("bottom", "wedge", sides(2, 3, 7, 6))}
${patch(TRISO_MECH_PATCHES.inner, "patch", face(0, 0, 1, 2, 3))}
${patch(TRISO_MECH_PATCHES.outer, "patch", face((ks.length - 1) * 4, 4, 5, 6, 7))}
);

mergePatchPairs
(
);
`;
}

/** The temperature of every cell (K): FEED's closed form at the cell's volume centroid on the nominal sphere, in blockMesh order. */
export function trisoMechanicsTemperatures(n: NormalizedTriso): number[] {
  const cf = trisoClosedForm(n);
  return trisoMechanicsCells(n).map((c) => trisoLayerTemperature(n, cf, n.layers.findIndex((l) => l.name === c.layer), trisoCellCentre(c.a, c.b)));
}

function temperatureField(n: NormalizedTriso): string {
  const cf = trisoClosedForm(n);
  const T = trisoMechanicsTemperatures(n);
  const NL = String.fromCharCode(10);
  const mean = T.reduce((x, y) => x + y, 0) / T.length;
  return `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   nonuniform List<scalar>${NL}${T.length}${NL}(${NL}${T.map(num).join(NL)}${NL})${NL};

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
        value           uniform ${num(mean)};
    }
    ${TRISO_MECH_PATCHES.inner}
    {
        type            fixedValue;
        value           uniform ${num(cf.regions[2]!.innerT)};
    }
    ${TRISO_MECH_PATCHES.outer}
    {
        type            fixedValue;
        value           uniform ${num(cf.wallT)};
    }
}
`;
}

function displacementField(n: NormalizedTriso): string {
  const m = n.mechanics!;
  const traction = (name: string, pressure: number) => `    ${name}
    {
        type            tractionDisplacement;
        traction        uniform (0 0 0);
        pressure        uniform ${num(pressure)};
        relax           1.0;
        value           uniform (0 0 0);
    }
`;
  return `${FOAM_HEADER("volVectorField", "D")}
dimensions          [0 1 0 0 0 0 0];

internalField       uniform (0 0 0);

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
    }
${traction(TRISO_MECH_PATCHES.outer, m.outsidePressure)}${traction(TRISO_MECH_PATCHES.inner, m.gasPressure)}}
`;
}

function materialBlock(k: TrisoLayerConstants, referenceTemperature: number): string {
  const zone = TRISO_ZONE[k.name];
  if (!k.freeStrain) {
    return `    ${zone}
    {
        material constant;
        rho         rho   [1 -3 0 0 0]   1900;
        Cp          Cp    [0 2 -2 -1 0]  1;
        k           k     [1 1 -3 -1 0]  1;
        emissivity  emissivity [0 0 0 0 0] 0.8;
        E           E     [1 -1 -2 0 0]  ${num(k.E)};
        nu          nu    [0 0 0 0 0]    ${num(k.nu)};
        G           G     [1 -1 -2 0 0]  ${num(k.G)};
        alpha       alpha [0 0 0 0 0]    ${num(k.alpha)};
        Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature)};
        rheologyModel elasticity;
    }
`;
  }
  const fs = k.freeStrain;
  return `    ${zone}
    {
        material PyC;

        densityModel                constant;
        conductivityModel           constant;
        heatCapacityModel           constant;
        emissivityModel             constant;
        YoungModulusModel           constant;
        PoissonRatioModel           constant;
        thermalExpansionModel       constant;
        swellingModel               PyCCorrelation;
        radialCoefficients          (${num(fs.radial)} 0 0 0 0 0);
        tangentialCoefficients      (${num(fs.tangential)} 0 0 0 0 0);

        rho         rho   [1 -3 0 0 0]   1900;
        Cp          Cp    [0 2 -2 -1 0]  1;
        k           k     [1 1 -3 -1 0]  1;
        emissivity  emissivity [0 0 0 0 0] 0.8;
        E           E     [1 -1 -2 0 0]  ${num(k.E)};
        nu          nu    [0 0 0 0 0]    ${num(k.nu)};
        alpha       alpha [0 0 0 0 0]    ${num(k.alpha)};
        Tref        Tref  [0 0 0 1 0]    ${num(referenceTemperature)};

        rheologyModel               elasticity;
    }
`;
}

function solverDict(n: NormalizedTriso): string {
  const m = n.mechanics!;
  const ks = trisoMechanicsConstants(n);
  const free = ks.some((k) => k.freeStrain);
  const zones = ks.map((k) => TRISO_ZONE[k.name]).join(" ");
  return `${FOAM_HEADER("dictionary", "solverDict", "constant")}
thermalSolver           constant;
mechanicsSolver         smallStrain;
neutronicsSolver        none;
elementTransport        none;

materialProperties      byZone;
rheology                byMaterial;

heatSource              none;
burnup                  none;
fastFlux                ${free ? "timeDependentAxialProfile" : "none"};
corrosion               fromLatestTime;
gapGas                  none;

fgr                     none;
sliceMapper             autoAxialSlices;

globalOptions
{
    pinDirection            (0 0 1);
    reactorType             "LWR";
}

rheologyOptions
{
    thermalExpansion on;
}

mechanicsSolverOptions
{
    forceSummary        off;
    cylindricalStress   off;

    multiMaterialCorrection
    {
        type                    uniform;
        defaultWeights          1;
    }
}
${free ? `
fastFluxOptions
{
    timePoints  (0 ${num(2 * TRISO_MECH_END_TIME)});
    fastFlux    (${num(TRISO_MECH_FLUX)} ${num(TRISO_MECH_FLUX)});
    timeInterpolationMethod linear;

    axialProfile
    {
        type flat;
    }

    materials (${zones});
}
` : ""}
materials
{
${ks.map((k) => materialBlock(k, m.referenceTemperature)).join("")}}
`;
}

/** The OFFBEAT case of a particle's mechanics: one step of a fixed length from the particle's closed-form temperatures. */
export function writeTrisoMechanicsCase(n: NormalizedTriso): WrittenCase {
  if (!n.mechanics) throw new Error("this particle has no mechanics section");
  const m = n.mechanics;
  const ks = trisoMechanicsConstants(n);
  const files: Record<string, string> = {
    "system/blockMeshDict": trisoMechanicsBlockMeshDict(n),
    "system/controlDict": controlDict(TRISO_MECH_END_TIME, { timeStep: TRISO_MECH_END_TIME, writeEvery: 1 }),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolutionText(true),
    "constant/solverDict": solverDict(n),
    "0/T": temperatureField(n),
    "0/D": displacementField(n),
  };
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry", file: "system/blockMeshDict", note: `the coating shells only (${ks.map((k) => k.name).join(", ")}; the buffer is detached and not meshed) on a double wedge of the thermal particle's shape but thinner (vertex formulas of src/core/trisoWedge.ts, half angle ${TRISO_MECH_WEDGE_HALF_ANGLE_DEG} degree); the wedge's sphere has every radius ${TRISO_MECH_WEDGE_SCALE.toFixed(6)} times the case's, and the stress is the same at corresponding points` },
    ...ks.map((k) => ({ field: "geometry.layers." + k.name, file: "system/blockMeshDict", note: `block '${TRISO_ZONE[k.name]}' from ${(k.innerRadius * UM).toPrecision(8)} to ${(k.outerRadius * UM).toPrecision(8)} um, ${n.cells[n.layers.findIndex((l) => l.name === k.name) + 1]} cells` })),
    { field: "temperatures", file: "0/T", note: "thermalSolver constant: the starting temperature of every cell is FEED's closed-form temperature of the particle (src/core/trisoSolve.ts) at the cell's volume centroid, kept by the solver; the faces carry the closed form's temperatures (formal)" },
    { field: "mechanics.referenceTemperature", file: "constant/solverDict", note: `Tref ${num(m.referenceTemperature)} K of every layer; thermalExpansion on` },
    ...ks.map((k) => ({ field: "materials." + k.name + " mechanical.*", file: "constant/solverDict", note: `E ${num(k.E)} Pa at the layer's mean temperature ${k.meanTemperature.toFixed(1)} K, nu ${num(k.nu)}, alpha ${num(k.alpha)} 1/K (the coefficient of the same mean thermal strain from ${num(m.referenceTemperature)} K)` })),
    ...m.freeStrains.map((f) => ({ field: "mechanics.freeStrains." + f.layer, file: "constant/solverDict", note: `PyC material, swellingModel PyCCorrelation, radialCoefficients (${num(f.radial)} 0 0 0 0 0) and tangentialCoefficients (${num(f.tangential)} 0 0 0 0 0): at the fluence of one unit (1e25 n/m2, flux ${num(TRISO_MECH_FLUX)} n/cm2/s for ${TRISO_MECH_END_TIME} s) the strain is the coefficient. Source: ${f.source}` })),
    { field: "mechanics.gasPressure", file: "0/D", note: `${TRISO_MECH_PATCHES.inner} tractionDisplacement, pressure ${num(m.gasPressure)} Pa${m.gasPressureSource ? " (" + m.gasPressureSource + ")" : ""}` },
    { field: "mechanics.outsidePressure", file: "0/D", note: `${TRISO_MECH_PATCHES.outer} tractionDisplacement, pressure ${num(m.outsidePressure)} Pa` },
    { field: "assumptions", file: "constant/solverDict", note: "mechanicsSolver smallStrain, no creep or plasticity (rheologyModel elasticity), no gap, no contact; burnup none, fgr none, gapGas none" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    { name: "rho, Cp, k, emissivity", value: "1900 or the writer's density, 1, 1, 0.8", why: "required by the material models; no conduction is solved (thermalSolver constant) and the problem is steady" },
    { name: "time step", value: `one step of ${TRISO_MECH_END_TIME} s`, why: "the elastic problem has no history: one step reaches the answer; the fast flux is chosen so that the step's fluence is one unit of the swelling polynomial" },
  ];
  return { files, mapping, placeholders, choices: { wedgeHalfAngleDeg: TRISO_MECH_WEDGE_HALF_ANGLE_DEG, wedgeScale: TRISO_MECH_WEDGE_SCALE, endTime: TRISO_MECH_END_TIME, timeStep: TRISO_MECH_END_TIME } };
}

/** The OFFBEAT case of a particle: the thermal one, or (with a mechanics section) the coating's mechanics. */
export function writeTrisoParticleCase(n: NormalizedTriso): WrittenCase {
  return n.mechanics ? writeTrisoMechanicsCase(n) : writeTrisoCase(n);
}
