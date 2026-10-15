// Plan 13, T1: the coated particle, a sphere of a kernel and two to four coating layers, thermal and steady. Ungated: the sphere's geometry kernel against formulas written out here and
// a numerical quadrature, the case (what it normalises to, by hand), its refusals one by one, the units it brought (micrometres, volumetric power), that nothing runs it yet and says so,
// and that the pin and the plate are untouched.
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { CYLINDER, SLAB, SPHERE } from "../src/core/geometry";
import { RunManager } from "../src/core/runManager";
import { PACKING_MAX, particleVolumes } from "../src/core/triso";
import { fromSI, toSI } from "../src/core/units";
import { unrunnableErrors, validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const q = (value: number, unit: string) => ({ value, unit });
const read = (f: string) => JSON.parse(readFileSync(join(root, f), "utf8"));
/** The vector the T1 gate uses: OpenMC Studio's illustrative dimensions (250 / 100 / 40 / 35 / 35 micrometres), constant conductivities 3, 0.5, 4, 13.9, 4 W/m/K, a wall at 1000 K. */
const particle = () => read("schema/vectors/good/triso-steady.json");
const norm = (d: unknown) => {
  const v = validateCase(d);
  expect(v.errors).toEqual([]);
  expect(v.normalized).toBeUndefined();
  return v.triso!;
};
const codes = (d: unknown) => validateCase(d).errors.map((e) => e.code + " " + e.field);
const PI = Math.PI;

describe("the sphere's geometry kernel", () => {
  const a = 250e-6;
  const b = 350e-6;
  const k = 0.5;
  it("has the area of a sphere and the volume of a shell", () => {
    expect(SPHERE.area(a)).toBeCloseTo(4 * PI * a * a, 18);
    expect(SPHERE.volume(a, b)).toBeCloseTo((4 / 3) * PI * (b ** 3 - a ** 3), 22);
    expect(SPHERE.volume(0, a)).toBeCloseTo((4 / 3) * PI * a ** 3, 22);
  });
  it("has the resistance of a shell, the integral of dr / (4 pi k r^2)", () => {
    // midpoint quadrature in the radius, written out here (no use of the kernel's own formula)
    const n = 20000;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const r = a + ((i + 0.5) * (b - a)) / n;
      sum += ((b - a) / n) / (4 * PI * k * r * r);
    }
    expect(Math.abs(SPHERE.resist(a, b, k) / sum - 1)).toBeLessThan(1e-9);
    expect(Math.abs(SPHERE.resist(a, b, k) / ((1 / a - 1 / b) / (4 * PI * k)) - 1)).toBeLessThan(1e-13);
  });
  it("has the conductance 1 / resist, and a shell's resistance adds in series: the resistance from a to c is the sum through b", () => {
    expect(SPHERE.conductance(a, b, k) * SPHERE.resist(a, b, k)).toBeCloseTo(1, 12);
    const c = 460e-6;
    expect(SPHERE.resist(a, c, k)).toBeCloseTo(SPHERE.resist(a, b, k) + SPHERE.resist(b, c, k), 9);
  });
  it("puts a shell's cell centre at the volume centroid, 3/4 (b^4 - a^4) / (b^3 - a^3), found here by quadrature of r over r^2", () => {
    const n = 20000;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      const r = a + ((i + 0.5) * (b - a)) / n;
      num += r * r * r;
      den += r * r;
    }
    expect(SPHERE.centroid(a, b)).toBeCloseTo(num / den, 12);
    // a kernel's first cell reaches 3/4 of its outer face (the mesh of docs/spike/triso-probe.md: 15.688 um for a cell of 20.917 um)
    expect(SPHERE.centroid(0, 20.917e-6)).toBeCloseTo(0.75 * 20.917e-6, 12);
  });
  it("is the third geometry and changes neither of the other two", () => {
    expect(SPHERE.sphere).toBe(true);
    expect(CYLINDER.sphere).toBe(false);
    expect(SLAB.sphere).toBe(false);
    expect(CYLINDER.area(2)).toBe(2 * PI * 2);
    expect(SLAB.area(2)).toBe(1);
  });
});

