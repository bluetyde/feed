// Plan 12, A7: the 3D view of a stack. The page was driven in the browser pane (see the plan record: a pin and a plate, turned with the keys, cut-away on and off, the readout under the
// pointer, the results view); here: what the server gives the view, the page's pure geometry run without a page (the rings, the quadrilaterals, the projection, the keys), that the
// drawing and the table beside it are built from the same numbers, and that the label cannot be switched off.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const read = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const html = readFileSync(join(root, "src/web/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
const q = (value: number, unit: string) => ({ value, unit });
const stackCase = (slices = 8) => {
  const d = read("synthetic-pin");
  d.axial = { length: q(0.381, "m"), slices, powerShape: { kind: "cosine" } };
  return d;
};

/** The page's pure block, run alone. */
const block = script.slice(script.indexOf("/* pure3d:begin"), script.indexOf("/* pure3d:end */"));
const lib = new Function(block + "; return { V3_SEGS, V3_CUT, V3_OUTER_RADIUS, V3_PLATE_WIDTH, STACK_VIEW_LABEL, geomOfCase, ringsOf, stackViewData, stackTableRows, stackQuads, rot3, projectQuads, V3_KEYS, V3_HOME, colourFraction };")() as any;

/** What the check gives the page, turned into the view's data the way the page does it. */
function viewOf(doc: any) {
  const r: any = check(doc);
  expect(r.ok).toBe(true);
  return { r, d: lib.stackViewData(r.axialProfiles.map((s: any) => ({ index: s.index, z: s.height, samples: s.points })), lib.geomOfCase(r.normalized)) };
}

describe("what the server gives the view", () => {
  it("returns the closed-form radial profile of every slice of a steady stack, the same numbers as the per-slice summary", () => {
    const { r } = viewOf(stackCase(8));
    expect(r.axialProfiles).toHaveLength(8);
    r.axialProfiles.forEach((p: any, k: number) => {
      expect(p.index).toBe(k);
      expect(p.height).toBeCloseTo(r.axial.slices[k].height, 12);
      // 17 points in the fuel and 17 in the cladding; the first is the fuel's centre, the last the cladding's outer face
      expect(p.points).toHaveLength(34);
      expect(p.points[0].T).toBeCloseTo(r.axial.slices[k].centreT, 6);
      expect(p.points[16].T).toBeCloseTo(r.axial.slices[k].fuelSurfaceT, 6);
      expect(p.points[33].T).toBeCloseTo(r.axial.slices[k].claddingOuterT, 6);
    });
  });
  it("returns nothing for a single slice and for a transient stack", () => {
    expect((check(read("synthetic-pin")) as any).axialProfiles).toBeUndefined();
    const t = read("synthetic-coastdown");
    t.axial = { length: q(0.381, "m"), slices: 6, powerShape: { kind: "cosine" } };
    const r: any = check(t);
    expect(r.ok).toBe(true);
    expect(r.axialProfiles).toBeUndefined();
  });
  it("returns the profile of a plate stack with the positions from the mid-plane", () => {
    const d = stackCase(6);
    d.assumptions.geometry = "1D-slab";
    d.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
    const r: any = check(d);
    expect(r.ok).toBe(true);
    expect(r.normalized.plate).toBe(true);
    expect(r.axialProfiles).toHaveLength(6);
    const pts = r.axialProfiles[0].points;
    expect(pts[0].r).toBe(0);
    expect(pts[33].r).toBeCloseTo(4.75e-3, 12);
  });
});

