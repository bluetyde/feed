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
  c.hotDimensions = {
    referenceTemperature: { value: 20, unit: "degC" },
    fuel: { linearExpansion: { value: 12, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
    cladding: { linearExpansion: { value: 10, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
  };
  add("good", "hot-dimensions", c, {});
}
{
  const c = clone();
  c.hotDimensions = {
    referenceTemperature: { value: 20, unit: "degC" },
    fuel: { linearExpansion: { model: "linear", a: { value: 5, unit: "ppm/K" }, b: { value: 20, unit: "1e-9/K2" }, validRange: { min: { value: 293, unit: "K" }, max: { value: 600, unit: "K" } } }, source: "synthetic: a range that the pin leaves" },
    cladding: { linearExpansion: { value: 10, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
  };
  add("good", "hot-dimensions-range-warning", c, { warnings: ["W_EXPANSION_RANGE"] });
}
{
  const c = clone();
  c.materials.fuel.sets["thermal.conductivity"] = {
    model: "uo2-nfi",
    densityFraction: { value: 95, unit: "%" },
    source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 (FRAPCON-3.4 modified NFI)",
  };
  c.burnup = { value: { value: 40, unit: "MWd/kgHM" }, basis: "heavy-metal", source: "chosen for the study" };
  add("good", "uo2-nfi-burnup", c, {});
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
// heat capacity as a quadratic or as a fitted table (docs/conductivity-models.md)
const polyCp = (extra = {}) => ({ model: "polynomial", a: { value: 0.9, unit: "MJ/m3/K" }, b: { value: 0.00417, unit: "MJ/m3/K2" }, c: { value: -1e-6, unit: "MJ/m3/K3" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 1500, unit: "K" } }, source: "synthetic: a quadratic chosen to exercise the polynomial model", ...extra });
const tableCp = (rows, extra = {}) => ({ model: "table", points: (rows || [[250, 1.9], [500, 2.9], [800, 4.0], [1200, 5.0], [1500, 5.4]]).map(([T, c]) => ({ temperature: { value: T, unit: "K" }, heatCapacity: { value: c, unit: "MJ/m3/K" } })), fit: { degree: 2, tolerance: { value: 5, unit: "%" } }, source: "synthetic: a table chosen to exercise the table model", ...extra });
const withFuelCp = (set) => { const c = pulse(); c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = set; return c; };
add("good", "pulse-quadratic-heat-capacity", withFuelCp(polyCp()), {});
add("good", "pulse-quadratic-heat-capacity-zero-term", withFuelCp(polyCp({ c: { value: 0, unit: "MJ/m3/K3" } })), {});
add("good", "pulse-table-heat-capacity", withFuelCp(tableCp()), {});

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
badT("units-heat-capacity-overflow", "E_UNITS", "/materials/fuel/sets/thermal.volumetricHeatCapacity/value", (c) => (c.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 1e308, unit: "MJ/m3/K" }));
badT("range-heat-capacity-implausible", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.volumetricHeatCapacity/value", (c) => (c.materials.fuel.sets["thermal.volumetricHeatCapacity"].value = { value: 0.001, unit: "J/m3/K" }));
badT("range-initial-temperature-outside-heat-capacity-range", "E_OUT_OF_RANGE", "/transient/initialTemperature", (c) => {
  c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: 0.9, unit: "MJ/m3/K" }, b: { value: 0.00417, unit: "MJ/m3/K2" }, validRange: { min: { value: 400, unit: "K" }, max: { value: 1500, unit: "K" } }, source: "synthetic" };
});
const dropK = (o, k) => { const x = JSON.parse(JSON.stringify(o)); delete x[k]; return x; };
const badCp = (name, code, field, set) => add("bad", name, withFuelCp(set), { code, field });
const CP = "/materials/fuel/sets/thermal.volumetricHeatCapacity";
badCp("cp-polynomial-missing-coefficient", "E_PROP_MISSING", CP + "/c", dropK(polyCp(), "c"));
badCp("cp-polynomial-no-source", "E_PROP_MISSING", CP + "/source", dropK(polyCp(), "source"));
badCp("cp-polynomial-no-range", "E_PROP_MISSING", CP + "/validRange", dropK(polyCp(), "validRange"));
badCp("cp-polynomial-wrong-unit", "E_UNITS", CP + "/c", polyCp({ c: { value: -1e-6, unit: "MJ/m3/K2" } }));
badCp("cp-polynomial-negative-inside-range", "E_OUT_OF_RANGE", CP, polyCp({ c: { value: -6e-6, unit: "MJ/m3/K3" } }));
badCp("cp-polynomial-implausible-size", "E_OUT_OF_RANGE", CP, polyCp({ a: { value: 0.0000005, unit: "MJ/m3/K" }, b: { value: 0, unit: "MJ/m3/K2" }, c: { value: 0, unit: "MJ/m3/K3" } }));
badCp("cp-table-degree-3", "E_OUT_OF_RANGE", CP + "/fit/degree", tableCp(null, { fit: { degree: 3, tolerance: { value: 5, unit: "%" } } }));
badCp("cp-table-no-fit", "E_PROP_MISSING", CP + "/fit", dropK(tableCp(), "fit"));
badCp("cp-table-too-few-points-for-the-degree", "E_FIT", CP + "/fit/degree", tableCp([[250, 1.9], [1500, 5.4]]));
badCp("cp-table-fit-too-far", "E_FIT", CP + "/fit", tableCp(null, { fit: { degree: 1, tolerance: { value: 1, unit: "%" } } }));
badCp("cp-table-point-wrong-key", "E_UNITS", CP + "/points/0/heatCapacity", tableCp(null, { points: [{ temperature: { value: 250, unit: "K" }, conductivity: { value: 1.9, unit: "MJ/m3/K" } }, { temperature: { value: 500, unit: "K" }, heatCapacity: { value: 2.9, unit: "MJ/m3/K" } }, { temperature: { value: 800, unit: "K" }, heatCapacity: { value: 4, unit: "MJ/m3/K" } }] }));
badT("cp-initial-temperature-outside-polynomial-range", "E_OUT_OF_RANGE", "/transient/initialTemperature", (c) => { c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = polyCp({ validRange: { min: { value: 400, unit: "K" }, max: { value: 1500, unit: "K" } } }); });
badT("time-too-much-work", "E_TIME", "/transient/timeStep", (c) => {
  c.mesh = { fuelCells: 2000, claddingCells: 100 };
  c.transient.timeStep = { value: 0.05, unit: "ms" };
});
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
// a transient that starts from the pin's steady operating state instead of a uniform temperature
{
  const c = pulse();
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "kW/m" };
  add("good", "pulse-steady-start", c, {});
}
badT("transient-initial-both", "E_TRANSIENT_INCOMPLETE", "/transient/initialSteadyLinearHeatRate", (c) => (c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "kW/m" }));
badT("transient-initial-neither", "E_TRANSIENT_INCOMPLETE", "/transient/initialTemperature", (c) => delete c.transient.initialTemperature);
const badS = (name, code, field, mutate) =>
  badT(name, code, field, (c) => {
    delete c.transient.initialTemperature;
    c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "kW/m" };
    mutate(c);
  });
