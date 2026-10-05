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

{
  const c = clone();
  c.geometry.fuelInnerRadius = { value: 1.0, unit: "mm" };
  add("good", "annular-fuel", c, {});
}
{
  const c = clone();
  c.geometry.fuelInnerRadius = { value: 0, unit: "mm" };
  add("good", "hole-zero-is-solid", c, {});
}

// transient base: the synthetic pulse example
const pulseBase = JSON.parse(fs.readFileSync(path.join(root, "examples", "synthetic-pulse.json"), "utf8"));
const pulse = () => JSON.parse(JSON.stringify(pulseBase));
add("good", "synthetic-pulse", pulse(), {});
{
  const c = pulse();
  c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = {
    model: "linear",
    a: { value: 0.9, unit: "MJ/m3/K" },
    b: { value: 0.00417, unit: "MJ/m3/K2" },
    validRange: { min: { value: 250, unit: "K" }, max: { value: 1500, unit: "K" } },
    source: "synthetic: shaped like U-ZrH, for the temperature-dependent oracle",
  };
  add("good", "pulse-linear-heat-capacity", c, {});
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
bad("geometry-hole-too-large", "E_GEOMETRY", "/geometry/fuelInnerRadius", (c) => (c.geometry.fuelInnerRadius = { value: 4.1, unit: "mm" }));
bad("geometry-hole-thin-wall", "E_GEOMETRY", "/geometry/fuelInnerRadius", (c) => (c.geometry.fuelInnerRadius = { value: 4.0, unit: "mm" }));
bad("geometry-hole-negative", "E_GEOMETRY", "/geometry/fuelInnerRadius", (c) => (c.geometry.fuelInnerRadius = { value: -1, unit: "mm" }));
bad("units-hole-unknown", "E_UNITS", "/geometry/fuelInnerRadius", (c) => (c.geometry.fuelInnerRadius = { value: 1, unit: "inch" }));
const badT = (name, code, field, mutate) => {
  const c = pulse();
  mutate(c);
  add("bad", name, c, { code, field });
};
badT("transient-missing-section", "E_TRANSIENT_INCOMPLETE", "/transient", (c) => delete c.transient);
badT("transient-section-on-steady", "E_TRANSIENT_INCOMPLETE", "/transient", (c) => {
  c.assumptions.steadyState = true;
  c.power = { linearHeatRate: { value: 20, unit: "kW/m" } };
});
badT("transient-power-and-history", "E_TRANSIENT_INCOMPLETE", "/power/linearHeatRate", (c) => (c.power = { linearHeatRate: { value: 20, unit: "kW/m" } }));
badT("transient-no-end-time", "E_TRANSIENT_INCOMPLETE", "/transient/endTime", (c) => delete c.transient.endTime);
badT("transient-no-heat-capacity", "E_PROP_MISSING", "/materials/fuel/sets/thermal.volumetricHeatCapacity", (c) => delete c.materials.fuel.sets["thermal.volumetricHeatCapacity"]);
badT("transient-heat-capacity-no-source", "E_PROP_MISSING", "/materials/cladding/sets/thermal.volumetricHeatCapacity/source", (c) => delete c.materials.cladding.sets["thermal.volumetricHeatCapacity"].source);
badT("transient-heat-capacity-no-range", "E_PROP_MISSING", "/materials/fuel/sets/thermal.volumetricHeatCapacity/validRange", (c) => {
  c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: 1, unit: "MJ/m3/K" }, b: { value: 0.001, unit: "MJ/m3/K2" }, source: "synthetic" };
});
badT("range-negative-heat-capacity", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.volumetricHeatCapacity/value", (c) => (c.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: -3, unit: "MJ/m3/K" }));
badT("range-negative-pulse-power", "E_OUT_OF_RANGE", "/transient/powerHistory/1/linearHeatRate", (c) => (c.transient.powerHistory[1].linearHeatRate = { value: -1, unit: "MW/m" }));
badT("time-step-not-dividing", "E_TIME", "/transient/timeStep", (c) => (c.transient.timeStep = { value: 0.3, unit: "ms" }));
badT("time-step-longer-than-run", "E_TIME", "/transient/timeStep", (c) => (c.transient.timeStep = { value: 200, unit: "ms" }));
badT("time-too-many-steps", "E_TIME", "/transient/timeStep", (c) => (c.transient.timeStep = { value: 0.0005, unit: "ms" }));
badT("time-outputs-not-dividing", "E_TIME", "/transient/outputs", (c) => (c.transient.outputs = 7));
badT("time-history-not-from-zero", "E_TIME", "/transient/powerHistory/0/time", (c) => (c.transient.powerHistory[0].time = { value: 1, unit: "ms" }));
badT("time-history-not-increasing", "E_TIME", "/transient/powerHistory/2/time", (c) => (c.transient.powerHistory[2].time = { value: 4, unit: "ms" }));
badT("time-history-ends-early", "E_TIME", "/transient/powerHistory", (c) => c.transient.powerHistory.pop());
badT("units-time-wrong", "E_UNITS", "/transient/timeStep", (c) => (c.transient.timeStep = { value: 0.1, unit: "kg" }));
badT("units-pulse-power-bare", "E_UNITS", "/transient/powerHistory/1/linearHeatRate", (c) => (c.transient.powerHistory[1].linearHeatRate = 1e7));
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
bad("unsupported-mechanics", "E_UNSUPPORTED", "/assumptions/thermalOnly", (c) => (c.assumptions.thermalOnly = false));
bad("unsupported-power-shape", "E_UNSUPPORTED", "/power/radialShape", (c) => (c.power.radialShape = "edge-depressed"));
bad("unsupported-conductivity-model", "E_UNSUPPORTED", "/materials/fuel/sets/thermal.conductivity/model", (c) => (c.materials.fuel.sets["thermal.conductivity"].model = "expression"));
bad("mesh-fuel-low", "E_MESH", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 2));
bad("mesh-cladding-low", "E_MESH", "/mesh/claddingCells", (c) => (c.mesh.claddingCells = 1));
bad("mesh-fuel-high", "E_MESH", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 1000000000));
bad("mesh-cladding-high", "E_MESH", "/mesh/claddingCells", (c) => (c.mesh.claddingCells = 20001));

fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(index.length + " vectors written");
