// Plan 11 B4: what the editor gets for a boundary history (the SI table for its plot) and the page's wiring for the table editor. The page itself was driven in the browser pane
// (see the plan record): edit a value, break the order of the times, switch the form, toggle the table off and on, run, and read the results.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { check } from "../src/server/server";

const root = join(__dirname, "..");
const read = (id: string) => JSON.parse(readFileSync(join(root, "examples", id + ".json"), "utf8"));
const html = readFileSync(join(root, "src/web/index.html"), "utf8");

describe("the check response for the editor", () => {
  it("carries the boundary history in SI for a case that has one, and null for one that has not", () => {
    const r: any = check(read("synthetic-coastdown"));
    expect(r.ok).toBe(true);
    const h = r.transient.boundaryHistory;
    expect(h.kind).toBe("convective");
    expect(h.times.length).toBe(10);
    expect(h.times[0]).toBe(0);
    expect(h.times[9]).toBe(60);
    expect(h.bulkTemperature[9]).toBe(360);
    expect(h.heatTransferCoefficient[0]).toBe(30000);
    const plain: any = check(read("synthetic-pulse-operating"));
    expect(plain.transient.boundaryHistory).toBeNull();
  });
  it("converts units: a history in kW/m2/K and degC reaches the page in W/m2/K and K", () => {
    const d = read("synthetic-coastdown");
    d.transient.boundaryHistory = d.transient.boundaryHistory.map((p: any) => ({ time: p.time, bulkTemperature: { value: p.bulkTemperature.value - 273.15, unit: "degC" }, heatTransferCoefficient: { value: p.heatTransferCoefficient.value / 1000, unit: "kW/m2/K" } }));
    const h = (check(d) as any).transient.boundaryHistory;
    expect(h.heatTransferCoefficient[0]).toBeCloseTo(30000, 6);
    expect(h.bulkTemperature[9]).toBeCloseTo(360, 6);
  });
  it("a history that breaks the rules is an error at the point the page shows it under the Coolant boundary item", () => {
    const d = read("synthetic-coastdown");
    d.transient.boundaryHistory[6].time = { value: 3, unit: "s" };
    const r: any = check(d);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e: any) => e.field)).toContain("/transient/boundaryHistory/6/time");
  });
});

describe("the page", () => {
  it("routes the history's problems to the Coolant boundary item, offers the table only for a transient, drops it when the form changes, and plots it in the editor and in the results", () => {
    expect(html).toMatch(/field === "\/transient\/boundaryHistory" \|\| field\.startsWith\("\/transient\/boundaryHistory\/"\)\) return "boundary"/);
    expect(html).toMatch(/if \(isTransient\(\)\) renderBoundaryHistory\(p, form\)/);
    expect(html).toMatch(/delete doc\.transient\.boundaryHistory; logText \+= "The boundary history was removed/);
    expect(html).toMatch(/id="rbnd"/);
    expect(html).toMatch(/id: "bhist"/);
    expect(html).toMatch(/function drawBoundaryHistory\(canvas, h\)/);
    expect(html).toMatch(/The coolant side changes with time/);
    expect(html).toMatch(/The coolant side changed with time/);
  });
});
