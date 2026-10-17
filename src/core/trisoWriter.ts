// The OFFBEAT case of a coated particle (plan 13, T3): a thermal-only sphere, written from the case alone, steady or transient.
//
// The mesh is a thin double wedge on the x axis, written here from its own formulas (src/core/trisoWedge.ts: nothing is copied from OFFBEAT's tutorial or its mesh script, which are
// GPL-3.0; FEED is MIT). The wedge solves the sphere whose radii are lambda = cos(a)/sqrt(1 + sin(a)^2) = 0.999698 times the case's (derived there): the results are checked against it.

import { conductivityNote, constantMaterial, controlDict, FOAM_HEADER, fvSchemes, fvSolutionText, num, WrittenCase } from "./caseWriter";
import { tableForSolver } from "./boundaryHistory";
import { MIN_STEADY_END_TIME } from "./steadyState";
import type { NormalizedTriso, TrisoLayerName } from "./triso";
import { trisoSteadyEndTime } from "./trisoSolve";
import { trisoInitialField } from "./trisoTransientModel";
import { TRISO_WEDGE_HALF, TRISO_WEDGE_HALF_ANGLE_DEG, TRISO_WEDGE_S, TRISO_WEDGE_SCALE } from "./trisoWedge";
import type { HeatCapacity } from "./validate";

export * from "./trisoWedge";

/** The names OFFBEAT's cell zones and materials carry for each region. */
export const TRISO_ZONE: Record<"kernel" | TrisoLayerName, string> = { kernel: "Kernel", buffer: "Buffer", ipyc: "IPyC", sic: "SiC", opyc: "OPyC" };
export const TRISO_ZONE_ORDER = ["kernel", "buffer", "ipyc", "sic", "opyc"] as const;
/** The patches the results read: the buffer's outer face, the next layer's inner face, the outside. */
export const TRISO_PATCHES = { gapInner: "bufferOuter", gapOuter: "ipycInner", outer: "outer" } as const;

/** Micrometres: the mesh is written in them (convertToMeters 1e-06) so that the numbers stay readable. */
export const UM = 1e6;

