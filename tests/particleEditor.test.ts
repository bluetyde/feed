// Plan 13, T5: the editor for a coated particle. The page itself was driven in the browser pane (see the plan record); here: what the check response gives the page, the page's own pure
// helpers run without a page (the starting case, the layer table, the analysis and power forms, the explorer's items, the numbers the results view shows) against the validator and the
// saved real OFFBEAT output, and the page's wiring.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { TRISO_PROFILE_POINTS, trisoProfile } from "../src/core/trisoProfile";
import { trisoClosedForm } from "../src/core/trisoSolve";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const html = readFileSync(join(root, "src/web/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
const vector = (name: string) => JSON.parse(readFileSync(join(root, "schema/vectors/good", name + ".json"), "utf8"));
const golden = (dir: string, name: string, file: string) => JSON.parse(readFileSync(join(root, "tests/golden", dir, name, file), "utf8"));
const q = (value: number, unit: string) => ({ value, unit });

/** The page's pure particle helpers (between the markers), run against a document and a log the test owns. */
function pure(doc: any) {
  const block = script.slice(script.indexOf("/* particle-pure:begin"), script.indexOf("/* particle-pure:end */"));
  expect(block.length).toBeGreaterThan(1000);
  const state = { logText: "" };
  const names = ["isParticle", "particleTransient", "defaultParticle", "particleRegions", "particleItems", "particleFallbackItem", "particleAddLayer", "particleRemoveLayer", "defaultParticleTransient", "particleAnalysis", "particleInitial", "particlePowerForm", "setParticlePowerForm", "particleRadii", "tempInRegion", "particleRegionRows", "particleRegionPeaks", "limitLines", "particleEnergy", "PARTICLE_TEXT", "PARTICLE_LABEL", "PARTICLE_LAYER_NAMES"];
  const make = new Function("doc", "state", "let logText = state.logText; " + block + "; return { " + names.join(", ") + ", log: () => logText };");
  return make(doc, state) as Record<string, any>;
}
const fresh = () => { const h = pure(null); return h.defaultParticle(); };
const errorsOf = (d: any) => validateCase(d).errors.map((e) => e.code + " " + e.field);

describe("the check response for a particle", () => {
  it("carries the closed-form profile of every region beside the quick look and the derived numbers, and a pin carries none of it", () => {
    const r: any = check(fresh());
    expect(r.ok).toBe(true);
    expect(Object.keys(r.triso).sort()).toEqual(["derived", "normalized", "profile", "quick"]);
    const p = r.triso.profile;
    expect(p).toHaveLength(TRISO_PROFILE_POINTS.kernel + 4 * TRISO_PROFILE_POINTS.layer);
    expect(p[0].r).toBe(0);
    expect(p[p.length - 1].r).toBeCloseTo(r.triso.normalized.outerRadius, 15);
    expect(p.map((x: any) => x.region).filter((x: string, i: number, a: string[]) => a.indexOf(x) === i)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    const read: any = check(JSON.parse(readFileSync(join(root, "examples/synthetic-pin.json"), "utf8")));
    expect(read.triso).toBeUndefined();
    expect(read.normalized).toBeTruthy();
  });
  it("is the closed form: each region's first and last point are the quick look's inner and outer face, the gap is a jump of its drop, and the centre is the quick look's centre", () => {
    const r: any = check(fresh());
    const p: { r: number; T: number; region: string }[] = r.triso.profile, cl = r.triso.quick.closed;
    for (const g of cl.regions) {
      const mine = p.filter((x) => x.region === g.name);
      expect(mine[0]!.r).toBeCloseTo(g.innerRadius, 15);
      expect(mine[mine.length - 1]!.r).toBeCloseTo(g.outerRadius, 15);
      expect(mine[0]!.T).toBeCloseTo(g.innerT, 5);
      expect(mine[mine.length - 1]!.T).toBeCloseTo(g.outerT, 5);
    }
    expect(p[0]!.T).toBeCloseTo(cl.centreT, 6);
    const buf = p.filter((x) => x.region === "buffer"), ip = p.filter((x) => x.region === "ipyc");
    expect(buf[buf.length - 1]!.T - ip[0]!.T).toBeCloseTo(cl.gapDeltaT, 5);
    expect(cl.gapDeltaT).toBeGreaterThan(0.1); // a jump of the gap itself (0.17 K at the starting power), not a numerical wiggle
    // inside a region the temperature falls outward (the heat flows out), by the closed form of the layered sphere
    for (let i = 1; i < p.length; i++) if (p[i]!.region === p[i - 1]!.region) expect(p[i]!.T).toBeLessThanOrEqual(p[i - 1]!.T + 1e-9);
  });
  it("a layer's profile is the 1/r curve of the layer's own conductivity, checked at the middle against arithmetic written here", () => {
    const d = fresh();
    const n = validateCase(d).triso!;
    const buf = n.layers[0]!, P = n.power.particlePower, rm = (buf.innerRadius + buf.outerRadius) / 2;
    const prof = trisoProfile(n);
    const mid = prof.filter((x) => x.region === "buffer")[(TRISO_PROFILE_POINTS.layer - 1) / 2]!;
    expect(mid.r).toBeCloseTo(rm, 14);
    // constant k = 0.5: T(r) = T(outer) + P / (4 pi k) (1/r - 1/outer)
    const Tout = trisoClosedForm(n).regions[1]!.outerT;
    expect(mid.T).toBeCloseTo(Tout + (P / (4 * Math.PI * 0.5)) * (1 / rm - 1 / buf.outerRadius), 6);
  });
  it("carries the power table and the outside's table of a transient particle for the plots", () => {
    const d = fresh(), h = pure(d);
    h.particleAnalysis("transient");
    d.boundary = { bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") };
    d.transient.initialTemperature = q(900, "K");
    d.transient.boundaryHistory = [{ time: q(0, "ms"), bulkTemperature: q(900, "K"), heatTransferCoefficient: q(2000, "W/m2/K") }, { time: q(500, "ms"), bulkTemperature: q(1000, "K"), heatTransferCoefficient: q(2000, "W/m2/K") }];
    const r: any = check(d);
    expect(r.errors).toEqual([]);
    expect(r.triso.normalized.transient.particlePower.length).toBe(4);
    expect(r.triso.normalized.transient.boundaryHistory.kind).toBe("convective");
    expect(r.triso.profile.length).toBeGreaterThan(100);
  });
  it("answers an invalid particle with the validator's error at the field the page shows it on, one fault at a time, and no profile", () => {
    const fault = (edit: (d: any) => void) => { const d = fresh(); edit(d); const r: any = check(d); expect(r.ok).toBe(false); expect(r.triso).toBeUndefined(); return r.errors.map((e: any) => e.code + " " + e.field); };
    expect(fault((d) => { d.geometry.layers[1].thickness = q(-1, "um"); })).toContain("E_GEOMETRY /geometry/layers/1/thickness");
    expect(fault((d) => { d.mesh.kernelCells = 2; })).toContain("E_MESH /mesh/kernelCells");
    expect(fault((d) => { d.materials.sic.sets["thermal.conductivity"].source = ""; })).toEqual(expect.arrayContaining([expect.stringMatching(/\/materials\/sic\/sets\/thermal\.conductivity/)]));
    expect(fault((d) => { d.power = { compactPowerDensity: q(100, "MW/m3") }; })).toContain("E_PROP_MISSING /power/packingFraction");
    expect(fault((d) => { d.limits = [{ name: "x", region: "kernel", maxTemperature: q(1500, "K"), source: "" }]; })).toContain("E_PROP_MISSING /limits/0/source");
  });
});

describe("the page's particle helpers, run without a page", () => {
  it("starts from the content of the good vector: valid, the same geometry, power, boundary, materials, gap and mesh", () => {
    const d = fresh(), v = vector("triso-steady");
    expect(errorsOf(d)).toEqual([]);
    expect(validateCase(d).triso).toBeTruthy();
    for (const k of ["assumptions", "geometry", "power", "boundary", "materials", "gap", "mesh"]) expect(d[k], k).toEqual(v[k]);
    expect(d.schema).toBe(v.schema);
  });
  it("adds and removes the outermost layer with its material and its mesh key, keeps the order, refuses past two and four, and the case stays valid", () => {
    const d = fresh(), h = pure(d);
    const consistent = () => {
      const names = d.geometry.layers.map((l: any) => l.name);
      expect(names).toEqual(h.PARTICLE_LAYER_NAMES.slice(0, names.length));
      expect(Object.keys(d.materials).sort()).toEqual(["kernel", ...names].sort());
      expect(Object.keys(d.mesh).sort()).toEqual(["kernelCells", ...names.map((n: string) => n + "Cells")].sort());
      expect(errorsOf(d)).toEqual([]);
    };
    consistent();
    expect(h.particleAddLayer()).toBe(false); // four is the most
    expect(h.particleRemoveLayer()).toBe("opyc");
    expect(d.materials.opyc).toBeUndefined();
    expect(d.mesh.opycCells).toBeUndefined();
    consistent();
    expect(h.particleRemoveLayer()).toBe("sic");
    consistent();
    expect(d.geometry.layers).toHaveLength(2);
    expect(h.particleRemoveLayer()).toBe(false); // two is the least
    expect(d.geometry.layers).toHaveLength(2);
    consistent();
    expect(h.particleAddLayer()).toBe(true);
    expect(d.geometry.layers[2]).toEqual({ name: "sic", thickness: q(35, "um") });
    expect(d.mesh.sicCells).toBe(16);
    consistent();
    expect(h.particleAddLayer()).toBe(true);
    expect(d.geometry.layers[3].name).toBe("opyc");
    consistent();
    expect(h.log()).toContain("Removed the opyc layer");
  });
  it("drops the limits on a removed layer, and a transient's layer gets a heat capacity", () => {
    const d = fresh(), h = pure(d);
    d.limits = [{ name: "kernel", region: "kernel", maxTemperature: q(1500, "K"), source: "s" }, { name: "outer carbon", region: "opyc", maxTemperature: q(1500, "K"), source: "s" }];
    expect(errorsOf(d)).toEqual([]);
    h.particleRemoveLayer();
    expect(d.limits).toHaveLength(1);
    expect(errorsOf(d)).toEqual([]);
    expect(h.log()).toContain("1 limit on it");
    d.limits = [{ name: "outer carbon", region: "sic", maxTemperature: q(1500, "K"), source: "s" }];
    h.particleRemoveLayer();
    expect(d.limits).toBeUndefined();
    expect(errorsOf(d)).toEqual([]);
    expect(d.geometry.layers).toHaveLength(2);
    h.particleAnalysis("transient");
    expect(h.particleAddLayer()).toBe(true);
    expect(d.materials.sic.sets["thermal.volumetricHeatCapacity"]).toBeTruthy();
    expect(errorsOf(d)).toEqual([]);
    h.particleAnalysis("steady");
    h.particleAddLayer(); // a steady particle's new layer has no heat capacity, and needs none
    expect(d.materials.opyc.sets["thermal.volumetricHeatCapacity"]).toBeUndefined();
    expect(errorsOf(d)).toEqual([]);
  });
  it("switches to a transient and back: the power section goes and comes, every region has a heat capacity, and both cases are valid", () => {
    const d = fresh(), h = pure(d);
    h.particleAnalysis("transient");
    expect(d.assumptions.steadyState).toBe(false);
    expect(d.power).toBeUndefined();
    expect(Object.keys(d.transient).sort()).toEqual(["endTime", "initialTemperature", "outputs", "powerHistory", "timeStep"]);
    expect(d.transient.initialTemperature).toEqual(q(1000, "K"));
    for (const n of h.particleRegions()) expect(d.materials[n].sets["thermal.volumetricHeatCapacity"], n).toBeTruthy();
    expect(errorsOf(d)).toEqual([]);
    expect(validateCase(d).triso!.transient).toBeTruthy();
    h.particleAnalysis("steady");
    expect(d.assumptions.steadyState).toBe(true);
    expect(d.transient).toBeUndefined();
    expect(d.power).toEqual({ kernelPowerDensity: q(600, "MW/m3") });
    expect(errorsOf(d)).toEqual([]);
    const before = JSON.stringify(d);
    h.particleAnalysis("steady");
    expect(JSON.stringify(d)).toBe(before); // switching to what it already is changes nothing
  });
  it("starts a transient from the steady state at half the first power and back to a uniform start at the outside's temperature", () => {
    const d = fresh(), h = pure(d);
    h.particleAnalysis("transient");
    h.particleInitial("steady");
    expect(d.transient.initialTemperature).toBeUndefined();
    expect(d.transient.initialSteadyParticlePower).toEqual(q(0.2, "W"));
    expect(errorsOf(d)).toEqual([]);
    d.boundary = { bulkTemperature: q(850, "K"), heatTransferCoefficient: q(2000, "W/m2/K") };
    h.particleInitial("uniform");
    expect(d.transient.initialSteadyParticlePower).toBeUndefined();
    expect(d.transient.initialTemperature).toEqual(q(850, "K"));
  });
  it("the transient it starts is the good vector's pulse, keeps a heat capacity the person already stated, and falls back to the outside's temperature and a stated steady power only when it must", () => {
    const d = fresh(), h = pure(d);
    h.particleAnalysis("transient");
    const v = vector("triso-pulse");
    expect(d.transient).toEqual(v.transient);
    for (const n of h.particleRegions()) expect(d.materials[n].sets["thermal.volumetricHeatCapacity"], n).toEqual(v.materials[n].sets["thermal.volumetricHeatCapacity"]);
    // a capacity the person stated is not overwritten when the analysis is switched to a transient again
    const mine = { model: "constant", value: q(7, "MJ/m3/K"), referenceTemperature: q(900, "K"), source: "the person's own" };
    const e = fresh(), g = pure(e);
    e.materials.sic.sets["thermal.volumetricHeatCapacity"] = mine;
    g.particleAnalysis("transient");
    expect(e.materials.sic.sets["thermal.volumetricHeatCapacity"]).toEqual(mine);
    expect(e.materials.kernel.sets["thermal.volumetricHeatCapacity"]).toBeTruthy();
    // no boundary to take the start from: 1000 K; a table with no heat in it: the steady start is 0.2 W
    const f = fresh(), k = pure(f);
    delete f.boundary;
    k.particleAnalysis("transient");
    expect(f.transient.initialTemperature).toEqual(q(1000, "K"));
    f.transient.powerHistory.forEach((p: any) => { p.particlePower = q(0, "W"); });
    k.particleInitial("steady");
    expect(f.transient.initialSteadyParticlePower).toEqual(q(0.2, "W"));
    // a power of 0.6 W in the table starts from 0.3 W
    const m = fresh(), mm = pure(m);
    mm.particleAnalysis("transient");
    m.transient.powerHistory[1].particlePower = q(0.6, "W");
    mm.particleInitial("steady");
    expect(m.transient.initialSteadyParticlePower).toEqual(q(0.3, "W"));
  });
  it("keeps the radial shape when the power form changes, and takes the packing fraction from a number the validator accepts", () => {
    const d = fresh(), h = pure(d);
    d.power.radialShape = "uniform";
    h.setParticlePowerForm("compact", (check(d) as any).triso.derived);
    expect(d.power.radialShape).toBe("uniform");
    expect(d.power.packingFraction.value).toBeLessThan(0.64); // not above random close packing: no warning at once
    expect(validateCase(d).warnings).toEqual([]);
    const r: any = check(d);
    expect(r.triso.derived.compactPowerDensity).toBeCloseTo(d.power.compactPowerDensity.value * 1e6, 3);
  });
  it("changes the form the power is given in and keeps the heat per particle, in all six directions", () => {
    const d = fresh(), h = pure(d);
    const P0 = (check(d) as any).triso.derived.particlePower as number;
    for (const [from, to] of [["kernel-density", "particle"], ["particle", "compact"], ["compact", "kernel-density"], ["kernel-density", "compact"], ["compact", "particle"], ["particle", "kernel-density"]] as const) {
      expect(h.particlePowerForm(), from).toBe(from);
      h.setParticlePowerForm(to, (check(d) as any).triso.derived);
      expect(h.particlePowerForm(), to).toBe(to);
      const r: any = check(d);
      expect(r.errors, to).toEqual([]);
      expect(r.triso.derived.particlePower / P0, to).toBeCloseTo(1, 5);
    }
    h.setParticlePowerForm("compact", null); // no numbers to convert from: a valid power all the same
    expect(errorsOf(d)).toEqual([]);
    expect(d.power.packingFraction).toEqual(q(0.35, "1"));
  });
  it("routes an error to the item that shows it: materials of the particle's regions, a region it does not have, the boundary history, the mesh keys", () => {
    const d = fresh(), h = pure(d);
    expect(h.particleItems().map((i: any) => i[0])).toEqual(["power", "boundary", "geometry", "gap", "mesh", "kernel", "buffer", "ipyc", "sic", "opyc", "limits"]);
    h.particleRemoveLayer();
    expect(h.particleItems().map((i: any) => i[0])).toEqual(["power", "boundary", "geometry", "gap", "mesh", "kernel", "buffer", "ipyc", "sic", "limits"]);
    const items = h.particleItems();
    const of = (f: string) => { const hit = items.find((i: any) => i[3].some((p: string) => f === p || f.startsWith(p + "/"))); return hit ? hit[0] : h.particleFallbackItem(f); };
    expect(of("/materials/sic/sets/thermal.conductivity")).toBe("sic");
    expect(of("/materials/opyc")).toBe("geometry"); // a material for a region the particle lacks is a fault of its geometry
    expect(of("/materials")).toBe("kernel");
    expect(of("/mesh/bufferCells")).toBe("mesh");
    expect(of("/geometry/layers/1/thickness")).toBe("geometry");
    expect(of("/assumptions/steadyState")).toBe("power");
    expect(of("/transient/powerHistory/1/time")).toBe("power");
    expect(of("/limits/0/region")).toBe("limits");
    expect(of("/caseId")).toBeNull();
  });
  it("reads the radii from the document before the rest of it is valid, in any of the units, and says null when one is missing", () => {
    const d = fresh(), h = pure(d);
    const r = h.particleRadii();
    expect(r.kernel).toBeCloseTo(250e-6, 15);
    expect(r.layers.map((l: any) => l.name)).toEqual(["buffer", "ipyc", "sic", "opyc"]);
    expect(r.layers[0].inner).toBeCloseTo(250e-6, 15);
    expect(r.layers[0].outer).toBeCloseTo(350e-6, 15);
    expect(r.outer).toBeCloseTo(460e-6, 15);
    d.geometry.kernelRadius = q(0.25, "mm");
    d.geometry.layers[0].thickness = q(0.0001, "m");
    d.geometry.layers[1].thickness = q(40, "µm");
    expect(h.particleRadii().outer).toBeCloseTo(460e-6, 14);
    d.materials.sic.sets["thermal.conductivity"].source = ""; // another fault does not hide the picture
    expect(h.particleRadii()).not.toBeNull();
    d.geometry.layers[2].thickness = q(-5, "um");
    expect(h.particleRadii()).toBeNull();
    d.geometry.layers[2].thickness = q(35, "um");
    delete d.geometry.kernelRadius;
    expect(h.particleRadii()).toBeNull();
  });
  it("finds the temperature in a region by linear interpolation among its own points, flat beyond them, and null for a region with none", () => {
    const h = pure(fresh());
    const pts = [{ r: 3, T: 50, region: "b" }, { r: 1, T: 100, region: "a" }, { r: 2, T: 90, region: "a" }, { r: 4, T: 40, region: "b" }];
    expect(h.tempInRegion(pts, "a", 1.5)).toBeCloseTo(95, 12);
    expect(h.tempInRegion(pts, "a", 0)).toBe(100);
    expect(h.tempInRegion(pts, "a", 9)).toBe(90);
    expect(h.tempInRegion(pts, "b", 3.25)).toBeCloseTo(47.5, 12); // points given out of order are sorted, and region a's points are not mixed in
    expect(h.tempInRegion(pts, "c", 1)).toBeNull();
  });
  it("reads a steady run into one row per region (nominal radii, face temperatures, drop, hottest and coldest cell) from the saved real output", () => {
    const rec = golden("offbeat-triso", "steady", "results.json"), n = golden("offbeat-triso", "steady", "normalized.json");
    const rows = pure(fresh()).particleRegionRows(rec, n);
    expect(rows.map((r: any) => r.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(rows[0].inner).toBe(0);
    expect(rows[0].outer).toBe(n.kernelRadius);
    expect(rows[3].inner).toBe(n.layers[2].innerRadius);
    expect(rows[4].outer).toBe(n.outerRadius);
    rows.forEach((r: any, i: number) => {
      expect(r.drop).toBeCloseTo(r.innerT - r.outerT, 9);
      expect(r.innerT).toBe(rec.regions[i].innerFaceT);
      expect(r.hottest).toBeGreaterThanOrEqual(r.coldest);
    });
    expect(rows[0].innerT).toBe(rec.summary.kernelCentreT);
    // the layers' drops and the gap's add up to the whole rise from the wall to the centre
    const sum = rows.reduce((a: number, r: any) => a + r.drop, 0) + rec.summary.gapDeltaT;
    expect(sum).toBeCloseTo(rec.summary.kernelCentreT - rec.summary.wallT, 6);
  });
  it("finds each region's peak over a transient run, and when, from the saved pulse", () => {
    const rec = golden("offbeat-triso-transient", "pulse", "results.json");
    const peaks = pure(fresh()).particleRegionPeaks(rec);
    expect(peaks.map((p: any) => p.name)).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    const kernel = peaks[0];
    expect(kernel.peak).toBeCloseTo(rec.summary.maxT, 9); // the hottest cell of the run is in the kernel
    expect(kernel.time).toBeCloseTo(rec.summary.timeOfMaxT, 12);
    for (const p of peaks) expect(p.peak).toBeLessThanOrEqual(kernel.peak + 1e-12);
    expect(peaks[4].peak).toBeLessThan(kernel.peak);
  });
  it("draws a limit only within a span of the temperatures reached and names the rest, and sums a power table by hand", () => {
    const h = pure(fresh());
    const lim = (name: string, T: number) => ({ name, region: "kernel", maxTemperature: T });
    const r = h.limitLines([lim("near", 1050), lim("above", 1100), lim("below", 960), lim("way below", 100)], 1000, 1017, 0.5);
    expect(r.lines.map((l: any) => l.label)).toEqual(["near", "below"]); // the span is max(17, 50) = 50 K: limits from 950 to 1067 K are drawn
    expect(r.lines[0].t).toEqual([0, 0.5]);
    expect(r.lines[0].v).toEqual([1050, 1050]);
    expect(r.off.map((l: any) => l.name)).toEqual(["above", "way below"]);
    expect(h.particleEnergy([0, 0.01, 0.02, 0.5], [0, 0.4, 0, 0])).toBeCloseTo(0.004, 14);
    expect(h.particleEnergy([0, 1], [3, 5])).toBe(4);
  });
  it("holds the words: the label of the picture and a banner that says what a particle result is not", () => {
    const h = pure(fresh());
    expect(h.PARTICLE_LABEL).toBe("1D, spherically symmetric: thermal only");
    expect(h.PARTICLE_TEXT.startsWith(h.PARTICLE_LABEL)).toBe(true);
    for (const w of ["stress", "failure", "fission-gas release", "swelling", "creep", "kernel migration"]) expect(h.PARTICLE_TEXT).toContain(w);
  });
});

describe("the page's wiring for a particle", () => {
  it("parses, offers New coated particle in the Pins menu, and routes the explorer, the properties and the drawing by what the document is", () => {
    expect(() => new Function(script)).not.toThrow();
    expect(script).toMatch(/\["Coated particle \(plan 13\)", \[\{ name: "New coated particle", label: "synthetic", description: "[^"]*", pick: loadParticle \}\]\]/);
    expect(script).toMatch(/const items = \(\) => \(isParticle\(\) \? particleItems\(\) : ITEMS\);/);
    expect(script).toMatch(/if \(isParticle\(\) && selected !== "boundary"\) \{ renderParticleProps\(p\); return; \}/);
    expect(script).toMatch(/for \(const \[id, label, group\] of items\(\)\)/);
    expect(script).toMatch(/meta\(its\[i\]\[0\]\)/);
    expect(script).toMatch(/if \(part\) \{ drawParticle\(\); drawParticleProfile\(\); drawBoundaryHistoryPlotParticle\(\); return; \}/);
    expect(script).toMatch(/if \(result\.triso\) \{ particleChecks\(o, row\); return; \}/);
  });
  it("does not meet a stale explorer: the metadata refresh skips a tree whose items changed (a layer added or removed), and a loaded document never leaves an item it does not have selected", () => {
    expect(script).toMatch(/if \(bs\.length !== its\.length\) return;/);
    expect(script).toMatch(/const ensureSelected = \(\) => \{ if \(doc && !items\(\)\.some\(\(i\) => i\[0\] === selected\)\) selected = "power"; \};/);
    expect(script).toMatch(/ensureSelected\(\); const it = items\(\)\.find/);
    // loading a pin, the example or a file drops the run of a particle that was open; a results render hides the particle's own elements first
    expect(script).toMatch(/async function loadPin\(id, name\) \{ doc = await \(await fetch\("\/api\/pin\/" \+ encodeURIComponent\(id\)\)\)\.json\(\); dropParticleRun\(\);/);
    expect(script).toMatch(/async function loadExample\(\) \{ doc = await \(await fetch\("\/api\/example"\)\)\.json\(\); dropParticleRun\(\);/);
    expect(script).toMatch(/try \{ doc = JSON\.parse\(await f\.text\(\)\); dropParticleRun\(\);/);
    expect(script).toMatch(/drawStackResults\(null\); particleResultsOff\(\);/);
    expect(script).toMatch(/function dropParticleRun\(\) \{ if \(solverRes && String\(solverRes\.kind \|\| ""\)\.startsWith\("triso"\)\) \{ solverRes = null; runRec = null;/);
  });
  it("offers a material item only for the layer names a particle can have", () => {
    const d = fresh(), h = pure(d);
    d.geometry.layers.push({ name: "foam", thickness: q(10, "um") });
    d.geometry.layers.push(null);
    expect(h.particleRegions()).toEqual(["kernel", "buffer", "ipyc", "sic", "opyc"]);
    expect(h.particleItems().map((i: any) => i[0])).not.toContain("foam");
    delete d.geometry.layers;
    expect(h.particleRegions()).toEqual(["kernel"]);
  });
  it("shows the particle's banner, no longer says the editor is a later milestone, and does not turn a valid particle into an error", () => {
    expect(script).toMatch(/if \(isParticle\(\)\) \$\("caseBanner"\)\.textContent = .*PARTICLE_TEXT;/);
    expect(script).not.toMatch(/I_PARTICLE/);
    expect(script).not.toMatch(/milestone T5/);
    expect(script).toMatch(/PARTICLE_LABEL \+ "\. " \+ \$\("rBanner"\)\.textContent/);
  });
  it("has the particle's panels, plots and results in their own functions, and the results view's elements in the page", () => {
    for (const f of ["particlePowerPanel", "particleTransientPanel", "particleGeometryPanel", "particleGapPanel", "particleMeshPanel", "particleMaterialPanel", "particleLimitsPanel", "paintCross", "drawRadial", "drawParticle", "drawParticleProfile", "particleChecks", "renderParticleResults", "loadParticle"]) expect(script, f).toMatch(new RegExp("function " + f + "\\("));
    for (const id of ["rpartWrap", "rpart", "rradWrap", "rrad", "rpTable"]) expect(html, id).toMatch(new RegExp('id="' + id + '"'));
    expect(script).toMatch(/if \(d\.results && \(d\.results\.kind === "triso" \|\| d\.results\.kind === "triso-transient"\)\) \{[^}]*renderParticleResults\(d, m\);/);
  });
  it("leaves the pin, plate and stack views as they were: their branches and the exports are in place", () => {
    expect(script).toMatch(/qField\("Fuel radius", \["geometry", "fuelRadius"\], "length"\)/);
    expect(script).toMatch(/\$\("prof"\)\._pplot = null; drawPin\(\); drawProfile\(\); drawBoundaryHistoryPlot\(\); drawStackSummary\(\);/);
    expect(script).toMatch(/\$\("bCsv"\)\.onclick = \(\) => \{ if \(selDetail && selDetail\.results\)/);
    expect(script).toMatch(/\$\("bJson"\)\.onclick = \(\) => \{ if \(selDetail && selDetail\.results\) download\("results-"/);
  });
  it("has a unit list for the particle's lengths (micrometres first), power densities and power, and shows a unit the list lacks as it is", () => {
    expect(script).toMatch(/lengthUm: \["um", "mm", "cm", "m"\]/);
    expect(script).toMatch(/powerDensity: \["MW\/m3", "kW\/m3", "W\/m3", "W\/cm3"\]/);
    expect(script).toMatch(/particlePower: \["W", "kW", "MW"\]/);
    expect(script).toMatch(/!units\.includes\(q\.unit\)\) units = \[q\.unit\]\.concat\(units\)/);
  });
});
