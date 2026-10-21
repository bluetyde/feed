// Throw-away (plan 17 M0): the convergence of every time step of an OFFBEAT log, by FEED's own predicates (dist/core/convergence.js): the thermal one (thermalConverged on T) and
// the displacement one (mechanicsConverged on D, OFFBEAT's mechanicsSubSolver::converged). usage: node log-summary.cjs <log.offbeat> <fvSolution> [--json out.json]
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..", "..");
const cv = require(path.join(root, "dist/core/convergence.js"));
const log = fs.readFileSync(process.argv[2], "utf8");
const fvs = fs.readFileSync(process.argv[3], "utf8");
const tc = cv.readCriterion(fvs);
const mc = cv.readMechanicsCriterion(fvs);
if (!tc.ok || !mc.ok) throw new Error("criterion: " + JSON.stringify([tc, mc]));
const T = cv.parseSteps(log);
const D = cv.parseMechanicsSteps(log);
const rows = T.map((s, i) => {
  const d = D[i];
  return {
    time: s.time,
    iterations: s.iterations,
    thermalOk: s.last ? cv.thermalConverged(s.last, tc.criterion) : false,
    mechOk: d && d.last ? cv.mechanicsConverged(d.last, mc.criterion) : false,
    relD: d && d.last ? d.last.relResidual : null,
    absErrD: d && d.last ? d.last.absErr : null,
    initD: d && d.last ? Math.max(...d.last.residual) : null,
  };
});
const n = rows.length;
const hit = rows.filter((r) => r.iterations >= tc.criterion.maxOuterIter).length;
const bad = rows.filter((r) => !r.thermalOk || !r.mechOk);
const its = rows.map((r) => r.iterations);
const sum = its.reduce((a, b) => a + b, 0);
const out = {
  steps: n,
  firstTime: rows[0] && rows[0].time,
  lastTime: rows[n - 1] && rows[n - 1].time,
  maxOuterIter: tc.criterion.maxOuterIter,
  totalOuterIterations: sum,
  meanIterations: sum / Math.max(n, 1),
  maxIterations: Math.max(...its),
  stepsAtMaxOuter: hit,
  stepsNotConverged: bad.length,
  thermalNotConverged: rows.filter((r) => !r.thermalOk).length,
  mechNotConverged: rows.filter((r) => !r.mechOk).length,
  firstNotConverged: bad.length ? bad[0].time : null,
  lastNotConverged: bad.length ? bad[bad.length - 1].time : null,
  worstRelD: Math.max(...rows.map((r) => r.relD ?? 0)),
  worstAbsErrD: Math.max(...rows.map((r) => r.absErrD ?? 0)),
};
console.log(JSON.stringify(out));
const j = process.argv.indexOf("--json");
if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify({ summary: out, rows }) + "\n");