/** The four vertices of a level of radius r (micrometres): (x, +y, -y), (x, +y, +y), (x, -y, +y), (x, -y, -y). */
export function level(rUm: number): number[][] {
  if (rUm === 0) return [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const x = (rUm * Math.cos(TRISO_WEDGE_HALF)) / TRISO_WEDGE_S;
  const y = (rUm * Math.sin(TRISO_WEDGE_HALF)) / TRISO_WEDGE_S;
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

function trisoMaterial(name: string, k: NormalizedTriso["kernelConductivity"], cp?: HeatCapacity): string {
  return constantMaterial(name, k, cp);
}

function solverDict(n: NormalizedTriso, endTime: number): string {
  const q = n.power.kernelPowerDensity;
  const tr = n.transient;
  // the table reaches past the end time: OFFBEAT aborts when a table point equals the end time (docs/spike/triso-probe.md)
  const tEnd = 2 * endTime;
  const caps = n.capacities;
  const materials = [trisoMaterial("Kernel", n.kernelConductivity, tr ? caps![0] : undefined), ...n.layers.map((l, i) => trisoMaterial(TRISO_ZONE[l.name], l.conductivity, tr ? caps![i + 1] : undefined))].join("\n");
  // a transient: the power table of the case as a volumetric power in the kernel (W per particle over the nominal kernel volume), one flat point a step after the last
  const table = tr
    ? `    timePoints  (${[...tr.times, tr.times[tr.times.length - 1]! + tr.timeStep].map(num).join(" ")});
    vhgr        (${[...tr.particlePower, tr.particlePower[tr.particlePower.length - 1]!].map((p) => num(p / n.power.kernelVolume)).join(" ")});`
    : `    timePoints  (0 ${num(tEnd)});
    vhgr        (${num(q)} ${num(q)});`;
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
${table}
    timeInterpolationMethod linear;
    materials ( Kernel );
}

materials
{
${materials}}
`;
}

export const NL = String.fromCharCode(10);

/** The starting field: one number for the whole particle, or the temperature of every cell (kernel inner to outer, then each layer) with the outside's temperature. */
type StartField = { kind: "uniform"; T: number } | { kind: "field"; T: number[]; wall: number };

/** The outside: a prescribed wall or a film, from the case, or the transient's table against time (the pin's boundary history, same patch types). */
function outerBoundary(n: NormalizedTriso, startWall: number): string {
  const hist = n.transient?.boundaryHistory;
  if (hist) {
    const tab = tableForSolver(hist, n.transient!.endTime, n.transient!.timeStep);
    const rows = (col: number[]) => "(" + col.map((v) => "(" + num(v) + " " + num(v) + ")").join(" ") + ")";
    // the mesh is a few micrometres across: the table is read at the one height, with two equal columns, as for a pin
    return hist.kind === "convective"
      ? `type timeDependentAxialProfileHTC;
        axialProfileDict
        {
            timePoints (${tab.times.map(num).join(" ")});
            axialLocations (0 1);
            hData ${rows(tab.columns[0]!)};
            T0Data ${rows(tab.columns[1]!)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(startWall)};`
      : `type timeDependentAxialProfileT;
        timeDependentProfile
        {
            timePoints (${tab.times.map(num).join(" ")});
            axialLocations (0 1);
            axialData ${rows(tab.columns[0]!)};
            axialInterpolationMethod linear;
            timeInterpolationMethod linear;
        }
        value uniform ${num(startWall)};`;
  }
  return n.boundary.kind === "convective"
    ? `type convectiveHTC;\n        T0 uniform ${num(n.boundary.bulkTemperature)};\n        h uniform ${num(n.boundary.heatTransferCoefficient)};\n        value uniform ${num(startWall)};`
    : `type fixedValue;\n        value uniform ${num(n.boundary.surfaceTemperature)};`;
}

function temperatureField(n: NormalizedTriso, start: StartField): string {
  const uniform = start.kind === "uniform";
  const cells = start.kind === "field" ? start.T : [];
  // a uniform start is written as one value and the patches copy it ($internalField). A field cannot be copied into a patch (the sizes differ), so each patch gets a uniform
  // starting value near it: the wedge planes the mean, the gap faces the neighbouring cell, the outside the wall. The boundary conditions overwrite them.
  const mean = cells.length ? cells.reduce((x, y) => x + y, 0) / cells.length : 0;
  const copy = (x: number) => (uniform ? "$internalField" : `uniform ${num(x)}`);
  const internal = start.kind === "uniform" ? `uniform ${num(start.T)}` : `nonuniform List<scalar>${NL}${cells.length}${NL}(${NL}${cells.map(num).join(NL)}${NL})${NL}`;
  const startWall = start.kind === "uniform" ? start.T : start.wall;
  const nBuffer = n.cells[0]! + n.cells[1]!;
  const gap = (name: string, near: number) => `    ${name}
    {
        type            resistiveGap;
        patchType       regionCoupledOFFBEAT;
        coupled         true;
        kappa           k;
        alpha           uniform ${num(n.gapConductance)};
        value           ${copy(near)};
    }
`;
  return `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   ${internal};

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
        value           ${copy(mean)};
    }
${gap(TRISO_PATCHES.gapInner, cells[nBuffer - 1] ?? 0)}${gap(TRISO_PATCHES.gapOuter, cells[nBuffer] ?? 0)}    ${TRISO_PATCHES.outer}
    {
        ${outerBoundary(n, startWall)}
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

/** The OFFBEAT case of a particle: mesh, dictionaries, fields; steady (run to the particle's own end time) or a transient (fixed steps to the case's end time). Throws when a steady particle cannot settle (the validator refuses such a case first). */
export function writeTrisoCase(n: NormalizedTriso): WrittenCase {
  const tr = n.transient;
  let endTime: number;
  if (tr) endTime = tr.endTime;
  else {
    const h = trisoSteadyEndTime(n);
    if (!h.ok) throw new Error("cannot write a steady particle case: " + h.message);
    endTime = h.endTime;
  }
  // a steady start of a transient is the independent solution's steady field on this mesh, written for every cell
  const steadyStart = tr && tr.initial.kind === "steady" ? trisoInitialField(n) : undefined;
  const t0 = tr ? (tr.initial.kind === "uniform" ? tr.initial.temperature : steadyStart!.peak) : n.boundary.kind === "convective" ? n.boundary.bulkTemperature : n.boundary.surfaceTemperature;
  const start: StartField = steadyStart ? { kind: "field", T: steadyStart.T, wall: steadyStart.wall } : { kind: "uniform", T: t0 };
  const files: Record<string, string> = {
    "system/blockMeshDict": trisoBlockMeshDict(n),
    "system/controlDict": tr ? controlDict(tr.endTime, { timeStep: tr.timeStep, writeEvery: tr.steps / tr.outputs }) : controlDict(endTime),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolutionText(false),
    "constant/solverDict": solverDict(n, endTime),
    "0/T": temperatureField(n, start),
    "0/D": displacementField,
    // marks a transient for the run script (it then keeps the field at every write time); OpenFOAM ignores the file
    ...(tr ? { "feed-transient.json": JSON.stringify({ outputs: tr.outputs, steps: tr.steps, timeStep: tr.timeStep, endTime: tr.endTime }) + NL } : {}),
  };
  const names = ["kernel", ...n.layers.map((l) => l.name)];
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry", file: "system/blockMeshDict", note: `a 2 degree double wedge on the x axis, written from the vertex formulas of src/core/trisoWedge.ts (a level of radius r has its vertices at x = r cos(a)/s, y = r sin(a)/s, s = sqrt(1 + sin(a)^2), a = ${TRISO_WEDGE_HALF_ANGLE_DEG} degree), so every vertex lies on the sphere of radius r; one block per region (cell zones ${names.map((k) => TRISO_ZONE[k as keyof typeof TRISO_ZONE]).join(", ")}) in micrometres; the buffer's outer face and the next layer's inner face are the coupled patches ${TRISO_PATCHES.gapInner} and ${TRISO_PATCHES.gapOuter}, the outside is the patch ${TRISO_PATCHES.outer}; the wedge solves the sphere whose radii are ${TRISO_WEDGE_SCALE.toFixed(6)} of these` },
    { field: "geometry.kernelRadius", file: "system/blockMeshDict", note: "kernel block outer radius (um)" },
    ...n.layers.map((l) => ({ field: "geometry.layers." + l.name + ".thickness", file: "system/blockMeshDict", note: `block '${TRISO_ZONE[l.name]}' from ${(l.innerRadius * UM).toPrecision(8)} to ${(l.outerRadius * UM).toPrecision(8)} um` })),
    ...names.map((k, i) => ({ field: "mesh." + k + "Cells", file: "system/blockMeshDict", note: `${n.cells[i]} cells across the ${TRISO_ZONE[k as keyof typeof TRISO_ZONE]} block` })),
    tr
      ? { field: "transient.powerHistory", file: "constant/solverDict", note: `heatSource timeDependentVhgr, kernel only (materials ( Kernel )): the case's table of the heat per particle divided by the kernel's volume ${num(n.power.kernelVolume)} m3, ${tr.times.length} points, linear interpolation; one flat point is appended one step after the last, because the accumulated step time can land a few ulps past the last point and OFFBEAT aborts on a time outside its table` }
      : { field: "power", file: "constant/solverDict", note: `heatSource timeDependentVhgr, kernel only (materials ( Kernel )): ${num(n.power.kernelPowerDensity)} W/m3 (${num(n.power.particlePower)} W per particle); the table runs to twice the end time because OFFBEAT aborts when a table point equals the end time` },
    ...(tr
      ? [
          { field: "transient.timeStep, endTime, outputs", file: "system/controlDict", note: "fixed deltaT (adjustableTimeStep false), endTime, writeInterval = steps / outputs" },
          steadyStart
            ? { field: "transient.initialSteadyParticlePower", file: "0/T", note: "nonuniform internalField: the steady temperature of every cell at that power, from FEED's independent finite-volume solution of the wedge's sphere on this mesh (blockMesh order: kernel inner to outer, then each layer); the patches start from a uniform value near them" }
            : { field: "transient.initialTemperature", file: "0/T", note: "uniform internalField" },
          { field: "materials.* thermal.volumetricHeatCapacity", file: "constant/solverDict", note: "rho 10000 kg/m3 and Cp = c / rho (constant), steel1515TiBanerjee with par1 = a / rho, par2 = b / rho, par3 = 0 (linear c(T); the model name is a misnomer), or SiCSnead with par1..par3 = a, b, c over rho and par4 = 0 (quadratic c(T), all four written)" },
        ]
      : []),
    { field: "materials.kernel thermal.conductivity", file: "constant/solverDict", note: conductivityNote("kernel", n.kernelConductivity) },
    ...n.layers.map((l) => ({ field: "materials." + l.name + " thermal.conductivity", file: "constant/solverDict", note: conductivityNote(l.name, l.conductivity) })),
    { field: "gap.conductance", file: "0/T", note: `resistiveGap alpha on ${TRISO_PATCHES.gapInner} and ${TRISO_PATCHES.gapOuter}, no gas model (gapGas none, fgr none)` },
    { field: "boundary", file: "0/T", note: n.boundary.kind === "convective" ? "outer convectiveHTC (T0, h)" : "outer fixedValue" },
    ...(tr?.boundaryHistory ? [{ field: "transient.boundaryHistory", file: "0/T", note: "outer " + (tr.boundaryHistory.kind === "convective" ? "timeDependentAxialProfileHTC (hData, T0Data)" : "timeDependentAxialProfileT (timeDependentProfile.axialData)") + ", " + tr.boundaryHistory.times.length + " points, linear in time, two equal columns at the one height; the case's own boundary is the value before the first point. OFFBEAT applies the value of the end of each step. One flat point is appended beyond the end time when the last point is not strictly after it: OFFBEAT aborts on a time equal to its last point" }] : []),
    { field: "assumptions", file: "constant/solverDict", note: "mechanicsSolver fromLatestTime (no mechanics), burnup none, fastFlux none, fgr none, gapGas none" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    tr
      ? { name: "rho", value: "10000 kg/m3", why: "carrier for the volumetric heat capacity: the model wants rho and a mass-based Cp, and only their product rho Cp enters the heat equation" }
      : { name: "rho, Cp", value: "10000 kg/m3, 300 J/kg/K", why: "required by the constant material model; storage only, no effect on the steady result" },
    { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    steadyStart
      ? { name: "initial temperature field", value: "steady state at " + (tr!.initial as { particlePower: number }).particlePower + " W, " + Math.min(...steadyStart.T).toFixed(2) + " to " + steadyStart.peak.toFixed(2) + " K", why: "the transient starts from the steady operating state of this particle at the stated power (independent finite-volume solution of the wedge's sphere, same mesh)" }
      : { name: "initial temperature", value: String(t0) + " K", why: tr ? "the transient's initial temperature, as given" : "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: tr ? { wedgeHalfAngleDeg: TRISO_WEDGE_HALF_ANGLE_DEG, wedgeScale: TRISO_WEDGE_SCALE, endTime: tr.endTime, timeStep: tr.timeStep, steps: tr.steps, outputs: tr.outputs } : { wedgeHalfAngleDeg: TRISO_WEDGE_HALF_ANGLE_DEG, wedgeScale: TRISO_WEDGE_SCALE, endTime, minEndTime: MIN_STEADY_END_TIME } };
}