describe("the units a particle brought", () => {
  it("reads micrometres written with an ASCII u or the micro sign, and a volumetric power in W/m3, kW/m3, MW/m3 and W/cm3", () => {
    expect(toSI(q(250, "um"), "length")).toEqual({ ok: true, si: 250e-6 });
    expect(toSI(q(250, "µm"), "length")).toEqual({ ok: true, si: 250e-6 });
    expect(toSI(q(3e9, "W/m3"), "powerDensity")).toEqual({ ok: true, si: 3e9 });
    expect(toSI(q(2, "kW/m3"), "powerDensity")).toEqual({ ok: true, si: 2e3 });
    expect(toSI(q(600, "MW/m3"), "powerDensity")).toEqual({ ok: true, si: 6e8 });
    expect(toSI(q(10, "W/cm3"), "powerDensity")).toEqual({ ok: true, si: 1e7 });
    expect(fromSI(1e7, "W/cm3", "powerDensity")).toBe(10);
  });
  it("refuses a power density in a unit of another dimension, and a length in W/cm3", () => {
    expect(toSI(q(10, "W/m"), "powerDensity").ok).toBe(false);
    expect(toSI(q(10, "W/cm3"), "length").ok).toBe(false);
  });
});

describe("the particle case", () => {
  it("is valid, has no pin form, and normalises to the radii, the volumes and the power worked out by hand", () => {
    const n = norm(particle());
    expect(n.kernelRadius).toBeCloseTo(250e-6, 15);
    expect(n.layers.map((l) => l.name)).toEqual(["buffer", "ipyc", "sic", "opyc"]);
    // the layers lie one on the other: 250, 350, 390, 425, 460 micrometres
    expect(n.layers.map((l) => l.innerRadius * 1e6)).toEqual([250, 350, 390, 425].map((x) => expect.closeTo(x, 9)));
    expect(n.layers.map((l) => l.outerRadius * 1e6)).toEqual([350, 390, 425, 460].map((x) => expect.closeTo(x, 9)));
    expect(n.outerRadius).toBeCloseTo(460e-6, 15);
    expect(n.cells).toEqual([12, 12, 12, 16, 12]);
    expect(n.gapConductance).toBe(1.5e5);
    expect(n.boundary).toEqual({ kind: "surface-temperature", surfaceTemperature: 1000 });
    // the volumes: 4/3 pi r^3 of 250 and of 460 micrometres (15.625e-12 x 4.18879 = 6.5450e-11; 97.336e-12 x 4.18879 = 4.0772e-10)
    expect(n.power.kernelVolume).toBeCloseTo(6.5449847e-11, 17);
    expect(n.power.particleVolume).toBeCloseTo(4.0772008e-10, 16);
    // 600 MW/m3 in the kernel is 0.039270 W per particle
    expect(n.power.kernelPowerDensity).toBeCloseTo(6e8, 0);
    expect(n.power.particlePower).toBeCloseTo(6e8 * 6.5449847e-11, 9);
    expect(n.power.particlePower).toBeCloseTo(0.0392699, 7);
    expect(n.power.form).toBe("kernel-density");
  });
  it("gives the same particle for a power per particle as for the kernel density it implies", () => {
    const a = norm(particle());
    const d = particle();
    d.power = { particlePower: q(a.power.particlePower, "W") };
    const b = norm(d);
    expect(b.power.form).toBe("particle");
    expect(b.power.kernelPowerDensity).toBeCloseTo(6e8, 0);
    expect(b.power.particlePower).toBeCloseTo(a.power.particlePower, 15);
  });
  it("turns a compact's power density and packing fraction into a power per particle: each particle carries the density times its own volume over the packing fraction", () => {
    const d = particle();
    d.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(35, "%") };
    const n = norm(d);
    // 1e7 W/m3 x 4.0772e-10 m3 / 0.35 = 0.011649 W; the compact holds 0.35 / 4.0772e-10 = 8.584e8 particles per m3, and 8.584e8 x 0.011649 = 1e7 again
    const vParticle = (4 / 3) * PI * 460e-6 ** 3;
    expect(n.power.form).toBe("compact");
    expect(n.power.particlePower).toBeCloseTo((1e7 * vParticle) / 0.35, 12);
    expect(n.power.particlePower).toBeCloseTo(0.011649, 6);
    expect((0.35 / vParticle) * n.power.particlePower).toBeCloseTo(1e7, 0);
    expect(n.power.compact!.powerDensity).toBe(1e7);
    expect(n.power.compact!.packingFraction).toBeCloseTo(0.35, 15);
    // the kernel's power density follows: 0.011649 W in 6.5450e-11 m3
    expect(n.power.kernelPowerDensity).toBeCloseTo(n.power.particlePower / 6.5449847e-11, 0);
  });
  it("reads the same lengths in micrometres, in the micro sign and in millimetres", () => {
    const um = norm(particle());
    const d = particle();
    d.geometry.kernelRadius = q(0.25, "mm");
    d.geometry.layers[0].thickness = q(0.1, "mm");
    d.geometry.layers[1].thickness = q(40, "µm");
    const mm = norm(d);
    expect(mm.outerRadius).toBeCloseTo(um.outerRadius, 14);
    expect(mm.layers.map((l) => l.outerRadius)).toEqual(um.layers.map((l) => expect.closeTo(l.outerRadius, 14)));
  });
  it("has a bare two-layer particle (a buffer and an inner carbon) with only its own materials and cells", () => {
    const d = read("schema/vectors/good/triso-two-layers.json");
    const n = norm(d);
    expect(n.layers.map((l) => l.name)).toEqual(["buffer", "ipyc"]);
    expect(n.outerRadius).toBeCloseTo(390e-6, 15);
    expect(n.cells).toEqual([12, 12, 12]);
  });
  it("takes a convective outside as a pin does", () => {
    const n = norm(read("schema/vectors/good/triso-convective-outside.json"));
    expect(n.boundary).toEqual({ kind: "convective", bulkTemperature: 900, heatTransferCoefficient: 2000 });
  });
  it("keeps the volumes helper and the case's volumes the same", () => {
    const n = norm(particle());
    const v = particleVolumes(n.kernelRadius, n.outerRadius);
    expect(n.power.kernelVolume).toBe(v.kernelVolume);
    expect(n.power.particleVolume).toBe(v.particleVolume);
  });
});