badS("range-negative-initial-steady-power", "E_OUT_OF_RANGE", "/transient/initialSteadyLinearHeatRate", (c) => (c.transient.initialSteadyLinearHeatRate = { value: -1, unit: "kW/m" }));
badS("units-initial-steady-power-wrong-dimension", "E_UNITS", "/transient/initialSteadyLinearHeatRate", (c) => (c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "K" }));
badS("range-steady-start-outside-heat-capacity-range", "E_OUT_OF_RANGE", "/transient/initialSteadyLinearHeatRate", (c) => {
  c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: 0.9, unit: "MJ/m3/K" }, b: { value: 0.00417, unit: "MJ/m3/K2" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 600, unit: "K" } }, source: "synthetic" };
});
badS("range-no-steady-state-at-this-power", "E_OUT_OF_RANGE", "/transient/initialSteadyLinearHeatRate", (c) => {
  c.materials.fuel.sets["thermal.conductivity"] = { model: "linear", a: { value: 4, unit: "W/m/K" }, b: { value: -0.0035, unit: "W/m/K2" }, validRange: { min: { value: 300, unit: "K" }, max: { value: 1000, unit: "K" } }, source: "synthetic" };
  c.transient.initialSteadyLinearHeatRate = { value: 60, unit: "kW/m" };
});
// a transient whose power history is generated by point kinetics (examples/synthetic-pulse-kinetics.json)
const kinBase = JSON.parse(fs.readFileSync(path.join(root, "examples", "synthetic-pulse-kinetics.json"), "utf8"));
const kin = () => JSON.parse(JSON.stringify(kinBase));
add("good", "pulse-point-kinetics", kin(), {});
{
  const c = kin();
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "W/m" }; // 1 kW x 1 / (100 pins x 0.5 m)
  add("good", "pulse-point-kinetics-steady-start", c, {});
}
{
  const c = kin();
  c.transient.pointKinetics.feedback = { model: "linear", a: { value: -9e-5, unit: "dk/k/K" }, b: { value: -2e-8, unit: "dk/k/K2" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 1500, unit: "K" } }, source: "synthetic" };
  add("good", "pulse-point-kinetics-linear-feedback", c, {});
}
const badK = (name, code, field, mutate) => {
  const c = kin();
  mutate(c);
  add("bad", name, c, { code, field });
};
badK("kinetics-both-power-sources", "E_TRANSIENT_INCOMPLETE", "/transient/pointKinetics", (c) => {
  c.transient.powerHistory = pulse().transient.powerHistory;
  c.transient.powerHistory[c.transient.powerHistory.length - 1].time = { value: 60, unit: "ms" };
});
badK("kinetics-no-power-source", "E_TRANSIENT_INCOMPLETE", "/transient/powerHistory", (c) => delete c.transient.pointKinetics);
badK("kinetics-no-feedback", "E_TRANSIENT_INCOMPLETE", "/transient/pointKinetics/feedback", (c) => delete c.transient.pointKinetics.feedback);
badK("kinetics-feedback-positive", "E_OUT_OF_RANGE", "/transient/pointKinetics/feedback/coefficient", (c) => (c.transient.pointKinetics.feedback.coefficient = { value: 1e-4, unit: "dk/k/K" }));
badK("kinetics-feedback-no-source", "E_PROP_MISSING", "/transient/pointKinetics/feedback/source", (c) => delete c.transient.pointKinetics.feedback.source);
badK("kinetics-feedback-linear-no-range", "E_PROP_MISSING", "/transient/pointKinetics/feedback/validRange", (c) => (c.transient.pointKinetics.feedback = { model: "linear", a: { value: -9e-5, unit: "dk/k/K" }, b: { value: -2e-8, unit: "dk/k/K2" }, source: "synthetic" }));
badK("kinetics-groups-no-source", "E_PROP_MISSING", "/transient/pointKinetics/delayedSource", (c) => delete c.transient.pointKinetics.delayedSource);
badK("kinetics-dollars-without-groups", "E_UNITS", "/transient/pointKinetics/reactivityInsertion", (c) => (c.transient.pointKinetics.delayedGroups = []));
badK("kinetics-reactivity-negative", "E_OUT_OF_RANGE", "/transient/pointKinetics/reactivityInsertion", (c) => (c.transient.pointKinetics.reactivityInsertion = { value: -1, unit: "$" }));
badK("kinetics-reactivity-implausible", "E_OUT_OF_RANGE", "/transient/pointKinetics/reactivityInsertion", (c) => (c.transient.pointKinetics.reactivityInsertion = { value: 20000, unit: "pcm" }));
badK("kinetics-generation-time-wrong-unit", "E_UNITS", "/transient/pointKinetics/promptGenerationTime", (c) => (c.transient.pointKinetics.promptGenerationTime = { value: 40, unit: "K" }));
badK("kinetics-delayed-fraction-too-big", "E_OUT_OF_RANGE", "/transient/pointKinetics/delayedGroups/0/fraction", (c) => (c.transient.pointKinetics.delayedGroups[0].fraction = { value: 0.5, unit: "1" }));
badK("kinetics-pins-zero", "E_OUT_OF_RANGE", "/transient/pointKinetics/core/pins", (c) => (c.transient.pointKinetics.core.pins = 0));
badK("kinetics-insertion-longer-than-run", "E_TIME", "/transient/pointKinetics/insertionTime", (c) => (c.transient.pointKinetics.insertionTime = { value: 1, unit: "s" }));
badK("kinetics-pulse-not-in-window", "E_KINETICS", "/transient/pointKinetics", (c) => (c.transient.pointKinetics.initialPower = { value: 1e-15, unit: "W" }));
badK("kinetics-feedback-range-left", "E_OUT_OF_RANGE", "/transient/pointKinetics/feedback/validRange", (c) => (c.transient.pointKinetics.feedback = { model: "linear", a: { value: -9e-5, unit: "dk/k/K" }, b: { value: -2e-8, unit: "dk/k/K2" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 400, unit: "K" } }, source: "synthetic" }));
badK("kinetics-steady-start-mismatch", "E_OUT_OF_RANGE", "/transient/initialSteadyLinearHeatRate", (c) => {
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = { value: 25, unit: "W/m" };
});

