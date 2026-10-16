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
// ---- a boundary that changes with time (plan 11 B1)
const qv = (v, u) => ({ value: v, unit: u });
const convPoint = (ms, Tb, h) => ({ time: qv(ms, "ms"), bulkTemperature: qv(Tb, "K"), heatTransferCoefficient: qv(h, "W/m2/K") });
const convHistory = () => [convPoint(0, 300, 30000), convPoint(40, 300, 30000), convPoint(50, 300, 1000), convPoint(100, 300, 1000)];
const withHistory = (hist) => { const c = pulse(); c.transient.boundaryHistory = hist; return c; };
add("good", "pulse-boundary-history", withHistory(convHistory()), {});
{
  const c = withHistory([{ time: qv(0, "ms"), surfaceTemperature: qv(300, "K") }, { time: qv(100, "ms"), surfaceTemperature: qv(400, "K") }]);
  c.boundary = { surfaceTemperature: qv(300, "K") };
  add("good", "pulse-boundary-history-wall", c, {});
}
{
  // a hot pin cooling: no heat source at all is allowed when the boundary history is stated
  const c = withHistory(convHistory());
  c.transient.powerHistory = [{ time: qv(0, "ms"), linearHeatRate: qv(0, "W/m") }, { time: qv(100, "ms"), linearHeatRate: qv(0, "W/m") }];
  c.transient.initialTemperature = qv(800, "K");
  add("good", "pulse-boundary-history-no-power", c, {});
}
{
  // a steady start: the history begins at the case's own boundary
  const c = withHistory(convHistory());
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = qv(20, "kW/m");
  add("good", "pulse-boundary-history-steady-start", c, {});
}
badT("boundary-history-not-a-list", "E_SCHEMA_INVALID", "/transient/boundaryHistory", (c) => (c.transient.boundaryHistory = { time: 0 }));
badT("boundary-history-one-point", "E_TIME", "/transient/boundaryHistory", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000)]));
badT("boundary-history-not-from-zero", "E_TIME", "/transient/boundaryHistory/0/time", (c) => (c.transient.boundaryHistory = [convPoint(10, 300, 30000), convPoint(100, 300, 1000)]));
badT("boundary-history-unordered", "E_TIME", "/transient/boundaryHistory/2/time", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), convPoint(50, 300, 30000), convPoint(50, 300, 1000), convPoint(100, 300, 1000)]));
badT("boundary-history-stops-short", "E_TIME", "/transient/boundaryHistory", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), convPoint(60, 300, 1000)]));
badT("boundary-history-zero-h", "E_OUT_OF_RANGE", "/transient/boundaryHistory/1/heatTransferCoefficient", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), convPoint(100, 300, 0)]));
badT("boundary-history-no-h", "E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory/1/heatTransferCoefficient", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), { time: qv(100, "ms"), bulkTemperature: qv(300, "K") }]));
badT("boundary-history-mixed-forms", "E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory/1", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), { time: qv(100, "ms"), surfaceTemperature: qv(300, "K") }]));
badT("boundary-history-both-forms-in-a-point", "E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory/0", (c) => (c.transient.boundaryHistory = [{ ...convPoint(0, 300, 30000), surfaceTemperature: qv(300, "K") }, convPoint(100, 300, 30000)]));
badT("boundary-history-unknown-key", "E_SCHEMA_INVALID", "/transient/boundaryHistory/1/emissivity", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), { ...convPoint(100, 300, 30000), emissivity: 0.8 }]));
badT("boundary-history-wrong-unit", "E_UNITS", "/transient/boundaryHistory/1/bulkTemperature", (c) => (c.transient.boundaryHistory = [convPoint(0, 300, 30000), { ...convPoint(100, 300, 30000), bulkTemperature: qv(300, "W/m") }]));
badT("boundary-history-form-differs-from-case", "E_BOUNDARY_INCOMPLETE", "/transient/boundaryHistory", (c) => (c.transient.boundaryHistory = [{ time: qv(0, "ms"), surfaceTemperature: qv(300, "K") }, { time: qv(100, "ms"), surfaceTemperature: qv(400, "K") }]));
badT("boundary-history-steady-start-differs", "E_TRANSIENT_INCOMPLETE", "/transient/boundaryHistory/0", (c) => {
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = qv(20, "kW/m");
  c.transient.boundaryHistory = [convPoint(0, 350, 30000), convPoint(100, 350, 1000)];
});
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
// the mechanical property sets of plan 09 M1: both solids carry them in these vectors (a case that asks for mechanics without them gets E_PROP_MISSING as well: tests/mechanicalSets.test.ts)
const elasticity = (extra = {}) => ({ model: "constant", youngModulus: { value: 100, unit: "GPa" }, poissonRatio: { value: 0.3, unit: "1" }, source: "synthetic: chosen for the vectors, not a sourced property", ...extra });
const expansionSet = (extra = {}) => ({ linearExpansion: { value: 10, unit: "ppm/K" }, source: "synthetic: chosen for the vectors, not a sourced property", ...extra });
const withMech = (c, over = {}) => {
  for (const r of ["fuel", "cladding"]) {
    c.materials[r].sets["mechanical.elasticity"] = elasticity();
    c.materials[r].sets["mechanical.thermalExpansion"] = expansionSet();
  }
  Object.assign(c.materials.fuel.sets, over);
  return c;
};
bad("mechanics-section-missing", "E_PROP_MISSING", "/mechanics", (c) => (withMech(c), (c.assumptions.thermalOnly = false)));
add("good", "mechanical-sets", withMech(clone()), {});
bad("mechanical-elasticity-no-source", "E_PROP_MISSING", "/materials/fuel/sets/mechanical.elasticity/source", (c) => withMech(c, { "mechanical.elasticity": elasticity({ source: "" }) }));
bad("mechanical-poisson-too-high", "E_OUT_OF_RANGE", "/materials/fuel/sets/mechanical.elasticity/poissonRatio", (c) => withMech(c, { "mechanical.elasticity": elasticity({ poissonRatio: { value: 0.5, unit: "1" } }) }));
bad("mechanical-modulus-wrong-unit", "E_UNITS", "/materials/fuel/sets/mechanical.elasticity/youngModulus", (c) => withMech(c, { "mechanical.elasticity": elasticity({ youngModulus: { value: 100, unit: "W/m/K" } }) }));
bad("mechanical-modulus-too-small", "E_OUT_OF_RANGE", "/materials/fuel/sets/mechanical.elasticity/youngModulus", (c) => withMech(c, { "mechanical.elasticity": elasticity({ youngModulus: { value: 100, unit: "Pa" } }) }));
bad("mechanical-linear-no-range", "E_PROP_MISSING", "/materials/fuel/sets/mechanical.elasticity/validRange", (c) => withMech(c, { "mechanical.elasticity": { model: "linear", a: { value: 100, unit: "GPa" }, b: { value: -0.01, unit: "GPa/K" }, poissonRatio: { value: 0.3, unit: "1" }, source: "synthetic: chosen for the vectors" } }));
bad("mechanical-elasticity-unknown-model", "E_UNSUPPORTED", "/materials/fuel/sets/mechanical.elasticity/model", (c) => withMech(c, { "mechanical.elasticity": elasticity({ model: "table" }) }));
bad("mechanical-expansion-no-source", "E_PROP_MISSING", "/materials/fuel/sets/mechanical.thermalExpansion/source", (c) => withMech(c, { "mechanical.thermalExpansion": expansionSet({ source: " " }) }));
bad("mechanical-expansion-negative", "E_OUT_OF_RANGE", "/materials/fuel/sets/mechanical.thermalExpansion/linearExpansion", (c) => withMech(c, { "mechanical.thermalExpansion": expansionSet({ linearExpansion: { value: -10, unit: "ppm/K" } }) }));
bad("unsupported-power-shape", "E_UNSUPPORTED", "/power/radialShape", (c) => (c.power.radialShape = "edge-depressed"));
bad("unsupported-conductivity-model", "E_UNSUPPORTED", "/materials/fuel/sets/thermal.conductivity/model", (c) => (c.materials.fuel.sets["thermal.conductivity"].model = "expression"));
bad("mesh-fuel-low", "E_MESH", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 2));
bad("mesh-cladding-low", "E_MESH", "/mesh/claddingCells", (c) => (c.mesh.claddingCells = 1));
bad("mesh-fuel-high", "E_MESH", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 1000000000));
bad("mesh-cladding-high", "E_MESH", "/mesh/claddingCells", (c) => (c.mesh.claddingCells = 20001));