describe("what the particle case refuses", () => {
  it("names the one fault of a power given in two forms, in none, or as a pin's linear heat rate", () => {
    const two = particle();
    two.power.particlePower = q(0.04, "W");
    expect(codes(two)).toEqual(["E_SCHEMA_INVALID /power"]);
    const none = particle();
    none.power = {};
    expect(codes(none)).toEqual(["E_SCHEMA_INVALID /power"]);
    const lin = particle();
    lin.power = { linearHeatRate: q(20, "kW/m") };
    expect(codes(lin)).toEqual(["E_UNSUPPORTED /power/linearHeatRate"]);
  });
  it("refuses a packing fraction that does nothing, one that is missing, zero, and one above the densest packing of spheres", () => {
    const d = particle();
    d.power.packingFraction = q(0.35, "1");
    expect(codes(d)).toEqual(["E_UNSUPPORTED /power/packingFraction"]);
    const c = particle();
    c.power = { compactPowerDensity: q(10, "W/cm3") };
    expect(codes(c)).toEqual(["E_PROP_MISSING /power/packingFraction"]);
    for (const [pf, code] of [[0, "E_OUT_OF_RANGE"], [0.7406, "E_OUT_OF_RANGE"], [0.9, "E_OUT_OF_RANGE"]] as const) {
      const e = particle();
      e.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(pf, "1") };
      expect(codes(e)).toEqual([code + " /power/packingFraction"]);
    }
    expect(PACKING_MAX).toBeCloseTo(0.74048, 5);
    // just below the densest packing is accepted, with the random-packing warning
    const ok = particle();
    ok.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(0.74, "1") };
    const v = validateCase(ok);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.code)).toEqual(["W_PACKING_FRACTION"]);
  });
  it("warns, and does not refuse, a packing fraction above random close packing, a gap in contact and a very high kernel power", () => {
    const pf = particle();
    pf.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(0.65, "1") };
    expect(validateCase(pf).warnings.map((w) => w.code)).toEqual(["W_PACKING_FRACTION"]);
    const below = particle();
    below.power = { compactPowerDensity: q(10, "W/cm3"), packingFraction: q(0.64, "1") };
    expect(validateCase(below).warnings).toEqual([]);
    const gap = particle();
    gap.gap.conductance = q(3.1e5, "W/m2/K");
    expect(validateCase(gap).warnings.map((w) => w.code)).toEqual(["W_GAP_CONTACT"]);
    gap.gap.conductance = q(3e5, "W/m2/K");
    expect(validateCase(gap).warnings).toEqual([]);
    const hot = particle();
    hot.power = { kernelPowerDensity: q(1.01e10, "W/m3") };
    expect(validateCase(hot).warnings.map((w) => w.code)).toEqual(["W_POWER_RANGE"]);
    hot.power = { kernelPowerDensity: q(1e10, "W/m3") };
    expect(validateCase(hot).warnings).toEqual([]);
  });
  it("refuses layers out of their order, too few and too many, an unknown key and a missing thickness", () => {
    const rev = particle();
    rev.geometry.layers.reverse();
    expect(codes(rev)).toEqual(expect.arrayContaining(["E_GEOMETRY /geometry/layers/0/name"]));
    expect(codes(rev).every((c) => c.startsWith("E_GEOMETRY"))).toBe(true);
    const one = particle();
    one.geometry.layers = one.geometry.layers.slice(0, 1);
    expect(codes(one)).toEqual(["E_GEOMETRY /geometry/layers"]);
    const five = particle();
    five.geometry.layers.push({ name: "opyc", thickness: q(10, "um") });
    expect(codes(five)).toEqual(["E_GEOMETRY /geometry/layers"]);
    const key = particle();
    key.geometry.layers[2].density = 3.2;
    expect(codes(key)).toEqual(["E_GEOMETRY /geometry/layers/2/density"]);
    const thin = particle();
    delete thin.geometry.layers[1].thickness;
    expect(codes(thin)).toEqual(["E_SCHEMA_INVALID /geometry/layers/1/thickness"]);
    const notList = particle();
    notList.geometry.layers = { buffer: q(100, "um") };
    expect(codes(notList)).toEqual(["E_SCHEMA_INVALID /geometry/layers"]);
  });
  it("refuses a pin's or a plate's keys in the particle's geometry, a missing kernel radius, and a length that is zero, negative, in a wrong unit or out of range", () => {
    for (const key of ["fuelRadius", "claddingInnerRadius", "claddingOuterRadius", "fuelInnerRadius", "fuelHalfThickness", "gapThickness", "claddingThickness"]) {
      const d = particle();
      d.geometry[key] = q(1, "mm");
      expect(codes(d)).toEqual(["E_GEOMETRY /geometry/" + key]);
    }
    const nr = particle();
    delete nr.geometry.kernelRadius;
    expect(codes(nr)).toEqual(["E_SCHEMA_INVALID /geometry/kernelRadius"]);
    for (const [v, code] of [[q(0, "um"), "E_GEOMETRY"], [q(-5, "um"), "E_GEOMETRY"], [q(5, "W"), "E_UNITS"], [q(2e9, "um"), "E_GEOMETRY"], [q(1e-4, "um"), "E_GEOMETRY"], [250, "E_UNITS"]] as const) {
      const d = particle();
      d.geometry.kernelRadius = v;
      expect(codes(d)).toEqual([code + " /geometry/kernelRadius"]);
    }
  });
  it("refuses a material for a region the particle does not have, a missing one, one without a conductivity, and the burnup law", () => {
    const fuel = particle();
    fuel.materials.fuel = fuel.materials.kernel;
    expect(codes(fuel)).toEqual(["E_GEOMETRY /materials/fuel"]);
    const absent = read("schema/vectors/good/triso-two-layers.json");
    absent.materials.sic = particle().materials.sic;
    expect(codes(absent)).toEqual(["E_GEOMETRY /materials/sic"]);
    const missing = particle();
    delete missing.materials.ipyc;
    expect(codes(missing)).toEqual(["E_SCHEMA_INVALID /materials/ipyc"]);
    const noKernel = particle();
    delete noKernel.materials.kernel;
    expect(codes(noKernel)).toEqual(["E_SCHEMA_INVALID /materials/kernel"]);
    const noK = particle();
    delete noK.materials.sic.sets["thermal.conductivity"];
    expect(codes(noK)).toEqual(["E_PROP_MISSING /materials/sic/sets/thermal.conductivity"]);
    const nfi = particle();
    nfi.materials.kernel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: q(95, "%"), source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 (FRAPCON-3.4 modified NFI)" };
    expect(codes(nfi)).toEqual(["E_UNSUPPORTED /materials/kernel/sets/thermal.conductivity/model"]);
  });
  it("refuses every pin section that has no meaning for a particle, each by its own name", () => {
    for (const [key, value] of [["mechanics", {}], ["hotDimensions", {}], ["burnup", {}], ["axial", {}], ["limits", [{ name: "a" }]]] as const) {
      const d = particle();
      d[key] = value;
      const c = codes(d);
      expect(c).toContain("E_UNSUPPORTED /" + key);
    }
    const tr = particle();
    tr.assumptions.steadyState = false;
    expect(codes(tr)).toEqual(["E_UNSUPPORTED /assumptions/steadyState"]);
    const th = particle();
    th.assumptions.thermalOnly = false;
    expect(codes(th)).toEqual(["E_UNSUPPORTED /assumptions/thermalOnly"]);
    const geo = particle();
    geo.assumptions.geometry = "1D-radial";
    expect(codes(geo)).toEqual(["E_UNSUPPORTED /assumptions/geometry"]);
    const sec = particle();
    sec.transient = { endTime: q(1, "s") };
    expect(codes(sec)).toContain("E_UNSUPPORTED /transient");
  });
  it("refuses a closed gap, a missing gap source and boundaries that are missing, in two forms or incomplete, as a pin does", () => {
    const closed = particle();
    closed.gap = { model: "closed" };
    expect(codes(closed)).toEqual(["E_UNSUPPORTED /gap/model"]);
    const src = particle();
    delete src.gap.source;
    expect(codes(src)).toEqual(["E_PROP_MISSING /gap/source"]);
    const none = particle();
    none.boundary = {};
    expect(codes(none)).toEqual(["E_BOUNDARY_INCOMPLETE /boundary"]);
    const two = particle();
    two.boundary = { surfaceTemperature: q(1000, "K"), bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") };
    expect(codes(two)).toEqual(["E_BOUNDARY_INCOMPLETE /boundary"]);
    const half = particle();
    half.boundary = { bulkTemperature: q(900, "K") };
    expect(codes(half)).toEqual(["E_BOUNDARY_INCOMPLETE /boundary/heatTransferCoefficient"]);
  });
  it("refuses a mesh with a missing, unknown, fractional, too small or too large count, naming the region", () => {
    const low = particle();
    low.mesh.kernelCells = 3;
    expect(codes(low)).toEqual(["E_MESH /mesh/kernelCells"]);
    low.mesh.kernelCells = 4;
    expect(validateCase(low).ok).toBe(true);
    const layerLow = particle();
    layerLow.mesh.ipycCells = 1;
    expect(codes(layerLow)).toEqual(["E_MESH /mesh/ipycCells"]);
    const high = particle();
    high.mesh.sicCells = 10001;
    expect(codes(high)).toEqual(["E_MESH /mesh/sicCells"]);
    const miss = particle();
    delete miss.mesh.opycCells;
    expect(codes(miss)).toEqual(["E_SCHEMA_INVALID /mesh/opycCells"]);
    const pin = particle();
    pin.mesh.fuelCells = 20;
    expect(codes(pin)).toEqual(["E_SCHEMA_INVALID /mesh/fuelCells"]);
    const frac = particle();
    frac.mesh.kernelCells = 12.5;
    expect(validateCase(frac).ok).toBe(false);
  });
  it("reports every fault of a case with several, not only the first", () => {
    const d = particle();
    d.power = {};
    d.gap = { model: "closed" };
    d.boundary = {};
    d.mesh.kernelCells = 1;
    const c = codes(d);
    expect(c).toEqual(expect.arrayContaining(["E_SCHEMA_INVALID /power", "E_UNSUPPORTED /gap/model", "E_BOUNDARY_INCOMPLETE /boundary", "E_MESH /mesh/kernelCells"]));
  });
});

