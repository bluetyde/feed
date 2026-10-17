// The OFFBEAT case of a pebble (plan 13, T4): a thermal-only, steady sphere of two regions on the same 2 degree double wedge as the coated particle (src/core/trisoWedge.ts, the
// vertex formulas; nothing is copied from OFFBEAT). The particle writer's way of treating the kernel is kept: the fuelled zone is the cell zone `Kernel`, which alone carries the
// heat source (timeDependentVhgr, materials ( Kernel )); the shell is a second zone, `Shell`. Unlike a particle there is no gap, so the two blocks share their vertices and the
// only patches are the wedge planes and the outside.

import { conductivityNote, constantMaterial, controlDict, FOAM_HEADER, fvSchemes, fvSolutionText, num, WrittenCase } from "./caseWriter";
import type { NormalizedPebble } from "./pebble";
import { pebbleSteadyEndTime } from "./pebble";
import { level, UM } from "./trisoWriter";
import { TRISO_WEDGE_HALF_ANGLE_DEG, TRISO_WEDGE_SCALE } from "./trisoWedge";

export const PEBBLE_ZONE = { fuelled: "Kernel", shell: "Shell" } as const;
export const PEBBLE_PATCH = { outer: "outer" } as const;

/** The mesh: levels at radius 0, the fuelled radius and the outer radius; one block between neighbouring levels. */
export function pebbleBlockMeshDict(p: NormalizedPebble): string {
  const radii = [0, p.fuelledRadius, p.outerRadius];
  const verts = radii.flatMap((r) => level(r * UM));
  const vtx = verts.map((v) => `    (${v.map((x) => num(x)).join(" ")})`).join("\n");
  const names = [PEBBLE_ZONE.fuelled, PEBBLE_ZONE.shell];
  const blocks = names.map((nm, j) => `    hex ( ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => j * 4 + i).join(" ")} ) ${nm} (1 1 ${p.cells[j]}) simpleGrading (1 1 1)`).join("\n");
  const face = (b: number, ...i: number[]) => `            (${i.map((k) => b + k).join(" ")})`;
  const patch = (name: string, type: string, faces: string) => `    ${name}\n    {\n        type ${type};\n        faces\n        (\n${faces}\n        );\n    }\n`;
  const sides = (a: number, b: number, c: number, d: number) => names.map((_, j) => face(j * 4, a, b, c, d)).join("\n");
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
${patch(PEBBLE_PATCH.outer, "patch", face(4, 4, 5, 6, 7))}
);

mergePatchPairs
(
);
`;
}

function solverDict(p: NormalizedPebble, endTime: number): string {
  const q = p.power.powerDensity;
  const materials = [constantMaterial(PEBBLE_ZONE.fuelled, p.fuelledConductivity), constantMaterial(PEBBLE_ZONE.shell, p.shellConductivity)].join("\n");
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
    timePoints  (0 ${num(2 * endTime)});
    vhgr        (${num(q)} ${num(q)});
    timeInterpolationMethod linear;
    materials ( ${PEBBLE_ZONE.fuelled} );
}

materials
{
${materials}}
`;
}

const outerBoundary = (p: NormalizedPebble, start: number): string =>
  p.boundary.kind === "convective"
    ? `type convectiveHTC;\n        T0 uniform ${num(p.boundary.bulkTemperature)};\n        h uniform ${num(p.boundary.heatTransferCoefficient)};\n        value uniform ${num(start)};`
    : `type fixedValue;\n        value uniform ${num(p.boundary.surfaceTemperature)};`;

/** The OFFBEAT case of a pebble: mesh, dictionaries, fields; a steady run to the pebble's own end time. Throws when the pebble cannot settle (the validator refuses such a case first). */
export function writePebbleCase(p: NormalizedPebble): WrittenCase {
  const h = pebbleSteadyEndTime(p);
  if (!h.ok) throw new Error("cannot write a steady pebble case: " + h.message);
  const endTime = h.endTime;
  const t0 = p.boundary.kind === "convective" ? p.boundary.bulkTemperature : p.boundary.surfaceTemperature;
  const files: Record<string, string> = {
    "system/blockMeshDict": pebbleBlockMeshDict(p),
    "system/controlDict": controlDict(endTime),
    "system/fvSchemes": fvSchemes,
    "system/fvSolution": fvSolutionText(false),
    "constant/solverDict": solverDict(p, endTime),
    "0/T": `${FOAM_HEADER("volScalarField", "T")}
dimensions      [0 0 0 1 0 0 0];

internalField   uniform ${num(t0)};

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
        value           $internalField;
    }
    ${PEBBLE_PATCH.outer}
    {
        ${outerBoundary(p, t0)}
    }
}
`,
    "0/D": `${FOAM_HEADER("volVectorField", "D")}
dimensions          [0 1 0 0 0 0 0];

internalField       uniform (0 0 0);

boundaryField
{
    "top|bottom|front|back"
    {
        type            wedge;
    }
    ${PEBBLE_PATCH.outer}
    {
        type            fixedValue;
        value           uniform (0 0 0);
    }
}
`,
  };
  const mapping: WrittenCase["mapping"] = [
    { field: "geometry", file: "system/blockMeshDict", note: `the particle's 2 degree double wedge (vertex formulas of src/core/trisoWedge.ts, a = ${TRISO_WEDGE_HALF_ANGLE_DEG} degree) with two blocks, the fuelled zone (cell zone ${PEBBLE_ZONE.fuelled}) and the shell (${PEBBLE_ZONE.shell}), in micrometres, sharing their vertices (no gap); the outside is the patch ${PEBBLE_PATCH.outer}; the wedge solves the sphere whose radii are ${TRISO_WEDGE_SCALE.toFixed(6)} of these` },
    { field: "mesh.fuelledCells, mesh.shellCells", file: "system/blockMeshDict", note: `${p.cells[0]} cells across the fuelled zone and ${p.cells[1]} across the shell` },
    { field: "compact.powerDensity", file: "constant/solverDict", note: `heatSource timeDependentVhgr, fuelled zone only (materials ( ${PEBBLE_ZONE.fuelled} )): ${num(p.power.powerDensity)} W/m3 (${num(p.power.fuelledPower)} W in the fuelled zone); the table runs to twice the end time because OFFBEAT aborts when a table point equals the end time` },
    { field: "compact (mixture)", file: "constant/solverDict", note: conductivityNote("fuelled zone", p.fuelledConductivity) },
    { field: "materials.shell thermal.conductivity", file: "constant/solverDict", note: conductivityNote("shell", p.shellConductivity) },
    { field: "boundary", file: "0/T", note: p.boundary.kind === "convective" ? "outer convectiveHTC (T0, h)" : "outer fixedValue" },
    { field: "assumptions", file: "constant/solverDict", note: "mechanicsSolver fromLatestTime (no mechanics), burnup none, fastFlux none, fgr none, gapGas none" },
  ];
  const placeholders: WrittenCase["placeholders"] = [
    { name: "rho, Cp", value: "10000 kg/m3, 300 J/kg/K", why: "required by the constant material model; storage only, no effect on the steady result" },
    { name: "emissivity, E, nu, G, alpha, Tref", value: "0.8, 2e11, 0.3, 7.69e10, 1e-5, 300", why: "required by the constant material model; unused with mechanics off" },
    { name: "initial temperature", value: String(t0) + " K", why: "starting field; the steady result does not depend on it" },
  ];
  return { files, mapping, placeholders, choices: { wedgeHalfAngleDeg: TRISO_WEDGE_HALF_ANGLE_DEG, wedgeScale: TRISO_WEDGE_SCALE, endTime } };
}