describe("the rings and the data of the view", () => {
  it("cover the radius without a gap or an overlap: fuel, the gap as a ring with no temperature, cladding", () => {
    const { r, d } = viewOf(stackCase(5));
    const g = lib.geomOfCase(r.normalized);
    for (const s of d.slices) {
      expect(s.rings[0].a).toBe(g.inner);
      expect(s.rings[s.rings.length - 1].b).toBe(g.cladOut);
      for (let i = 1; i < s.rings.length; i++) expect(s.rings[i].a).toBeCloseTo(s.rings[i - 1].b, 15);
      expect(s.rings.filter((x: any) => x.T === null)).toHaveLength(1);
      expect(s.rings.filter((x: any) => x.T === null)[0]).toMatchObject({ a: g.fuelR, b: g.cladIn });
      expect(s.rings.filter((x: any) => x.T !== null)).toHaveLength(34);
    }
  });
  it("put the samples in order of radius whatever order they arrive in", () => {
    const { r } = viewOf(stackCase(3));
    const g = lib.geomOfCase(r.normalized);
    const pts = r.axialProfiles[1].points;
    const shuffled = [...pts].reverse();
    expect(lib.ringsOf(shuffled, g)).toEqual(lib.ringsOf(pts, g));
  });
  it("take the colour range from the temperatures themselves and the outer wall from the last cladding sample", () => {
    const { r, d } = viewOf(stackCase(8));
    const all = r.axialProfiles.flatMap((s: any) => s.points.map((p: any) => p.T));
    expect(d.lo).toBe(Math.min(...all));
    expect(d.hi).toBe(Math.max(...all));
    r.axialProfiles.forEach((s: any, k: number) => expect(d.outerT[k]).toBe(s.points[33].T));
  });
  it("give the table the same numbers as the drawing: each row's hottest ring is the largest temperature among that slice's quads, and the rows follow the case's slices", () => {
    const { r, d } = viewOf(stackCase(8));
    const rows = lib.stackTableRows(d);
    const quads = lib.stackQuads(d, true);
    rows.forEach((row: any, k: number) => {
      const ts = quads.filter((e: any) => e.slice === k && e.T !== null).map((e: any) => e.T);
      expect(Math.max(...ts)).toBeCloseTo(row.hottest, 12);
      expect(row.outer).toBeCloseTo(r.axial.slices[k].claddingOuterT, 6);
      expect(row.inner).toBeCloseTo(r.axial.slices[k].centreT, 6);
      expect(row.z).toBeCloseTo(r.axial.slices[k].height, 12);
    });
    expect(Math.max(...rows.map((x: any) => x.hottest))).toBe(d.hi);
  });
});

describe("the quadrilaterals", () => {
  const N = 6;
  const { d } = viewOf(stackCase(N));
  const rings = d.slices[0].rings.length;
  it("with a quarter cut away: the outer surface of 27 of 36 segments, the two cut faces, the first and last end faces", () => {
    const quads = lib.stackQuads(d, true);
    const kind = (k: string) => quads.filter((e: any) => e.kind === k);
    expect(kind("outer")).toHaveLength(N * (lib.V3_SEGS - lib.V3_CUT));
    expect(kind("cut")).toHaveLength(N * rings * 2);
    expect(kind("end")).toHaveLength(2 * rings * (lib.V3_SEGS - lib.V3_CUT));
    // no outer quad lies inside the removed quarter (angles 0 to 90 degrees): its normal (cos, 0, sin) is never in the first quadrant of the x-z plane
    for (const e of kind("outer")) expect(!(e.n[0] > 1e-9 && e.n[2] > 1e-9)).toBe(true);
    // the cut faces face into the removed quarter: +z at the plane z = 0 and +x at the plane x = 0
    const cuts = kind("cut");
    const atZ = cuts.filter((e: any) => e.n[2] === 1), atX = cuts.filter((e: any) => e.n[0] === 1);
    expect(atZ).toHaveLength(N * rings);
    expect(atX).toHaveLength(N * rings);
    expect(atZ.every((e: any) => e.pts.every((p: number[]) => p[2] === 0))).toBe(true);
    expect(atX.every((e: any) => e.pts.every((p: number[]) => p[0] === 0))).toBe(true);
  });
  it("without the cut-away: the whole outer surface, no cut faces", () => {
    const quads = lib.stackQuads(d, false);
    expect(quads.filter((e: any) => e.kind === "outer")).toHaveLength(N * lib.V3_SEGS);
    expect(quads.filter((e: any) => e.kind === "cut")).toHaveLength(0);
  });
  it("give every quadrilateral the temperature of its own ring or its slice's outer wall, and the gap none", () => {
    const quads = lib.stackQuads(d, true);
    for (const e of quads) {
      const s = d.slices[e.slice];
      if (e.kind === "outer") expect(e.T).toBe(d.outerT[e.slice]);
      else expect(s.rings.map((x: any) => x.T)).toContain(e.T);
    }
    expect(quads.filter((e: any) => e.T === null).length).toBeGreaterThan(0);
  });
  it("stack the slices from the bottom: heights from -0.5 to 0.5 in N equal bands, each slice's quadrilaterals inside its own band", () => {
    const quads = lib.stackQuads(d, true);
    for (const e of quads) {
      if (e.kind === "end") continue;
      const ys = e.pts.map((p: number[]) => p[1]);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.5 + e.slice / N - 1e-12);
      expect(Math.max(...ys)).toBeLessThanOrEqual(-0.5 + (e.slice + 1) / N + 1e-12);
    }
    const all = quads.flatMap((e: any) => e.pts.map((p: number[]) => p[1]));
    expect(Math.min(...all)).toBeCloseTo(-0.5, 12);
    expect(Math.max(...all)).toBeCloseTo(0.5, 12);
  });
  it("draw the radius larger than the height says: the outer radius is the constant, whatever the true size", () => {
    const quads = lib.stackQuads(d, true);
    const radii = quads.filter((e: any) => e.kind === "outer").flatMap((e: any) => e.pts.map((p: number[]) => Math.hypot(p[0], p[2])));
    expect(Math.max(...radii)).toBeCloseTo(lib.V3_OUTER_RADIUS, 12);
  });
  it("draw a plate as a slab centred on the axis, cut at its middle plane", () => {
    const doc = stackCase(5);
    doc.assumptions.geometry = "1D-slab";
    doc.geometry = { kind: "plate", fuelHalfThickness: q(4.1, "mm"), gapThickness: q(0.08, "mm"), claddingThickness: q(0.57, "mm") };
    const { d: pd } = viewOf(doc);
    const quads = lib.stackQuads(pd, true);
    const xs = quads.flatMap((e: any) => e.pts.map((p: number[]) => p[0]));
    const zs = quads.flatMap((e: any) => e.pts.map((p: number[]) => p[2]));
    expect(Math.min(...xs)).toBeCloseTo(-0.5 * lib.V3_OUTER_RADIUS, 12);
    expect(Math.max(...xs)).toBeCloseTo(0.5 * lib.V3_OUTER_RADIUS, 12);
    expect(Math.min(...zs)).toBeCloseTo(-0.5 * lib.V3_PLATE_WIDTH, 12);
    expect(Math.max(...zs)).toBeCloseTo(0.5 * lib.V3_PLATE_WIDTH, 12);
    expect(quads.filter((e: any) => e.kind === "cut").length).toBe(5 * pd.slices[0].rings.length);
    expect(quads.filter((e: any) => e.kind === "outer").length).toBe(2 * 5);
    expect(quads.every((e: any) => e.T === null || e.T >= pd.lo - 1e-9)).toBe(true);
  });
});

