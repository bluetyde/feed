// Plan 13 T6: the heating transfer and a coated particle. FEED's transfer maps a heating table onto the axial slices of one PIN and sets the linear heat rate of one slice; it has no
// per-particle form (docs/triso.md, "Power from OpenMC"). This pins what happens today when a particle is the target: the request is refused with the validator's reason, and no case
// comes out; and FEED does not advertise a field for particles to SEED.
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { DESCRIBE_TRANSFERS, TRANSFER_FIELDS, transferHeating } from "../src/core/transferRequest";

const root = join(__dirname, "..");
const particleText = readFileSync(join(root, "schema", "vectors", "good", "triso-steady.json"), "utf8");
const FRAME = "pin-axis z up, m, origin at bottom of fuel";
const table = {
  schema: "seed.quantity-data/0.2",
  quantity: "Fuel:heating",
  kind: "table",
  unit: "MeV",
  columns: [
    { name: "pin", unit: "1", role: "label" },
    { name: "z_min", unit: "m", role: "coordinate" },
    { name: "z_max", unit: "m", role: "coordinate" },
    { name: "mean", unit: "MeV", role: "value" },
    { name: "std", unit: "MeV", role: "std", of: "mean" },
  ],
  rows: [[["p1"], 0, 0.5, 4, 0.04], [["p1"], 0.5, 1, 6, 0.06]],
  meta: { frame: FRAME },
};
const recipe = {
  schema: "seed.transfer-recipe/0.2",
  recipeId: "heat-to-particle-1",
  proposedBy: { kind: "agent", name: "claude" },
  proposedAt: "2026-10-16T10:00:00Z",
  source: { runId: "run-001", resultsSha256: "a".repeat(64), quantity: "Fuel:heating", dataSha256: "b".repeat(64), unit: "MeV", dimension: "energy", normalization: "per-source-particle", revisionPins: [{ artifact: "openmc-model", revision: "c".repeat(64) }] },
  target: { app: "feed", artifact: "particle-case", revision: "d".repeat(64), field: "heating-to-pin" },
  units: { to: "W" },
  normalization: { kind: "source-rate", value: { value: 1e10, unit: "1/s" }, origin: "a stated source rate" },
  mapping: { spatial: { pin: "p1", frame: FRAME, slices: [{ id: "lower", z: { min: 0, max: 0.5 } }, { id: "upper", z: { min: 0.5, max: 1 } }], applyTo: "lower" }, time: { kind: "steady" }, extrapolation: "refused" },
  tolerance: { conservation: 1e-9, fixedBefore: "mapping" },
};
const request = (target: string) => ({ schema: "seed.transfer-request/0.2", recipe, recipeDigest: "e".repeat(64), source: { quantity: { name: "Fuel:heating", unit: "MeV", dimension: "energy", normalization: "per-source-particle" }, data: table }, target: { artifact: "particle-case", revision: "d".repeat(64), content: target } });

describe("a heating transfer into a coated particle", () => {
  it("is refused with the validator's reason (a particle's power is not a linear heat rate) and no case comes out", () => {
    const r: any = transferHeating(request(particleText));
    expect(r.ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.errors[0].code).toBe("E_UNSUPPORTED");
    expect(r.errors[0].field).toBe("/target/content/power/linearHeatRate");
    expect(r.errors[0].message).toMatch(/not valid/);
  });
  it("the same request into a pin works, so the refusal is about the target and not the table", () => {
    const r: any = transferHeating(request(readFileSync(join(root, "examples", "synthetic-pin.json"), "utf8")));
    expect(r.ok).toBe(true);
  });
  it("FEED advertises no field for particles: the transfers it describes are for a pin, a coolant boundary and a burnup", () => {
    expect([...TRANSFER_FIELDS]).toEqual(["heating-to-pin", "coolant-boundary", "burnup"]);
    expect(DESCRIBE_TRANSFERS.map((d) => d.field)).toEqual(["heating-to-pin", "coolant-boundary", "burnup"]);
  });
});
