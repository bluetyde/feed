// The OFFBEAT case of a coated particle (plan 13, T3): a thermal-only sphere, written from the case alone.
//
// The mesh is a thin double wedge on the x axis, written here from its own formulas (nothing is copied from OFFBEAT's tutorial or its mesh script, which are GPL-3.0; FEED is MIT).
// A level of radius r has four vertices at (x, +-y, +-y) with
//     x = r cos(a) / s,  y = r sin(a) / s,  s = sqrt(1 + sin(a)^2),
// so that x^2 + 2 y^2 = r^2: every vertex lies on the sphere of radius r, and a = 1 degree gives the 2 degree wedge. The four side faces are the planes y = +-x tan(a) and
// z = +-x tan(a), so a block between two levels is a frustum of a square pyramid with its apex at the origin.
//
// What the solver then solves (derived here, checked in tests/trisoWriter.test.ts against volumes and areas computed another way, and against the saved real runs): in the
// coordinate x along the axis the section at x is a square of side 2 x tan(a), area A(x) = 4 tan(a)^2 x^2, so the heat equation on the pyramid is the heat equation of a SPHERE
// in the coordinate x, with the same conductivities and conductances, the same volumetric power, and every radius multiplied by
//     lambda = cos(a) / sqrt(1 + sin(a)^2)    (0.999698 for a = 1 degree).
// A cell centre is reported at its volume centroid, whose length is x, so the radius of a cell is the length of its centre vector and lies on that scaled sphere. The scaled
// sphere is `wedgeEquivalent`: the one the results are checked against.

import { SPHERE } from "./geometry";
import { conductivityNote, constantMaterial, controlDict, FOAM_HEADER, fvSchemes, fvSolutionText, num, WrittenCase } from "./caseWriter";
import { MIN_STEADY_END_TIME } from "./steadyState";
import type { NormalizedTriso, TrisoLayerName } from "./triso";
import { trisoSteadyEndTime } from "./trisoSolve";

/** Half of the wedge's opening angle, degrees (the wedge is 2 degrees). */
export const TRISO_WEDGE_HALF_ANGLE_DEG = 1;
const HALF = (TRISO_WEDGE_HALF_ANGLE_DEG / 180) * Math.PI;
const S = Math.sqrt(1 + Math.sin(HALF) ** 2);
/** The factor by which the wedge's pyramid differs from a sphere of the same radii: the wedge is the sphere with every radius multiplied by it (see above). */
export const TRISO_WEDGE_SCALE = Math.cos(HALF) / S;
/** The fraction of a sphere's surface that a face of the wedge covers at radius r (the face is a square of side 2 y), and of a sphere's volume that a block between two radii covers (a frustum of a pyramid). Their ratio is the scale above. */
export const TRISO_WEDGE_AREA_FRACTION = Math.sin(HALF) ** 2 / (Math.PI * S * S);
export const TRISO_WEDGE_VOLUME_FRACTION = (Math.sin(HALF) ** 2 * Math.cos(HALF)) / (Math.PI * S ** 3);

/** The names OFFBEAT's cell zones and materials carry for each region. */
export const TRISO_ZONE: Record<"kernel" | TrisoLayerName, string> = { kernel: "Kernel", buffer: "Buffer", ipyc: "IPyC", sic: "SiC", opyc: "OPyC" };
export const TRISO_ZONE_ORDER = ["kernel", "buffer", "ipyc", "sic", "opyc"] as const;
/** The patches the results read: the buffer's outer face, the next layer's inner face, the outside. */
export const TRISO_PATCHES = { gapInner: "bufferOuter", gapOuter: "ipycInner", outer: "outer" } as const;

/** Micrometres: the mesh is written in them (convertToMeters 1e-06) so that the numbers stay readable. */
const UM = 1e6;

/**
 * The particle the wedge solves: the same case with every radius multiplied by TRISO_WEDGE_SCALE and the kernel's power density unchanged (so the power is that of the smaller
 * kernel). Its closed form and its finite-volume solution are what OFFBEAT's cell values are compared with.
 */
export function wedgeEquivalent(n: NormalizedTriso, scale = TRISO_WEDGE_SCALE): NormalizedTriso {
  const kernelRadius = n.kernelRadius * scale;
  const kernelVolume = SPHERE.volume(0, kernelRadius);
  const particlePower = n.power.kernelPowerDensity * kernelVolume;
  return {
    ...n,
    kernelRadius,
    layers: n.layers.map((l) => ({ ...l, innerRadius: l.innerRadius * scale, outerRadius: l.outerRadius * scale })),
    outerRadius: n.outerRadius * scale,
    power: { ...n.power, particlePower, kernelVolume, particleVolume: SPHERE.volume(0, n.outerRadius * scale) },
  };
}