describe("the projection and the keys", () => {
  it("turns a point without changing its distance from the axis of turning, and turns by the yaw about the vertical axis", () => {
    const v = { yaw: 0.7, pitch: 0, zoom: 1, cut: true };
    const p = lib.rot3([0.3, 0.2, 0.4], v);
    expect(p[1]).toBeCloseTo(0.2, 12);
    expect(Math.hypot(p[0], p[2])).toBeCloseTo(0.5, 12);
    expect(lib.rot3([0.3, 0.2, 0.4], { yaw: 0, pitch: 0, zoom: 1 })).toEqual([0.3, 0.2, 0.4]);
  });
  it("drops the quadrilaterals that face away and sorts the rest from far to near", () => {
    const mk = (z: number, n: number[]) => ({ pts: [[0, 0, z], [0.1, 0, z], [0.1, 0.1, z], [0, 0.1, z]], T: 1, n, slice: 0, r: 0, kind: "outer" });
    const out = lib.projectQuads([mk(0.3, [0, 0, 1]), mk(-0.3, [0, 0, 1]), mk(0, [0, 0, -1])], { yaw: 0, pitch: 0, zoom: 1 }, 400, 400);
    expect(out).toHaveLength(2);
    expect(out[0].depth).toBeLessThan(out[1].depth);
    expect(out[1].depth).toBeCloseTo(0.3, 12);
  });
  it("draws what is nearer larger (perspective) and keeps the middle of the picture at the middle of the canvas", () => {
    const mk = (z: number) => ({ pts: [[-0.1, -0.1, z], [0.1, -0.1, z], [0.1, 0.1, z], [-0.1, 0.1, z]], T: 1, n: [0, 0, 1], slice: 0, r: 0, kind: "outer" });
    const [far, near] = lib.projectQuads([mk(-0.4), mk(0.4)], { yaw: 0, pitch: 0, zoom: 1 }, 400, 400);
    const width = (e: any) => e.xy[1][0] - e.xy[0][0];
    expect(width(near)).toBeGreaterThan(width(far));
    expect((near.xy[0][0] + near.xy[1][0]) / 2).toBeCloseTo(200, 9);
    expect((near.xy[0][1] + near.xy[2][1]) / 2).toBeCloseTo(200, 9);
  });
  it("turns with the arrow keys, tilts within limits, zooms within limits and resets with 0", () => {
    const K = lib.V3_KEYS, h = lib.V3_HOME;
    expect(K.ArrowRight(h).yaw).toBeGreaterThan(h.yaw);
    expect(K.ArrowLeft(h).yaw).toBeLessThan(h.yaw);
    let v = h;
    for (let i = 0; i < 50; i++) v = K.ArrowUp(v);
    expect(v.pitch).toBeLessThanOrEqual(1.45);
    for (let i = 0; i < 80; i++) v = K.ArrowDown(v);
    expect(v.pitch).toBeGreaterThanOrEqual(-1.45);
    for (let i = 0; i < 40; i++) v = K["+"](v);
    expect(v.zoom).toBeLessThanOrEqual(3);
    for (let i = 0; i < 80; i++) v = K["-"](v);
    expect(v.zoom).toBeGreaterThanOrEqual(0.4);
    expect(K["0"](v)).toEqual(h);
    expect(h.cut).toBe(true);
  });
  it("maps a temperature to the shared colour range, the middle of it when the stack is uniform", () => {
    expect(lib.colourFraction(300, 300, 500)).toBe(0);
    expect(lib.colourFraction(500, 300, 500)).toBe(1);
    expect(lib.colourFraction(400, 300, 500)).toBe(0.5);
    expect(lib.colourFraction(400, 400, 400)).toBe(0.5);
  });
});

