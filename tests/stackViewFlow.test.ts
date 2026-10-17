// Plan 15, B5: the case view's option "Heat flow along the height: not included (closed form per slice, instant) | included (two-dimensional reference solution)" for steady stacks of PLATES.
// What the check gives the page (the field, or the reason for none), the page's pure helpers run without a page (the choice, the data, the captions), and the wiring that keeps the caption
// on screen and true in each state. The page itself was driven in the browser pane (plan record). Limits fixed here before the first run, with their reasons:
//   EFFECT   the largest change the conduction along the height makes to any cell of the saved 0.381 m, 10-slice cosine plate at 200 kW/m is 0.609 K (plan 12 A5, plan 15 B0: +0.609): 0.005 K either way.
//   OFFBEAT  the offered field against the cells OFFBEAT saved for the same plate: 1e-3 K (B2 saw 5e-6; 1e-3 is the iteration tolerance the pin runs show at 1.6e-3).
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { sliceLoads } from "../src/core/axial";
import { parseScalarField } from "../src/core/resultsParser";
import { FIELD_2D_PIN_REASON, axialField2d, stackReference } from "../src/core/stackReference";
import { validateCase } from "../src/core/validate";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const html = read("src/web/index.html");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
const q = (value: number, unit: string) => ({ value, unit });
const block = script.slice(script.indexOf("/* pure3d:begin"), script.indexOf("/* pure3d:end */"));
const lib = new Function(block + "; return { STACK_VIEW_LABEL, stackViewFlowLabel, stackViewCaption, stackViewCanvasLabel, stackFlowChoice, stackDataTwoD, geomOfCase, stackViewData, stackTableRows, stackQuads };")() as any;

/** A steady plate stack: the plate of the transient example (synthetic) with a heat rate and a length of our choosing. */
function plateDoc(slices = 12, length = 0.06) {
  const d = JSON.parse(read("examples/synthetic-plate-loss-of-cooling.json"));
  delete d.transient;
  d.assumptions.steadyState = true;
  d.power = { linearHeatRate: q(100, "kW/m"), radialShape: "uniform" };
  d.axial = { length: q(length, "m"), slices, powerShape: { kind: "cosine" } };
  return d;
}
const golden = (name: string) => JSON.parse(read("tests/golden/offbeat-plate-stack", name, "normalized.json"));