/** The four vertices of a level of radius r (micrometres): (x, +y, -y), (x, +y, +y), (x, -y, +y), (x, -y, -y). */
function level(rUm: number): number[][] {
  if (rUm === 0) return [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const x = (rUm * Math.cos(HALF)) / S;
  const y = (rUm * Math.sin(HALF)) / S;
  return [[x, y, -y], [x, y, y], [x, -y, y], [x, -y, -y]];
}

/**
 * The mesh, region by region from the centre outward. The levels are the radii 0, the kernel's, the buffer's outer radius, then the buffer's outer radius again (the layer after
 * the buffer starts on a separate set of vertices, so the gap between them is two coupled patches, as for the pin), and the other layers' outer radii.
 */
export function trisoBlockMeshDict(n: NormalizedTriso): string {
  const radii = [0, n.kernelRadius, ...n.layers.map((l) => l.outerRadius)];
  const levelsR = [radii[0]!, radii[1]!, radii[2]!, radii[2]!, ...radii.slice(3)];
  const verts = levelsR.flatMap((r) => level(r * UM));
  const vtx = verts.map((p) => `    (${p.map((v) => num(v)).join(" ")})`).join("\n");
  const names = ["Kernel", ...n.layers.map((l) => TRISO_ZONE[l.name])];
  // the lower level of region j: 0 for the kernel, 1 for the buffer, then 3, 4, ... (level 2 is the buffer's outer face, level 3 the next layer's inner face)
  const lower = (j: number) => (j === 0 ? 0 : j === 1 ? 1 : j + 1);
  const blocks = names
    .map((nm, j) => {
      const b = lower(j) * 4;
      const idx = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => b + i);
      return `    hex ( ${idx.join(" ")} ) ${nm} (1 1 ${n.cells[j]}) simpleGrading (1 1 1)`;
    })
    .join("\n");
  const face = (b: number, ...i: number[]) => `            (${i.map((k) => b + k).join(" ")})`;
  const patch = (name: string, type: string, faces: string, extra = "") => `    ${name}\n    {\n        type ${type};\n${extra}        faces\n        (\n${faces}\n        );\n    }\n`;
  const sides = (a: number, b: number, c: number, d: number) => names.map((_, j) => face(lower(j) * 4, a, b, c, d)).join("\n");
  const last = lower(names.length - 1) * 4;
  const bufferBase = lower(1) * 4;
  const ipycBase = lower(2) * 4;
  const coupled = (other: string, owner: boolean) => `        neighbourPatch ${other};\n        neighbourRegion region0;\n        owner ${owner};\n        updateAMI true;\n`;
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
${patch(TRISO_PATCHES.outer, "patch", face(last, 4, 5, 6, 7))}
${patch(TRISO_PATCHES.gapInner, "regionCoupledOFFBEAT", face(bufferBase, 4, 5, 6, 7), coupled(TRISO_PATCHES.gapOuter, true))}
${patch(TRISO_PATCHES.gapOuter, "regionCoupledOFFBEAT", face(ipycBase, 0, 1, 2, 3), coupled(TRISO_PATCHES.gapInner, false))}
);

mergePatchPairs
(
);
`;
}

function trisoMaterial(name: string, k: NormalizedTriso["kernelConductivity"]): string {
  return constantMaterial(name, k);
}

function solverDict(n: NormalizedTriso, endTime: number): string {
  const q = n.power.kernelPowerDensity;
  // the table reaches past the end time: OFFBEAT aborts when a table point equals the end time (docs/spike/triso-probe.md)
  const tEnd = 2 * endTime;
  const materials = [trisoMaterial("Kernel", n.kernelConductivity), ...n.layers.map((l) => trisoMaterial(TRISO_ZONE[l.name], l.conductivity))].join("\n");
  return `${FOAM_HEADER("dictionary", "solverDict", "constant")}
thermalSolver           solidConduction;
mechanicsSolver         fromLatestTime;
neutronicsSolver        none;
elementTransport        none;

materialProperties      byZone;
rheology                byMaterial;

heatSource              timeDependentVhgr;
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
    timePoints  (0 ${num(tEnd)});
    vhgr        (${num(q)} ${num(q)});
    timeInterpolationMethod linear;
    materials ( Kernel );
}

materials
{
${materials}}
`;
}

function temperatureField(n: NormalizedTriso, t0: number): string {
  const outer =
    n.boundary.kind === "convective"
      ? `type convectiveHTC;\n        T0 uniform ${num(n.boundary.bulkTemperature)};\n        h uniform ${num(n.boundary.heatTransferCoefficient)};\n        value uniform ${num(t0)};`
      : `type fixedValue;\n        value uniform ${num(n.boundary.surfaceTemperature)};`;
  const gap = (name: string) => `    ${name}
    {
        type            resistiveGap;
        patchType       regionCoupledOFFBEAT;
        coupled         true;
        kappa           k;
        alpha           uniform ${num(n.gapConductance)};
        value           $internalField;
    }