// ---- burnup and hot dimensions (plans 10 and 07): one fault each
const nfi = (c) => (c.materials.fuel.sets["thermal.conductivity"] = { model: "uo2-nfi", densityFraction: { value: 95, unit: "%" }, source: "NUREG/CR-7024 Eq. 2.3-10 and 2.3-11 (FRAPCON-3.4 modified NFI)" });
const burnup = (c, over = {}) => (c.burnup = { value: { value: 40, unit: "MWd/kgHM" }, basis: "heavy-metal", source: "chosen for the study", ...over });
const hotSet = (c, fuelAlpha) => (c.hotDimensions = {
  referenceTemperature: { value: 20, unit: "degC" },
  fuel: { linearExpansion: fuelAlpha, source: "synthetic: a typical order of magnitude" },
  cladding: { linearExpansion: { value: 10, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
});
bad("burnup-model-without-burnup", "E_PROP_MISSING", "/burnup", (c) => nfi(c));
bad("burnup-without-model", "E_UNSUPPORTED", "/burnup", (c) => burnup(c));
bad("burnup-oxide-basis", "E_UNSUPPORTED", "/burnup/basis", (c) => (nfi(c), burnup(c, { basis: "oxide" })));
bad("burnup-above-range", "E_OUT_OF_RANGE", "/burnup/value", (c) => (nfi(c), burnup(c, { value: { value: 63, unit: "MWd/kgHM" } })));
bad("hot-dimensions-closes-gap", "E_GEOMETRY", "/hotDimensions", (c) => hotSet(c, { value: 9e-4, unit: "1/K" }));
bad("hot-dimensions-no-source", "E_PROP_MISSING", "/hotDimensions/fuel/source", (c) => (hotSet(c, { value: 12, unit: "ppm/K" }), delete c.hotDimensions.fuel.source));
{
  const c = pulse();
  hotSet(c, { value: 12, unit: "ppm/K" });
  add("bad", "hot-dimensions-transient", c, { code: "E_UNSUPPORTED", field: "/hotDimensions" });
}

// ---- the mechanics section (plan 09 M2): one good case and one fault each
const mech = (c, extra = {}) => { withMech(c); c.assumptions.thermalOnly = false; c.mechanics = { referenceTemperature: { value: 300, unit: "K" }, plane: "free-axial", contact: { penaltyFactor: { value: 0.3, unit: "1" } }, coolantPressure: { value: 0.1, unit: "MPa" }, ...extra }; return c; };
add("good", "mechanics-section", mech(clone()), {});
{
  // a modulus stated as a law of temperature over a range the fuel leaves (the fuel runs about 700 to 1300 K here): applied as given, with a warning
  const c = mech(clone());
  c.materials.fuel.sets["mechanical.elasticity"] = { model: "linear", a: { value: 250, unit: "GPa" }, b: { value: -0.05, unit: "GPa/K" }, poissonRatio: { value: 0.3, unit: "1" }, validRange: { min: { value: 300, unit: "K" }, max: { value: 400, unit: "K" } }, source: "synthetic: chosen for the vectors" };
  add("good", "mechanics-elasticity-range-warning", c, { warnings: ["W_ELASTICITY_RANGE"] });
}
add("good", "mechanics-internal-pressure-constant", (() => { const c = mech(clone()); c.mechanics.internalPressure = { model: "constant", pressure: { value: 5, unit: "MPa" }, source: "a synthetic input" }; return c; })(), {});
add("good", "mechanics-internal-pressure-hydrogen", (() => { const c = mech(clone()); c.mechanics.internalPressure = { model: "hydrogen-zrh", hZrRatio: { value: 1.65, unit: "1" }, fuelTemperature: "peak", source: "Simnad GA E-117-833 section 2.4" }; return c; })(), {});
bad("mechanics-internal-pressure-no-source", "E_PROP_MISSING", "/mechanics/internalPressure/source", (c) => { mech(c); c.mechanics.internalPressure = { model: "constant", pressure: { value: 5, unit: "MPa" } }; });
bad("mechanics-internal-pressure-zero", "E_OUT_OF_RANGE", "/mechanics/internalPressure/pressure", (c) => { mech(c); c.mechanics.internalPressure = { model: "constant", pressure: { value: 0, unit: "MPa" }, source: "x" }; });
bad("mechanics-internal-pressure-unknown-model", "E_UNSUPPORTED", "/mechanics/internalPressure/model", (c) => { mech(c); c.mechanics.internalPressure = { model: "plenum", source: "x" }; });
bad("mechanics-hydrogen-ratio-out-of-range", "E_OUT_OF_RANGE", "/mechanics/internalPressure/hZrRatio", (c) => { mech(c); c.mechanics.internalPressure = { model: "hydrogen-zrh", hZrRatio: { value: 2.1, unit: "1" }, fuelTemperature: "peak", source: "x" }; });
bad("mechanics-hydrogen-temperature-missing", "E_PROP_MISSING", "/mechanics/internalPressure/fuelTemperature", (c) => { mech(c); c.mechanics.internalPressure = { model: "hydrogen-zrh", hZrRatio: { value: 1.65, unit: "1" }, source: "x" }; });
const slim = (extra = {}) => ({ name: "clad-flat", region: "cladding", table: [{ temperature: { value: 300, unit: "K" }, strength: { value: 500, unit: "MPa" } }, { temperature: { value: 1500, unit: "K" }, strength: { value: 300, unit: "MPa" } }], source: "a synthetic table", ...extra });
add("good", "mechanics-stress-limit", (() => { const c = mech(clone()); c.mechanics.stressLimits = [slim()]; return c; })(), {});
bad("mechanics-stress-limit-no-source", "E_PROP_MISSING", "/mechanics/stressLimits/0/source", (c) => { mech(c); c.mechanics.stressLimits = [slim({ source: undefined })]; });
bad("mechanics-stress-limit-unordered-table", "E_OUT_OF_RANGE", "/mechanics/stressLimits/0/table/1/temperature", (c) => { mech(c); c.mechanics.stressLimits = [slim({ table: [{ temperature: { value: 600, unit: "K" }, strength: { value: 500, unit: "MPa" } }, { temperature: { value: 300, unit: "K" }, strength: { value: 400, unit: "MPa" } }] })]; });
bad("mechanics-stress-limit-bad-region", "E_SCHEMA_INVALID", "/mechanics/stressLimits/0/region", (c) => { mech(c); c.mechanics.stressLimits = [slim({ region: "gap" })]; });
bad("mechanics-reference-temperature-missing", "E_PROP_MISSING", "/mechanics/referenceTemperature", (c) => { mech(c); delete c.mechanics.referenceTemperature; });
bad("mechanics-reference-temperature-zero", "E_OUT_OF_RANGE", "/mechanics/referenceTemperature", (c) => { mech(c); c.mechanics.referenceTemperature = { value: 0, unit: "K" }; });
bad("mechanics-plane-missing", "E_PROP_MISSING", "/mechanics/plane", (c) => { mech(c); delete c.mechanics.plane; });
bad("mechanics-plane-stress", "E_UNSUPPORTED", "/mechanics/plane", (c) => { mech(c); c.mechanics.plane = "plane-stress"; });
bad("mechanics-contact-missing", "E_PROP_MISSING", "/mechanics/contact", (c) => { mech(c); delete c.mechanics.contact; });
bad("mechanics-penalty-missing", "E_PROP_MISSING", "/mechanics/contact/penaltyFactor", (c) => { mech(c); delete c.mechanics.contact.penaltyFactor; });
bad("mechanics-penalty-too-high", "E_OUT_OF_RANGE", "/mechanics/contact/penaltyFactor", (c) => { mech(c); c.mechanics.contact.penaltyFactor = { value: 10, unit: "1" }; });
bad("mechanics-penalty-too-low", "E_OUT_OF_RANGE", "/mechanics/contact/penaltyFactor", (c) => { mech(c); c.mechanics.contact.penaltyFactor = { value: 0.01, unit: "1" }; });
bad("mechanics-coolant-pressure-missing", "E_PROP_MISSING", "/mechanics/coolantPressure", (c) => { mech(c); delete c.mechanics.coolantPressure; });
bad("mechanics-coolant-pressure-negative", "E_OUT_OF_RANGE", "/mechanics/coolantPressure", (c) => { mech(c); c.mechanics.coolantPressure = { value: -1, unit: "MPa" }; });
bad("mechanics-unknown-key", "E_SCHEMA_INVALID", "/mechanics/creep", (c) => { mech(c, { creep: true }); });
bad("mechanics-with-thermal-only-true", "E_SCHEMA_INVALID", "/assumptions/thermalOnly", (c) => { mech(c); c.assumptions.thermalOnly = true; });
bad("mechanics-with-hot-dimensions", "E_UNSUPPORTED", "/hotDimensions", (c) => {
  mech(c);
  c.hotDimensions = {
    referenceTemperature: { value: 20, unit: "degC" },
    fuel: { linearExpansion: { value: 12, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
    cladding: { linearExpansion: { value: 10, unit: "ppm/K" }, source: "synthetic: a typical order of magnitude" },
  };
});
bad("mechanics-with-burnup", "E_UNSUPPORTED", "/burnup", (c) => { mech(c); nfi(c); burnup(c); });
{
  const c = pulse();
  mech(c);
  add("bad", "mechanics-in-transient", c, { code: "E_UNSUPPORTED", field: "/mechanics" });
}


// ---- the axial stack (plan 12, A1): four good vectors and the refusals
const axialBase = (over = {}) => ({ length: qv(0.381, "m"), slices: 10, powerShape: { kind: "cosine" }, ...over });
const stack = (axial) => { const c = clone(); c.axial = axial; return c; };
const bt = (z, Tb, h) => ({ height: qv(z, "m"), bulkTemperature: qv(Tb, "K"), heatTransferCoefficient: qv(h, "W/m2/K") });
const wallPt = (z, T) => ({ height: qv(z, "m"), surfaceTemperature: qv(T, "K") });
add("good", "axial-cosine", stack(axialBase()), {});
add("good", "axial-table-shape-coolant-rise", stack(axialBase({ powerShape: { kind: "table", points: [[0, 0.4], [0.1, 0.9], [0.19, 1.3], [0.29, 1.0], [0.381, 0.5]].map(([z, r]) => ({ position: qv(z, "m"), relativePower: qv(r, "1") })) }, boundary: [bt(0, 573, 30000), bt(0.381, 633, 30000)] })), {});
{
  const c = stack(axialBase({ boundary: [wallPt(0, 573), wallPt(0.381, 613)] }));
  delete c.boundary.bulkTemperature;
  delete c.boundary.heatTransferCoefficient;
  c.boundary.surfaceTemperature = qv(573, "K");
  add("good", "axial-prescribed-wall", c, {});
}
add("good", "axial-flat-shape", stack(axialBase({ powerShape: { kind: "flat" }, slices: 5 })), {});
add("good", "axial-shape-step-warning", stack(axialBase({ slices: 3 })), { warnings: ["W_AXIAL_SHAPE_STEP"] });
add("good", "axial-short-pin-conduction-warning", stack(axialBase({ length: qv(0.05, "m"), slices: 20 })), { warnings: ["W_AXIAL_CONDUCTION"] });
const badA = (name, code, field, axial, mutate) => { const c = stack(axial); if (mutate) mutate(c); add("bad", name, c, { code, field }); };
bad("axial-not-an-object", "E_SCHEMA_INVALID", "/axial", (c) => (c.axial = [1, 2]));
badA("axial-unknown-key", "E_AXIAL", "/axial/emissivity", axialBase({ emissivity: 0.8 }));
badA("axial-length-missing", "E_AXIAL", "/axial/length", (() => { const a = axialBase(); delete a.length; return a; })());
badA("axial-length-wrong-unit", "E_UNITS", "/axial/length", axialBase({ length: qv(0.381, "W/m") }));
badA("axial-length-out-of-range", "E_AXIAL", "/axial/length", axialBase({ length: qv(381, "m") }));
badA("axial-slices-missing", "E_AXIAL", "/axial/slices", (() => { const a = axialBase(); delete a.slices; return a; })());
badA("axial-slices-too-few", "E_AXIAL", "/axial/slices", axialBase({ slices: 2 }));
badA("axial-slices-too-many", "E_AXIAL", "/axial/slices", axialBase({ slices: 51 }));
badA("axial-slices-not-integer", "E_AXIAL", "/axial/slices", axialBase({ slices: 10.5 }));
badA("axial-shape-missing", "E_AXIAL", "/axial/powerShape", (() => { const a = axialBase(); delete a.powerShape; return a; })());
badA("axial-shape-unknown-kind", "E_AXIAL", "/axial/powerShape", axialBase({ powerShape: { kind: "gaussian" } }));
const tbl = (rows) => ({ kind: "table", points: rows.map(([z, r]) => ({ position: qv(z, "m"), relativePower: qv(r, "1") })) });
badA("axial-shape-table-not-from-bottom", "E_AXIAL", "/axial/powerShape/points/0/position", axialBase({ powerShape: tbl([[0.05, 1], [0.381, 1]]) }));
badA("axial-shape-table-stops-short", "E_AXIAL", "/axial/powerShape/points/1/position", axialBase({ powerShape: tbl([[0, 1], [0.3, 1]]) }));
badA("axial-shape-table-unordered", "E_AXIAL", "/axial/powerShape/points/2/position", axialBase({ powerShape: tbl([[0, 1], [0.2, 1], [0.2, 1], [0.381, 1]]) }));
badA("axial-shape-negative-power", "E_AXIAL", "/axial/powerShape/points/1/relativePower", axialBase({ powerShape: tbl([[0, 1], [0.2, -0.5], [0.381, 1]]) }));
badA("axial-shape-all-zero", "E_AXIAL", "/axial/powerShape/points", axialBase({ powerShape: tbl([[0, 0], [0.381, 0]]) }));
badA("axial-boundary-one-point", "E_AXIAL", "/axial/boundary", axialBase({ boundary: [bt(0, 573, 30000)] }));
badA("axial-boundary-not-from-bottom", "E_AXIAL", "/axial/boundary/0/height", axialBase({ boundary: [bt(0.01, 573, 30000), bt(0.381, 600, 30000)] }));
badA("axial-boundary-stops-short", "E_AXIAL", "/axial/boundary/1/height", axialBase({ boundary: [bt(0, 573, 30000), bt(0.3, 600, 30000)] }));
badA("axial-boundary-unordered", "E_AXIAL", "/axial/boundary/2/height", axialBase({ boundary: [bt(0, 573, 30000), bt(0.2, 580, 30000), bt(0.2, 590, 30000), bt(0.381, 600, 30000)] }));
badA("axial-boundary-zero-h", "E_AXIAL", "/axial/boundary/1/heatTransferCoefficient", axialBase({ boundary: [bt(0, 573, 30000), bt(0.381, 573, 0)] }));
badA("axial-boundary-no-h", "E_AXIAL", "/axial/boundary/1", axialBase({ boundary: [bt(0, 573, 30000), { height: qv(0.381, "m"), bulkTemperature: qv(600, "K") }] }));
badA("axial-boundary-form-differs-from-case", "E_AXIAL", "/axial/boundary", axialBase({ boundary: [wallPt(0, 573), wallPt(0.381, 600)] }));
badA("axial-boundary-wrong-unit", "E_UNITS", "/axial/boundary/1/bulkTemperature", axialBase({ boundary: [bt(0, 573, 30000), { ...bt(0.381, 600, 30000), bulkTemperature: qv(600, "W/m") }] }));
// a transient on a stack (plan 12 A3): the power history is the average, each slice takes its factor of it
{
  const c = pulse();
  c.axial = axialBase();
  add("good", "axial-transient-pulse", c, {});
}
{
  const c = pulse();
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "kW/m" };
  c.axial = axialBase();
  add("good", "axial-transient-steady-start", c, {});
}
{
  const c = withHistory(convHistory());
  c.axial = axialBase();
  add("good", "axial-transient-boundary-history", c, {});
}
{
  const c = pulse();
  c.axial = axialBase({ boundary: [bt(0, 300, 30000), bt(0.381, 330, 30000)] });
  add("good", "axial-transient-coolant-table", c, {});
}
{
  // the average heat rate has a steady state inside the heat capacity's stated range, the peak slice (1.57 times as much) does not
  const c = pulse();
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = { value: 20, unit: "kW/m" };
  c.materials.fuel.sets["thermal.volumetricHeatCapacity"] = { model: "linear", a: { value: 0.9, unit: "MJ/m3/K" }, b: { value: 0.00417, unit: "MJ/m3/K2" }, validRange: { min: { value: 250, unit: "K" }, max: { value: 1200, unit: "K" } }, source: "synthetic: shaped like U-ZrH" };
  c.axial = axialBase();
  add("bad", "axial-steady-start-peak-slice-outside-heat-capacity-range", c, { code: "E_OUT_OF_RANGE", field: "/transient/initialSteadyLinearHeatRate" });
}
{
  const c = kin();
  c.axial = axialBase();
  add("bad", "axial-with-point-kinetics", c, { code: "E_UNSUPPORTED", field: "/axial" });
}
{
  const c = withHistory(convHistory());
  c.axial = axialBase({ boundary: [bt(0, 300, 30000), bt(0.381, 330, 30000)] });
  add("bad", "axial-coolant-table-with-boundary-history", c, { code: "E_UNSUPPORTED", field: "/axial/boundary" });
}
{
  const c = pulse();
  c.transient.timeStep = qv(0.001, "ms");
  c.transient.endTime = qv(100, "ms");
  c.transient.outputs = 20;
  c.axial = axialBase({ slices: 50 });
  add("bad", "axial-transient-too-much-work", c, { code: "E_TIME", field: "/transient/timeStep" });
}
{
  const c = mech(clone());
  c.axial = axialBase();
  add("bad", "axial-with-mechanics", c, { code: "E_UNSUPPORTED", field: "/axial" });
}
{
  const c = clone();
  nfi(c);
  burnup(c);
  c.axial = axialBase();
  add("bad", "axial-with-burnup", c, { code: "E_UNSUPPORTED", field: "/axial" });
}
{
  const c = clone();
  hotSet(c, { value: 12, unit: "ppm/K" });
  c.axial = axialBase();
  add("bad", "axial-with-hot-dimensions", c, { code: "E_UNSUPPORTED", field: "/axial" });
}


// ---- the plate (plan 12, A4): a slab through its thickness, the pin's numbers as thicknesses
const asPlate = (c) => {
  c.assumptions.geometry = "1D-slab";
  c.geometry = { kind: "plate", fuelHalfThickness: qv(4.1, "mm"), gapThickness: qv(0.08, "mm"), claddingThickness: qv(0.57, "mm") };
  return c;
};
add("good", "plate-steady", asPlate(clone()), {});
{
  const c = asPlate(clone());
  delete c.boundary.bulkTemperature;
  delete c.boundary.heatTransferCoefficient;
  c.boundary.surfaceTemperature = qv(600, "K");
  add("good", "plate-prescribed-wall", c, {});
}
add("good", "plate-pulse", asPlate(pulse()), {});
{
  const c = asPlate(pulse());
  delete c.transient.initialTemperature;
  c.transient.initialSteadyLinearHeatRate = qv(20, "kW/m");
  c.transient.boundaryHistory = convHistory();
  add("good", "plate-steady-start-boundary-history", c, {});
}
add("good", "plate-no-cold-gap", (() => { const c = asPlate(clone()); c.geometry.gapThickness = qv(0, "mm"); return c; })(), {});
const badP = (name, code, field, mutate) => { const c = asPlate(clone()); mutate(c); add("bad", name, c, { code, field }); };
badP("plate-with-a-radius", "E_GEOMETRY", "/geometry/fuelRadius", (c) => (c.geometry.fuelRadius = qv(4.1, "mm")));
badP("plate-with-a-hole", "E_GEOMETRY", "/geometry/fuelInnerRadius", (c) => (c.geometry.fuelInnerRadius = qv(1, "mm")));
badP("plate-missing-gap-thickness", "E_SCHEMA_INVALID", "/geometry/gapThickness", (c) => delete c.geometry.gapThickness);
badP("plate-negative-gap-thickness", "E_GEOMETRY", "/geometry/gapThickness", (c) => (c.geometry.gapThickness = qv(-0.1, "mm")));
badP("plate-zero-cladding-thickness", "E_GEOMETRY", "/geometry/claddingThickness", (c) => (c.geometry.claddingThickness = qv(0, "mm")));
badP("plate-thickness-wrong-unit", "E_UNITS", "/geometry/fuelHalfThickness", (c) => (c.geometry.fuelHalfThickness = qv(4.1, "W/m")));
badP("plate-assumed-radial", "E_UNSUPPORTED", "/assumptions/geometry", (c) => (c.assumptions.geometry = "1D-radial"));
badP("plate-with-axial-stack", "E_UNSUPPORTED", "/axial", (c) => (c.axial = axialBase()));
bad("pin-assumed-slab", "E_UNSUPPORTED", "/assumptions/geometry", (c) => (c.assumptions.geometry = "1D-slab"));
bad("geometry-unknown-kind", "E_GEOMETRY", "/geometry/kind", (c) => (c.geometry.kind = "disc"));
bad("geometry-pin-missing-radius", "E_SCHEMA_INVALID", "/geometry/claddingInnerRadius", (c) => delete c.geometry.claddingInnerRadius);
// ---- the coated particle (plan 13, T1): a sphere of a kernel and coating layers, the dimensions of OpenMC Studio's illustrative example, FEED's own conductivities (synthetic)
const kConst = (k, T, why) => ({ model: "constant", value: qv(k, "W/m/K"), referenceTemperature: qv(T, "K"), source: "synthetic: " + why });
const trisoMat = (id, k, T) => ({ materialId: id, revision: 1, sets: { "thermal.conductivity": kConst(k, T, "chosen for the closed-form oracle, not a sourced property") } });
const trisoBase = () => ({
  schema: "feed.case/0.1",
  caseId: "triso",
  name: "Synthetic coated particle (illustrative numbers, not a real fuel design)",
  label: "synthetic",
  assumptions: { thermalOnly: true, steadyState: true, geometry: "1D-sphere" },
  geometry: {
    kind: "triso",
    kernelRadius: qv(250, "um"),
    layers: [
      { name: "buffer", thickness: qv(100, "um") },
      { name: "ipyc", thickness: qv(40, "um") },
      { name: "sic", thickness: qv(35, "um") },
      { name: "opyc", thickness: qv(35, "um") },
    ],
  },
  power: { kernelPowerDensity: qv(600, "MW/m3") },
  boundary: { surfaceTemperature: qv(1000, "K") },
  materials: {
    kernel: trisoMat("synthetic-kernel", 3, 1000),
    buffer: trisoMat("synthetic-buffer", 0.5, 1000),
    ipyc: trisoMat("synthetic-ipyc", 4, 1000),
    sic: trisoMat("synthetic-sic", 13.9, 1000),
    opyc: trisoMat("synthetic-opyc", 4, 1000),
  },
  gap: { model: "constant-conductance", conductance: qv(1.5e5, "W/m2/K"), source: "synthetic: chosen for the closed-form oracle" },
  mesh: { kernelCells: 12, bufferCells: 12, ipycCells: 12, sicCells: 16, opycCells: 12 },
});
add("good", "triso-steady", trisoBase(), {});
{
  const c = trisoBase();
  c.power = { particlePower: qv(0.04, "W") };
  add("good", "triso-particle-power", c, {});
}
{
  const c = trisoBase();
  c.power = { compactPowerDensity: qv(10, "W/cm3"), packingFraction: qv(35, "%") };
  add("good", "triso-compact", c, {});
}
{
  const c = trisoBase();
  c.boundary = { bulkTemperature: qv(900, "K"), heatTransferCoefficient: qv(2000, "W/m2/K") };
  add("good", "triso-convective-outside", c, {});
}
{
  const c = trisoBase();
  c.geometry.layers = c.geometry.layers.slice(0, 2);
  delete c.materials.sic;
  delete c.materials.opyc;
  delete c.mesh.sicCells;
  delete c.mesh.opycCells;
  add("good", "triso-two-layers", c, {});
}
{
  const c = trisoBase();
  c.geometry.kernelRadius = qv(0.25, "mm");
  c.geometry.layers[0].thickness = qv(0.1, "mm");
  add("good", "triso-lengths-in-mm", c, {});
}
{
  const c = trisoBase();
  c.power = { compactPowerDensity: qv(10, "W/cm3"), packingFraction: qv(0.68, "1") };
  add("good", "triso-packing-warning", c, { warnings: ["W_PACKING_FRACTION"] });
}
{
  const c = trisoBase();
  c.gap.conductance = qv(5e5, "W/m2/K");
  add("good", "triso-gap-contact-warning", c, { warnings: ["W_GAP_CONTACT"] });
}
{
  const c = trisoBase();
  c.power = { kernelPowerDensity: qv(20000, "MW/m3") };
  add("good", "triso-power-warning", c, { warnings: ["W_POWER_RANGE"] });
}
{
  // conductivities that fall with temperature (T3: the real solver is checked against the closed form of each); a film outside, the probe's 3000 MW/m3
  const c = trisoBase();
  c.power = { kernelPowerDensity: qv(3000, "MW/m3") };
  c.boundary = { bulkTemperature: qv(900, "K"), heatTransferCoefficient: qv(2000, "W/m2/K") };
  const range = { min: qv(600, "K"), max: qv(2000, "K") };
  c.materials.kernel.sets["thermal.conductivity"] = { model: "linear", a: qv(3.5, "W/m/K"), b: qv(-0.0008, "W/m/K2"), validRange: range, source: "synthetic: chosen for the conductivity-integral oracle" };
  c.materials.buffer.sets["thermal.conductivity"] = { model: "linear", a: qv(0.4, "W/m/K"), b: qv(0.0001, "W/m/K2"), validRange: range, source: "synthetic: chosen for the conductivity-integral oracle" };
  c.materials.sic.sets["thermal.conductivity"] = { model: "reciprocal", a: qv(17885, "W/m"), b: qv(2, "W/m/K"), validRange: range, source: "synthetic: a phonon-limited shape, k = a / T + b" };
  add("good", "triso-temperature-dependent", c, {});
}
{
  // limits on the kernel and on layers, each with its source: synthetic numbers, not design limits (FEED has none of its own)
  const c = trisoBase();
  c.power = { kernelPowerDensity: qv(3000, "MW/m3") };
  c.boundary = { surfaceTemperature: qv(1298, "K") };
  c.limits = [
    { name: "kernel, synthetic", region: "kernel", maxTemperature: qv(1500, "K"), source: "synthetic: a number chosen for this test, not a design limit" },
    { name: "buffer, synthetic", region: "buffer", maxTemperature: qv(1100, "degC"), source: "synthetic: a number chosen for this test, not a design limit" },
    { name: "sic, synthetic", region: "sic", maxTemperature: qv(1300, "K"), source: "synthetic: a number chosen for this test, not a design limit" },
  ];
  add("good", "triso-limits", c, {});
}
const badTr = (name, code, field, mutate) => { const c = trisoBase(); mutate(c); add("bad", name, c, { code, field }); };
badTr("triso-linear-heat-rate", "E_UNSUPPORTED", "/power/linearHeatRate", (c) => (c.power = { linearHeatRate: qv(20, "kW/m") }));
badTr("triso-two-power-forms", "E_SCHEMA_INVALID", "/power", (c) => (c.power.particlePower = qv(0.04, "W")));
badTr("triso-no-power", "E_SCHEMA_INVALID", "/power", (c) => (c.power = {}));
badTr("triso-compact-without-packing", "E_PROP_MISSING", "/power/packingFraction", (c) => (c.power = { compactPowerDensity: qv(10, "W/cm3") }));
badTr("triso-packing-without-compact", "E_UNSUPPORTED", "/power/packingFraction", (c) => (c.power.packingFraction = qv(0.35, "1")));
badTr("triso-packing-too-dense", "E_OUT_OF_RANGE", "/power/packingFraction", (c) => (c.power = { compactPowerDensity: qv(10, "W/cm3"), packingFraction: qv(0.8, "1") }));
badTr("triso-packing-zero", "E_OUT_OF_RANGE", "/power/packingFraction", (c) => (c.power = { compactPowerDensity: qv(10, "W/cm3"), packingFraction: qv(0, "1") }));
badTr("triso-power-wrong-unit", "E_UNITS", "/power/particlePower", (c) => (c.power = { particlePower: qv(0.04, "W/m") }));
badTr("triso-layers-out-of-order", "E_GEOMETRY", "/geometry/layers/0/name", (c) => c.geometry.layers.reverse());
badTr("triso-one-layer", "E_GEOMETRY", "/geometry/layers", (c) => (c.geometry.layers = c.geometry.layers.slice(0, 1)));
badTr("triso-five-layers", "E_GEOMETRY", "/geometry/layers", (c) => c.geometry.layers.push({ name: "opyc", thickness: qv(10, "um") }));
badTr("triso-missing-kernel-radius", "E_SCHEMA_INVALID", "/geometry/kernelRadius", (c) => delete c.geometry.kernelRadius);
badTr("triso-negative-thickness", "E_GEOMETRY", "/geometry/layers/1/thickness", (c) => (c.geometry.layers[1].thickness = qv(-40, "um")));
badTr("triso-thickness-wrong-unit", "E_UNITS", "/geometry/layers/0/thickness", (c) => (c.geometry.layers[0].thickness = qv(100, "W")));
badTr("triso-with-a-pin-radius", "E_GEOMETRY", "/geometry/fuelRadius", (c) => (c.geometry.fuelRadius = qv(4.1, "mm")));
badTr("triso-layer-with-extra-key", "E_GEOMETRY", "/geometry/layers/2/density", (c) => (c.geometry.layers[2].density = 3.2));
badTr("triso-material-missing", "E_SCHEMA_INVALID", "/materials/sic", (c) => delete c.materials.sic);
badTr("triso-material-for-absent-layer", "E_GEOMETRY", "/materials/opyc", (c) => { c.geometry.layers = c.geometry.layers.slice(0, 3); delete c.mesh.opycCells; });
badTr("triso-material-without-conductivity", "E_PROP_MISSING", "/materials/buffer/sets/thermal.conductivity", (c) => delete c.materials.buffer.sets["thermal.conductivity"]);
badTr("triso-pin-material-names", "E_GEOMETRY", "/materials/fuel", (c) => (c.materials.fuel = trisoMat("synthetic-fuel", 3, 1000)));
badTr("triso-with-mechanics", "E_UNSUPPORTED", "/mechanics", (c) => (c.mechanics = {}));
badTr("triso-with-axial-stack", "E_UNSUPPORTED", "/axial", (c) => (c.axial = axialBase()));
badTr("triso-transient", "E_UNSUPPORTED", "/assumptions/steadyState", (c) => (c.assumptions.steadyState = false));
badTr("triso-assumed-radial", "E_UNSUPPORTED", "/assumptions/geometry", (c) => (c.assumptions.geometry = "1D-radial"));
badTr("triso-closed-gap", "E_UNSUPPORTED", "/gap/model", (c) => (c.gap = { model: "closed" }));
badTr("triso-no-boundary", "E_BOUNDARY_INCOMPLETE", "/boundary", (c) => (c.boundary = {}));
badTr("triso-mesh-kernel-low", "E_MESH", "/mesh/kernelCells", (c) => (c.mesh.kernelCells = 2));
badTr("triso-mesh-layer-missing", "E_SCHEMA_INVALID", "/mesh/sicCells", (c) => delete c.mesh.sicCells);
badTr("triso-mesh-pin-keys", "E_SCHEMA_INVALID", "/mesh/fuelCells", (c) => (c.mesh.fuelCells = 20));
badTr("triso-too-slow-to-settle", "E_TIME", "/assumptions/steadyState", (c) => (c.gap.conductance = qv(1e-12, "W/m2/K")));
badTr("triso-conductivity-reaches-zero", "E_OUT_OF_RANGE", "/materials", (c) => {
  c.materials.kernel.sets["thermal.conductivity"] = { model: "linear", a: qv(3, "W/m/K"), b: qv(-0.002, "W/m/K2"), validRange: { min: qv(500, "K"), max: qv(1400, "K") }, source: "synthetic: positive over its range, zero at 1500 K, where this power takes the kernel" };
  c.power = { kernelPowerDensity: qv(30000, "MW/m3") };
});
const limitRule = (extra) => Object.assign({ name: "kernel, synthetic", region: "kernel", maxTemperature: qv(1500, "K"), source: "synthetic: a number chosen for this test" }, extra);
badTr("triso-limit-pin-region", "E_SCHEMA_INVALID", "/limits/0/region", (c) => (c.limits = [limitRule({ region: "fuel" })]));
badTr("triso-limit-region-absent", "E_GEOMETRY", "/limits/0/region", (c) => { c.geometry.layers = c.geometry.layers.slice(0, 2); delete c.materials.sic; delete c.materials.opyc; delete c.mesh.sicCells; delete c.mesh.opycCells; c.limits = [limitRule({ region: "sic" })]; });
badTr("triso-limit-while-cladding", "E_UNSUPPORTED", "/limits/0/whileCladding", (c) => (c.limits = [limitRule({ whileCladding: { atMost: qv(500, "degC") } })]));
badTr("triso-limit-no-source", "E_PROP_MISSING", "/limits/0/source", (c) => { const r = limitRule({}); delete r.source; c.limits = [r]; });
badTr("triso-limit-no-maximum", "E_PROP_MISSING", "/limits/0/maxTemperature", (c) => { const r = limitRule({}); delete r.maxTemperature; c.limits = [r]; });
badTr("triso-limit-too-hot", "E_OUT_OF_RANGE", "/limits/0/maxTemperature", (c) => (c.limits = [limitRule({ maxTemperature: qv(20000, "K") })]));
badTr("triso-limit-wrong-unit", "E_UNITS", "/limits/0/maxTemperature", (c) => (c.limits = [limitRule({ maxTemperature: qv(1500, "W") })]));
badTr("triso-limit-duplicate-name", "E_SCHEMA_INVALID", "/limits/1/name", (c) => (c.limits = [limitRule({}), limitRule({ region: "buffer" })]));
badTr("triso-limit-no-name", "E_SCHEMA_INVALID", "/limits/0/name", (c) => (c.limits = [limitRule({ name: "" })]));
bad("pin-missing-fuel-material", "E_SCHEMA_INVALID", "/materials/fuel", (c) => delete c.materials.fuel);
bad("pin-missing-cladding-cells", "E_SCHEMA_INVALID", "/mesh/claddingCells", (c) => delete c.mesh.claddingCells);

fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(index.length + " vectors written");