describe("what the check gives the view", () => {
  it("a steady plate stack: the field of every slice, one point per cell, inner to outer, fuel then cladding, in the form of the closed-form profile", () => {
    const r: any = check(plateDoc());
    expect(r.ok).toBe(true);
    const f = r.axialField2d;
    expect(f.available).toBe(true);
    expect(f.slices).toHaveLength(12);
    f.slices.forEach((s: any, k: number) => {
      expect(s.index).toBe(k);
      expect(s.height).toBeCloseTo(r.axialProfiles[k].height, 12);
      expect(s.points).toHaveLength(26);
      expect(s.points.slice(0, 20).every((p: any) => p.region === "fuel")).toBe(true);
      expect(s.points.slice(20).every((p: any) => p.region === "cladding")).toBe(true);
      for (let i = 1; i < 26; i++) expect(s.points[i].r).toBeGreaterThan(s.points[i - 1].r);
    });
    expect(f.note).toMatch(/second method on the same mesh as the run, not OFFBEAT's result and not a measurement/);
  });

  it("is the reference's own solution: every cell of every slice equals stackReference's", () => {
    const n = validateCase(plateDoc()).normalized!;
    const f = axialField2d(n)!;
    const ref = stackReference(n);
    if (!("reference" in ref) || !f.available) throw new Error("no reference");
    f.slices.forEach((s, k) => {
      const cells = ref.reference.slice(k);
      expect(s.points.map((p) => p.T)).toEqual([...cells.fuel, ...cells.clad]);
    });
  });

  it("agrees with the cells OFFBEAT saved for the 0.381 m cosine plate, and the effect of the conduction along the height is the 0.609 K of plan 12 A5", () => {
    const n = golden("cosine");
    const f = axialField2d(n)!;
    if (!f.available) throw new Error("not available");
    expect(Math.abs(f.effect - 0.609)).toBeLessThan(0.005);
    const T = parseScalarField(read("tests/golden/offbeat-plate-stack/cosine/T"), "T");
    const N = n.axial.slices, nf = n.mesh.fuelCells, nc = n.mesh.claddingCells;
    let worst = 0;
    f.slices.forEach((s, k) => {
      s.points.forEach((p, i) => {
        const id = i < nf ? k * nf + i : N * nf + k * nc + (i - nf);
        worst = Math.max(worst, Math.abs(p.T - T[id]!));
      });
    });
    expect(worst).toBeLessThan(1e-3);
  });

  it("an end slice is hotter than its closed form says, by what the heat flow along the height brings (a short plate: more than 5 K)", () => {
    const r: any = check(plateDoc());
    const closed = Math.max(...r.axialProfiles[0].points.map((p: any) => p.T));
    const two = Math.max(...r.axialField2d.slices[0].points.map((p: any) => p.T));
    expect(two - closed).toBeGreaterThan(5);
    expect(r.axialField2d.effect).toBeGreaterThan(5);
  });

  it("a stack of pins: not offered, with the reason", () => {
    const d = JSON.parse(read("examples/ksu-triga-cosine-stack.json"));
    const r: any = check(d);
    expect(r.ok).toBe(true);
    expect(r.axialField2d).toEqual({ available: false, reason: FIELD_2D_PIN_REASON });
    expect(FIELD_2D_PIN_REASON).toMatch(/not offered for a stack of pins/);
  });

  it("no stack, and a transient stack: nothing is offered (the key is absent or undefined)", () => {
    expect((check(JSON.parse(read("examples/synthetic-pin.json"))) as any).axialField2d).toBeUndefined();
    const t: any = check(JSON.parse(read("examples/synthetic-plate-loss-of-cooling.json")));
    expect(t.ok).toBe(true);
    expect(t.axialField2d).toBeUndefined();
  });

  it("a stack too large for the solver: not offered, with the reason the solver gives", () => {
    const n = JSON.parse(JSON.stringify(validateCase(plateDoc()).normalized!));
    n.axial.slices = 1000; // 26000 unknowns, over the 20000 the solver takes
    const f = axialField2d(n)!;
    expect(f.available).toBe(false);
    if (!f.available) expect(f.reason).toMatch(/26000 unknowns/);
  });

  it("the loads the field is drawn at are the case's own (the heights of the slices)", () => {
    const n = validateCase(plateDoc(7, 0.2)).normalized!;
    const f = axialField2d(n)!;
    if (!f.available) throw new Error("not available");
    expect(f.slices.map((s) => s.height)).toEqual(sliceLoads(n).map((l) => l.height));
  });
});

describe("the page's choice of what to show", () => {
  const on = { available: true, slices: [], effect: 3.2, note: "" };
  it("shows the two-dimensional field only when it was asked for AND it is offered", () => {
    expect(lib.stackFlowChoice(on, "2d")).toEqual({ shown: "2d", enabled: true, reason: "" });
    expect(lib.stackFlowChoice(on, "closed")).toEqual({ shown: "closed", enabled: true, reason: "" });
    expect(lib.stackFlowChoice(on, undefined)).toMatchObject({ shown: "closed", enabled: true });
    expect(lib.stackFlowChoice(on, "anything else")).toMatchObject({ shown: "closed" });
  });
  it("a pin, or a failed solve: the closed forms are shown whatever was asked for, the option is disabled, and the reason is carried", () => {
    expect(lib.stackFlowChoice({ available: false, reason: "because of a pin" }, "2d")).toEqual({ shown: "closed", enabled: false, reason: "because of a pin" });
    expect(lib.stackFlowChoice(undefined, "2d")).toMatchObject({ shown: "closed", enabled: false });
    expect(lib.stackFlowChoice(undefined, "2d").reason).not.toBe("");
    expect(lib.stackFlowChoice(null, "2d")).toMatchObject({ shown: "closed", enabled: false });
  });
});

describe("the data and the captions are true in each state", () => {
  const r: any = check(plateDoc());
  const g = lib.geomOfCase(r.normalized);
  const closed = lib.stackViewData(r.axialProfiles.map((s: any) => ({ index: s.index, z: s.height, samples: s.points })), g);
  const two = lib.stackDataTwoD(r.axialField2d, g);

  it("the two-dimensional data is built like the closed one (same rings, same table rows) from the field's points, and says it is the field", () => {
    expect(two.flow).toBe("2d");
    expect(two.effect).toBe(r.axialField2d.effect);
    expect(closed.flow).toBeUndefined();
    expect(two.slices).toHaveLength(closed.slices.length);
    expect(two.slices[0].rings.filter((x: any) => x.T !== null)).toHaveLength(26);
    expect(closed.slices[0].rings.filter((x: any) => x.T !== null)).toHaveLength(34);
    // the table shows the field's numbers: the first row's inner and outer are the first and last cell of slice 1
    const rows = lib.stackTableRows(two);
    const pts = r.axialField2d.slices[0].points;
    expect(rows[0].inner).toBe(pts[0].T);
    expect(rows[0].outer).toBe(pts[25].T);
    expect(rows[0].hottest).toBe(Math.max(...pts.map((p: any) => p.T)));
    // the heights are the slices' own, in order, and the colour range is the field's
    rows.forEach((row: any, k: number) => expect(row.z).toBe(r.axialField2d.slices[k].height));
    expect(two.lo).toBe(Math.min(...r.axialField2d.slices.flatMap((s: any) => s.points.map((p: any) => p.T))));
    expect(two.hi).toBe(Math.max(...r.axialField2d.slices.flatMap((s: any) => s.points.map((p: any) => p.T))));
    // and the drawing is made of the same rings: every coloured quadrilateral has the temperature of one of its slice's rings or its outer wall
    for (const cut of [true, false]) {
      for (const qd of lib.stackQuads(two, cut)) {
        if (qd.T === null) continue;
        const s = two.slices[qd.slice];
        expect(s.rings.some((x: any) => x.T === qd.T) || qd.T === two.outerT[qd.slice]).toBe(true);
      }
    }
    // the two states differ where the physics says they do: the end slice is hotter with the heat flow in it
    expect(rows[0].hottest).toBeGreaterThan(lib.stackTableRows(closed)[0].hottest + 5);
    expect(two.hi).toBeGreaterThan(closed.hi - 10); // the colour range follows the data shown
  });

  it("the closed state's caption says the closed forms let no heat flow between the slices and says nothing of a two-dimensional solution", () => {
    const c = lib.stackViewCaption(closed);
    expect(c).toBe(lib.STACK_VIEW_LABEL);
    expect(c).toMatch(/let no heat flow between the slices/);
    expect(c).not.toMatch(/IS in the temperatures/);
    expect(lib.stackViewCanvasLabel(closed)).toBe("1.5D: one radial solution per slice");
  });

  it("the two-dimensional state's caption says the heat along the height IS in the picture, how much it changes it, that it is FEED's own second method and not OFFBEAT's result, and how to get the closed forms", () => {
    const c = lib.stackViewCaption(two);
    expect(c).toBe(lib.stackViewFlowLabel(two.effect));
    expect(c).toMatch(/^2D: FEED's own finite-volume solution of the whole stack/);
    expect(c).toMatch(/IS in the temperatures drawn: it changes them by up to 11 K against the same solution without it/);
    expect(c).toMatch(/not OFFBEAT's result and not a measurement/);
    expect(c).toMatch(/Switch the option off for the closed forms, which let no heat flow between the slices/);
    expect(c).toMatch(/A run's picture is OFFBEAT's own cells/);
    expect(c).not.toMatch(/1\.5D/);
    expect(lib.stackViewCanvasLabel(two)).toBe("2D: FEED's reference field, heat flow along the height included");
  });

  it("with no effect to quote the caption quotes none, and never prints NaN", () => {
    for (const bad of [undefined, null, NaN, Infinity]) {
      const c = lib.stackViewFlowLabel(bad as any);
      expect(c).not.toMatch(/NaN|Infinity|undefined|null/);
      expect(c).not.toMatch(/changes them by up to/);
    }
    expect(lib.stackViewFlowLabel(0)).toMatch(/changes them by up to 0\.0 K/);
  });

  it("a run's caption and label are unchanged, and a run is never the two-dimensional state (a run is OFFBEAT's, which includes the flow)", () => {
    const run = { ...closed, run: true, conduction: 0.00137, flow: "2d" };
    expect(lib.stackViewCaption(run)).toBe(lib.stackViewCaption({ run: true, conduction: 0.00137 }));
    expect(lib.stackViewCaption(run)).toMatch(/OFFBEAT found in each slice/);
    expect(lib.stackViewCanvasLabel(run)).toBe("1.5D: OFFBEAT's result in each slice");
  });
});

describe("the wiring that keeps the caption on screen", () => {
  it("the caption is set from the data now shown on every redraw, the canvas label is drawn unconditionally, and the option re-asks the data (redraw) after it is set", () => {
    expect(script).toMatch(/cap\.textContent = stackViewCaption\(d\);/);
    expect(script).toMatch(/x\.fillText\(stackViewCanvasLabel\(d\), 14, 18\);/);
    expect(script).toMatch(/b\.addEventListener\("click", \(\) => \{ flow\.set\(key\); redraw\(\); \}\);/);
  });
  it("the case view's panel gets the option and the results' panel does not (a run is OFFBEAT's, with the flow in it)", () => {
    expect(script).toMatch(/make3dPanel\(\$\("doc3d"\), stackDataFromCheck, "c3", case3dFlowOption\)/);
    expect(script).toMatch(/make3dPanel\(host, \(\) => stackDataFromRun\(selDetail\), "r3"\);/);
    expect(script).not.toMatch(/make3dPanel\(host, \(\) => stackDataFromRun\(selDetail\), "r3", /);
  });
  it("the two-dimensional button is disabled with the reason when the check does not offer the field, and the data function asks the choice before it draws the field", () => {
    expect(script).toMatch(/fb\["2d"\]\.disabled = !c\.enabled; fb\["2d"\]\.title = c\.enabled \? "" : c\.reason;/);
    expect(script).toMatch(/if \(stackFlowChoice\(result\.axialField2d, case3dFlow\)\.shown === "2d"\) return stackDataTwoD\(result\.axialField2d, geomOfCase\(result\.normalized\)\);/);
  });
  it("the page starts in the closed-form state (instant), and the data function falls back to the closed forms for any other value", () => {
    expect(script).toMatch(/let case3dFlow = "closed";/);
    expect(script).toMatch(/set: \(v\) => \{ case3dFlow = v; \}/);
  });
  it("the option's two labels are the plan's words", () => {
    expect(script).toContain('"Not included (closed form per slice, instant)"');
    expect(script).toContain('"Included (two-dimensional reference solution)"');
    expect(script).toContain('"Heat flow along the height:"');
  });
});