describe("the page's wiring", () => {
  it("has the page script parse, the tab and its panel, the results host, and the colour scale shared with the pin's picture", () => {
    expect(() => new Function(script)).not.toThrow();
    expect(html).toMatch(/id="tab3d"/);
    expect(html).toMatch(/id="doc3d"/);
    expect(html).toMatch(/id="r3dHost"/);
    expect(script).toMatch(/heat\(colourFraction\(e\.q\.T, d\.lo, d\.hi\)\)/);
    expect(script).toMatch(/x\.fillStyle = heat\(i \/ \(sw - 1\)\)/);
    expect(script).toMatch(/function heat\(f\)/);
  });
  it("cannot hide the label: it is drawn into the canvas unconditionally, and the caption under it is a banner with no hide control", () => {
    expect(lib.STACK_VIEW_LABEL).toMatch(/^1\.5D: one radial solution per slice/);
    expect(lib.STACK_VIEW_LABEL).toMatch(/Not a three-dimensional solution/);
    expect(script).toMatch(/x\.fillText\("1\.5D: one radial solution per slice", 14, 18\);/);
    // the label line is not inside a condition: the line before it is not an if, and no code sets the caption hidden
    const i = script.indexOf('x.fillText("1.5D: one radial solution per slice", 14, 18);');
    expect(script.slice(script.lastIndexOf("\n", i - 1) + 1, i)).not.toMatch(/\bif\b|\?|&&/);
    expect(script).toMatch(/const cap = elt\("div", STACK_VIEW_LABEL, \{ class: "banner", id: id \+ "Cap" \}\)/);
    expect(script).not.toMatch(/cap\.hidden|Cap"\)\.hidden|style\.display\s*=\s*"none"[^;]*Cap/);
  });
  it("is reachable without a pointer: the canvas takes focus, answers the keys, and the numbers are a table the person can open", () => {
    expect(script).toMatch(/tabindex: "0"/);
    expect(script).toMatch(/canvas\.addEventListener\("keydown"/);
    expect(script).toMatch(/summary", "The numbers behind the view \(the same as the drawing\)"/);
    expect(script).toMatch(/aria-label", "3D stack of "/);
  });
  it("offers the view for a steady stack only, in the case view and in the results view", () => {
    expect(script).toMatch(/result\.transient\) return null/);
    expect(script).toMatch(/d\.results\.kind === "transient" \|\| !a\.slices\.every/);
    expect(script).toMatch(/The 3D view is for steady stacks/);
    expect(script).toMatch(/drawStackResults\(d\); renderStackResults3d\(d\)/);
  });
});