describe("nothing runs a particle yet, and every entry says so", () => {
  it("answers a valid particle with the statement that it cannot be run, never with an empty list of problems", () => {
    const v = validateCase(particle());
    expect(v.ok).toBe(true);
    const e = unrunnableErrors(v);
    expect(e).toHaveLength(1);
    expect(e[0]!.code).toBe("E_UNSUPPORTED");
    expect(e[0]!.message).toContain("plan 13");
    // an invalid case keeps its own errors, and a pin has none to give
    const bad = particle();
    bad.power = {};
    const vb = validateCase(bad);
    expect(unrunnableErrors(vb)).toEqual(vb.errors);
  });
  it("is refused by the editor's check and by the run manager with that statement", () => {
    const r = check(particle()) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(["E_UNSUPPORTED"]);
    const runsRoot = mkdtempSync(join(tmpdir(), "feed-triso-"));
    try {
      const mgr = new RunManager({ runsRoot, backend: { start: () => { throw new Error("the solver must not be started"); } } as never });
      const s = mgr.start(particle());
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.errors.map((e) => e.code)).toEqual(["E_UNSUPPORTED"]);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
});

describe("the pin and the plate are untouched", () => {
  it("normalises the synthetic pin as before, with no particle form", () => {
    const v = validateCase(read("examples/synthetic-pin.json"));
    expect(v.ok).toBe(true);
    expect(v.triso).toBeUndefined();
    expect(v.normalized!.plate).toBeUndefined();
    expect(v.normalized!.fuelRadius).toBeCloseTo(4.1e-3, 15);
  });
  it("still refuses a pin without its fuel material or its cladding mesh, at the field, now that the schema leaves them optional", () => {
    const a = read("examples/synthetic-pin.json");
    delete a.materials.cladding;
    expect(codes(a)).toEqual(["E_SCHEMA_INVALID /materials/cladding"]);
    const b = read("examples/synthetic-pin.json");
    delete b.mesh.fuelCells;
    delete b.mesh.claddingCells;
    expect(codes(b)).toEqual(["E_SCHEMA_INVALID /mesh/fuelCells", "E_SCHEMA_INVALID /mesh/claddingCells"]);
  });
  it("says a geometry kind that is none of the three is refused, naming the three", () => {
    const d = read("examples/synthetic-pin.json");
    d.geometry.kind = "disc";
    const e = validateCase(d).errors.find((x) => x.field === "/geometry/kind")!;
    expect(e.code).toBe("E_GEOMETRY");
    expect(e.message).toContain("'triso'");
  });
});