`;
  return `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   uniform ${num(t0)};

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
        value           $internalField;
    }
${gap(TRISO_PATCHES.gapInner)}${gap(TRISO_PATCHES.gapOuter)}    ${TRISO_PATCHES.outer}
    {
        ${outer}
    }
}
`;
}

const displacementField = `${FOAM_HEADER("volVectorField", "D")}
dimensions          [0 1 0 0 0 0 0];

internalField       uniform (0 0 0);

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
    }
    ${TRISO_PATCHES.outer}
    {
        type            fixedValue;
        value           uniform (0 0 0);
    }
    "${TRISO_PATCHES.gapInner}|${TRISO_PATCHES.gapOuter}"
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

/** The OFFBEAT case of a steady particle: mesh, dictionaries, fields. Throws when the particle cannot settle (the validator refuses such a case first). */
export function writeTrisoCase(n: NormalizedTriso): WrittenCase {
  const h = trisoSteadyEndTime(n);
  if (!h.ok) throw new Error("cannot write a steady particle case: " + h.message);
  const endTime = h.endTime;
  const t0 = n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature;
  const files: Record<string, string> = {
    "system/blockMeshDict": trisoBlockMeshDict(n),
    "system/controlDict": controlDict(endTime),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolutionText(false),
    "constant/solverDict": solverDict(n, endTime),
    "0/T": temperatureField(n, t0),
    "0/D": displacementField,
  };
  const names = ["kernel", ...n.layers.map((l) => l.name)];
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry", file: "system/blockMeshDict", note: `a 2 degree double wedge on the x axis, written from the vertex formulas of src/core/trisoWriter.ts (a level of radius r has its vertices at x = r cos(a)/s, y = r sin(a)/s, s = sqrt(1 + sin(a)^2), a = ${TRISO_WEDGE_HALF_ANGLE_DEG} degree), so every vertex lies on the sphere of radius r; one block per region (cell zones ${names.map((k) => TRISO_ZONE[k as keyof typeof TRISO_ZONE]).join(", ")}) in micrometres; the buffer's outer face and the next layer's inner face are the coupled patches ${TRISO_PATCHES.gapInner} and ${TRISO_PATCHES.gapOuter}, the outside is the patch ${TRISO_PATCHES.outer}; the wedge solves the sphere whose radii are ${TRISO_WEDGE_SCALE.toFixed(6)} of these` },
    { field: "geometry.kernelRadius", file: "system/blockMeshDict", note: "kernel block outer radius (um)" },
    ...n.layers.map((l) => ({ field: "geometry.layers." + l.name + ".thickness", file: "system/blockMeshDict", note: `block '${TRISO_ZONE[l.name]}' from ${(l.innerRadius * UM).toPrecision(8)} to ${(l.outerRadius * UM).toPrecision(8)} um` })),
    ...names.map((k, i) => ({ field: "mesh." + k + "Cells", file: "system/blockMeshDict", note: `${n.cells[i]} cells across the ${TRISO_ZONE[k as keyof typeof TRISO_ZONE]} block` })),
    { field: "power", file: "constant/solverDict", note: `heatSource timeDependentVhgr, kernel only (materials ( Kernel )): ${num(n.power.kernelPowerDensity)} W/m3 (${num(n.power.particlePower)} W per particle); the table runs to twice the end time because OFFBEAT aborts when a table point equals the end time` },
    { field: "materials.kernel thermal.conductivity", file: "constant/solverDict", note: conductivityNote("kernel", n.kernelConductivity) },
    ...n.layers.map((l) => ({ field: "materials." + l.name + " thermal.conductivity", file: "constant/solverDict", note: conductivityNote(l.name, l.conductivity) })),
    { field: "gap.conductance", file: "0/T", note: `resistiveGap alpha on ${TRISO_PATCHES.gapInner} and ${TRISO_PATCHES.gapOuter}, no gas model (gapGas none, fgr none)` },
    { field: "boundary", file: "0/T", note: n.boundary.kind === "convective" ? "outer convectiveHTC (T0, h)" : "outer fixedValue" },
    { field: "assumptions", file: "constant/solverDict", note: "mechanicsSolver fromLatestTime (no mechanics), burnup none, fastFlux none, fgr none, gapGas none" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    { name: "rho, Cp", value: "10000 kg/m3, 300 J/kg/K", why: "required by the constant material model; storage only, no effect on the steady result" },
    { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    { name: "initial temperature", value: String(t0) + " K", why: "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: { wedgeHalfAngleDeg: TRISO_WEDGE_HALF_ANGLE_DEG, wedgeScale: TRISO_WEDGE_SCALE, endTime, minEndTime: MIN_STEADY_END_TIME } };
}
