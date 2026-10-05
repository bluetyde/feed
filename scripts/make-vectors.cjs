// Regenerates schema/vectors from examples/synthetic-pin.json. Each bad vector is the good pin with
// ONE targeted break; index.json records the code each must produce. Run: node scripts/make-vectors.cjs
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "examples", "synthetic-pin.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(base));
const dir = path.join(root, "schema", "vectors");
fs.rmSync(dir, { recursive: true, force: true });
for (const d of ["good", "bad"]) fs.mkdirSync(path.join(dir, d), { recursive: true });

const index = [];
function add(kind, name, doc, expect) {
  doc.caseId = name;
  const file = kind + "/" + name + ".json";
  fs.writeFileSync(path.join(dir, file), JSON.stringify(doc, null, 2) + "\n");
  index.push({ file, valid: kind === "good", ...expect });
}

// ---- good
add("good", "synthetic-pin", clone(), {});
{
  const c = clone();
  delete c.boundary.bulkTemperature;
  delete c.boundary.heatTransferCoefficient;
  c.boundary.surfaceTemperature = { value: 600, unit: "degC" };
  add("good", "surface-temperature", c, {});
}
{
  const c = clone();
  c.materials.fuel.sets["thermal.conductivity"] = {
    model: "linear",
    a: { value: 4.0, unit: "W/m/K" },
    b: { value: -0.0006, unit: "W/m/K2" },
    validRange: { min: { value: 500, unit: "K" }, max: { value: 2500, unit: "K" } },
    source: "synthetic: chosen for the conductivity-integral oracle",
  };
  add("good", "linear-conductivity", c, {});
}
{
  const c = clone();
  c.power.linearHeatRate = { value: 80, unit: "kW/m" };
  add("good", "power-warning", c, { warnings: ["W_POWER_RANGE"] });
}
{
  const c = clone();
  c.materials.fuel.sets["openmc.composition"] = { nuclides: { U235: 0.02, U238: 0.98 } };
  c.futureField = { kept: true };
  add("good", "unknown-fields-kept", c, {});
}

{
  const c = clone();
  c.geometry.claddingInnerRadius = { value: 4.1, unit: "mm" };
  add("good", "closed-gap-effective-conductance", c, {});
}

// ---- bad: one break each
const bad = (name, code, field, mutate) => {
  const c = clone();
  mutate(c);
  add("bad", name, c, { code, field });
};
bad("schema-missing-section", "E_SCHEMA_INVALID", "/", (c) => delete c.gap);
bad("schema-wrong-version", "E_SCHEMA_INVALID", "/schema", (c) => (c.schema = "feed.case/9.9"));
bad("units-missing", "E_UNITS", "/power/linearHeatRate", (c) => (c.power.linearHeatRate = { value: 20000 }));
bad("units-bare-number", "E_UNITS", "/power/linearHeatRate", (c) => (c.power.linearHeatRate = 20000));
bad("units-wrong-dimension", "E_UNITS", "/power/linearHeatRate", (c) => (c.power.linearHeatRate = { value: 20000, unit: "W" }));
bad("units-unknown", "E_UNITS", "/geometry/fuelRadius", (c) => (c.geometry.fuelRadius = { value: 4.1, unit: "inch" }));
bad("geometry-negative", "E_GEOMETRY", "/geometry/fuelRadius", (c) => (c.geometry.fuelRadius = { value: -4.1, unit: "mm" }));
bad("geometry-overlap", "E_GEOMETRY", "/geometry/claddingInnerRadius", (c) => (c.geometry.claddingInnerRadius = { value: 4.0, unit: "mm" }));
bad("geometry-wall-inverted", "E_GEOMETRY", "/geometry/claddingOuterRadius", (c) => (c.geometry.claddingOuterRadius = { value: 4.1, unit: "mm" }));
bad("boundary-bulk-only", "E_BOUNDARY_INCOMPLETE", "/boundary/heatTransferCoefficient", (c) => delete c.boundary.heatTransferCoefficient);
bad("boundary-h-only", "E_BOUNDARY_INCOMPLETE", "/boundary/bulkTemperature", (c) => delete c.boundary.bulkTemperature);
bad("boundary-two-forms", "E_BOUNDARY_INCOMPLETE", "/boundary", (c) => (c.boundary.surfaceTemperature = { value: 600, unit: "K" }));
bad("boundary-none", "E_BOUNDARY_INCOMPLETE", "/boundary", (c) => (c.boundary = {}));
bad("prop-missing-conductivity", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity", (c) => {
  c.materials.fuel.sets = { "openmc.composition": { nuclides: { U235: 0.02, U238: 0.98 } }, "openmc.density": { value: 10.4, unit: "g/cm3" } };
});
bad("prop-missing-source", "E_PROP_MISSING", "/materials/cladding/sets/thermal.conductivity/source", (c) => delete c.materials.cladding.sets["thermal.conductivity"].source);
bad("prop-missing-reference-temperature", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/referenceTemperature", (c) => delete c.materials.fuel.sets["thermal.conductivity"].referenceTemperature);
bad("prop-missing-range", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/validRange", (c) => {
  c.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: { value: 4, unit: "W/m/K" }, b: { value: -0.0006, unit: "W/m/K2" }, source: "synthetic" };
});
bad("prop-missing-gap-conductance", "E_PROP_MISSING", "/gap/conductance", (c) => delete c.gap.conductance);
bad("range-negative-power", "E_OUT_OF_RANGE", "/power/linearHeatRate", (c) => (c.power.linearHeatRate = { value: -5, unit: "kW/m" }));
bad("range-conductivity-negative", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity", (c) => {
  c.materials.fuel.sets["thermal.conductivity"] = {
    model: "linear",
    a: { value: 2.0, unit: "W/m/K" },
    b: { value: -0.002, unit: "W/m/K2" },
    validRange: { min: { value: 500, unit: "K" }, max: { value: 2500, unit: "K" } },
    source: "synthetic",
  };
});
bad("range-zero-conductivity", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/value", (c) => (c.materials.fuel.sets["thermal.conductivity"].value = { value: 0, unit: "W/m/K" }));
bad("unsupported-closed-gap", "E_UNSUPPORTED", "/gap/model", (c) => {
  c.geometry.claddingInnerRadius = { value: 4.1, unit: "mm" };
  c.gap = { model: "closed" };
});
bad("unsupported-contact-model", "E_UNSUPPORTED", "/gap/model", (c) => (c.gap = { model: "contact" }));
bad("unsupported-gas-gap", "E_UNSUPPORTED", "/gap/model", (c) => (c.gap = { model: "gas-gap" }));
bad("unsupported-transient", "E_UNSUPPORTED", "/assumptions/steadyState", (c) => (c.assumptions.steadyState = false));
bad("unsupported-mechanics", "E_UNSUPPORTED", "/assumptions/thermalOnly", (c) => (c.assumptions.thermalOnly = false));
bad("unsupported-power-shape", "E_UNSUPPORTED", "/power/radialShape", (c) => (c.power.radialShape = "edge-depressed"));
bad("unsupported-conductivity-model", "E_UNSUPPORTED", "/materials/fuel/sets/thermal.conductivity/model", (c) => (c.materials.fuel.sets["thermal.conductivity"].model = "expression"));
bad("mesh-fuel-low", "E_MESH", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 2));
bad("mesh-cladding-low", "E_MESH", "/mesh/claddingCells", (c) => (c.mesh.claddingCells = 1));

fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(index.length + " vectors written");