// conductivity as a polynomial or as a fitted table (docs/conductivity-models.md)
const polyFuel = (extra = {}) => ({ model: "polynomial", a: { value: 2, unit: "W/m/K" }, b: { value: 0.003, unit: "W/m/K2" }, c: { value: -1.2e-6, unit: "W/m/K3" }, d: { value: 2e-10, unit: "W/m/K4" }, validRange: { min: { value: 500, unit: "K" }, max: { value: 2500, unit: "K" } }, source: "synthetic: a cubic chosen to exercise the polynomial model", ...extra });
const tableFuel = (extra = {}) => ({ model: "table", points: [[300, 2.8], [600, 3.5], [900, 3.9], [1200, 4.05], [1500, 4.1]].map(([T, k]) => ({ temperature: { value: T, unit: "K" }, conductivity: { value: k, unit: "W/m/K" } })), fit: { degree: 3, tolerance: { value: 2, unit: "%" } }, source: "synthetic: a table chosen to exercise the table model", ...extra });
const withFuelK = (set) => { const c = clone(); c.materials.fuel.sets["thermal.conductivity"] = set; return c; };
add("good", "cubic-conductivity", withFuelK(polyFuel()), {});
add("good", "cubic-conductivity-zero-terms", withFuelK(polyFuel({ c: { value: 0, unit: "W/m/K3" }, d: { value: 0, unit: "W/m/K4" } })), {});
add("good", "table-conductivity", withFuelK(tableFuel()), {});
add("good", "table-conductivity-celsius", withFuelK(tableFuel({ points: [[27, 2.8], [327, 3.5], [627, 3.9], [927, 4.05], [1227, 4.1]].map(([T, k]) => ({ temperature: { value: T, unit: "degC" }, conductivity: { value: k, unit: "W/m/K" } })) })), {});
const badK2 = (name, code, field, set) => { const c = withFuelK(set); add("bad", name, c, { code, field }); };
const dropKey = (o, k) => { const x = JSON.parse(JSON.stringify(o)); delete x[k]; return x; };
badK2("polynomial-missing-coefficient", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/d", dropKey(polyFuel(), "d"));
badK2("polynomial-no-source", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/source", dropKey(polyFuel(), "source"));
badK2("polynomial-no-range", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/validRange", dropKey(polyFuel(), "validRange"));
badK2("polynomial-wrong-unit", "E_UNITS", "/materials/fuel/sets/thermal.conductivity/c", polyFuel({ c: { value: -1.2e-6, unit: "W/m/K2" } }));
badK2("polynomial-negative-inside-range", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity", polyFuel({ c: { value: -4e-6, unit: "W/m/K3" }, d: { value: 0, unit: "W/m/K4" } }));
badK2("polynomial-range-inverted", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/validRange", polyFuel({ validRange: { min: { value: 2500, unit: "K" }, max: { value: 500, unit: "K" } } }));
badK2("table-no-fit", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/fit", dropKey(tableFuel(), "fit"));
badK2("table-no-source", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/source", dropKey(tableFuel(), "source"));
badK2("table-no-points", "E_PROP_MISSING", "/materials/fuel/sets/thermal.conductivity/points", dropKey(tableFuel(), "points"));
badK2("table-degree-4", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/fit/degree", tableFuel({ fit: { degree: 4, tolerance: { value: 2, unit: "%" } } }));
badK2("table-tolerance-zero", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/fit/tolerance", tableFuel({ fit: { degree: 3, tolerance: { value: 0, unit: "%" } } }));
badK2("table-temperatures-not-increasing", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/points/2/temperature", tableFuel({ points: [[300, 2.8], [600, 3.5], [500, 3.9], [1200, 4.05], [1500, 4.1]].map(([T, k]) => ({ temperature: { value: T, unit: "K" }, conductivity: { value: k, unit: "W/m/K" } })) }));
badK2("table-conductivity-not-positive", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/points/1/conductivity", tableFuel({ points: [[300, 2.8], [600, 0], [900, 3.9], [1200, 4.05], [1500, 4.1]].map(([T, k]) => ({ temperature: { value: T, unit: "K" }, conductivity: { value: k, unit: "W/m/K" } })) }));
badK2("table-one-point", "E_OUT_OF_RANGE", "/materials/fuel/sets/thermal.conductivity/points", tableFuel({ points: [{ temperature: { value: 300, unit: "K" }, conductivity: { value: 2.8, unit: "W/m/K" } }] }));
badK2("table-too-few-points-for-the-degree", "E_FIT", "/materials/fuel/sets/thermal.conductivity/fit/degree", tableFuel({ points: [[300, 2.8], [900, 3.9], [1500, 4.1]].map(([T, k]) => ({ temperature: { value: T, unit: "K" }, conductivity: { value: k, unit: "W/m/K" } })) }));
badK2("table-fit-too-far", "E_FIT", "/materials/fuel/sets/thermal.conductivity/fit", tableFuel({ fit: { degree: 1, tolerance: { value: 1, unit: "%" } } }));

// temperature limits as case inputs (docs/temperature-limits.md)
const rule = (extra = {}) => ({ name: "Fuel limit", region: "fuel", maxTemperature: { value: 1150, unit: "degC" }, source: "synthetic: a limit chosen to exercise the rules", ...extra });
const withLimits = (limits) => { const c = clone(); c.limits = limits; return c; };
add("good", "limits-triga-fuel", withLimits([rule({ name: "Fuel limit, cladding at most 500 C", whileCladding: { atMost: { value: 500, unit: "degC" } } }), rule({ name: "Fuel limit, cladding above 500 C", maxTemperature: { value: 950, unit: "degC" }, whileCladding: { above: { value: 500, unit: "degC" } } })]), {});
add("good", "limits-cladding-and-band", withLimits([rule({ name: "Cladding limit", region: "cladding", maxTemperature: { value: 600, unit: "K" } }), rule({ name: "Fuel band", whileCladding: { above: { value: 400, unit: "K" }, atMost: { value: 800, unit: "K" } } })]), {});
const badL = (name, code, field, limits) => add("bad", name, withLimits(limits), { code, field });
const dropL = (o, k) => { const x = JSON.parse(JSON.stringify(o)); delete x[k]; return x; };
badL("limits-not-a-list", "E_SCHEMA_INVALID", "/limits", { name: "x" });
badL("limits-empty-list", "E_SCHEMA_INVALID", "/limits", []);
badL("limits-too-many", "E_SCHEMA_INVALID", "/limits", Array.from({ length: 11 }, (_, i) => rule({ name: "Limit " + i })));
badL("limits-no-source", "E_PROP_MISSING", "/limits/0/source", [dropL(rule(), "source")]);
badL("limits-blank-source", "E_PROP_MISSING", "/limits/0/source", [rule({ source: "   " })]);
badL("limits-no-maximum", "E_PROP_MISSING", "/limits/0/maxTemperature", [dropL(rule(), "maxTemperature")]);
badL("limits-no-name", "E_SCHEMA_INVALID", "/limits/0/name", [dropL(rule(), "name")]);
badL("limits-duplicate-name", "E_SCHEMA_INVALID", "/limits/1/name", [rule(), rule()]);
badL("limits-bad-region", "E_SCHEMA_INVALID", "/limits/0/region", [rule({ region: "gap" })]);
badL("limits-maximum-zero", "E_OUT_OF_RANGE", "/limits/0/maxTemperature", [rule({ maxTemperature: { value: 0, unit: "K" } })]);
badL("limits-maximum-too-hot", "E_OUT_OF_RANGE", "/limits/0/maxTemperature", [rule({ maxTemperature: { value: 20000, unit: "K" } })]);
badL("limits-maximum-wrong-unit", "E_UNITS", "/limits/0/maxTemperature", [rule({ maxTemperature: { value: 1150, unit: "W/m" } })]);
badL("limits-condition-on-cladding-rule", "E_SCHEMA_INVALID", "/limits/0/whileCladding", [rule({ region: "cladding", whileCladding: { atMost: { value: 500, unit: "degC" } } })]);
badL("limits-condition-empty", "E_SCHEMA_INVALID", "/limits/0/whileCladding", [rule({ whileCladding: {} })]);
badL("limits-condition-never-holds", "E_OUT_OF_RANGE", "/limits/0/whileCladding", [rule({ whileCladding: { above: { value: 800, unit: "K" }, atMost: { value: 700, unit: "K" } } })]);
badL("limits-condition-zero", "E_OUT_OF_RANGE", "/limits/0/whileCladding/above", [rule({ whileCladding: { above: { value: 0, unit: "K" } } })]);

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
