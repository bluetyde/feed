// Throw-away probe (plan 16 interface study): run one particle case through OFFBEAT at N cells in every region and save the cells (radius, T, region) and FEED's wedge-equivalent
// particle to runs/<case>-N<N>.json, so that analyse.cjs can work offline.
// Usage (repo root, after npm run build): node docs/spike/triso-interface-probe/run-cells.cjs <case.json> <N> [<N> ...]
const fs = require("fs");
const path = require("path");
const os = require("os");
const root = process.cwd();
const { RunManager } = require(path.join(root, "dist/core/runManager.js"));
const { WslBackend } = require(path.join(root, "dist/core/wslBackend.js"));
const { validateCase } = require(path.join(root, "dist/core/validate.js"));
const { wedgeEquivalent } = require(path.join(root, "dist/core/trisoWriter.js"));
const doc0 = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const name = path.basename(process.argv[2]).replace(/\.case\.json$|\.json$/, "");
(async () => {
  for (const N of process.argv.slice(3).map(Number)) {
    const doc = JSON.parse(JSON.stringify(doc0));
    doc.mesh = { kernelCells: N, bufferCells: N, ipycCells: N, sicCells: N, opycCells: N };
    const v = validateCase(doc);
    if (!v.ok) { console.log(name, N, "refused", JSON.stringify(v.errors).slice(0, 300)); continue; }
    const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feed-iface-"));
    const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 900000 });
    const s = mgr.start(doc);
    const rec = await mgr.done(s.id);
    if (rec.state !== "completed") { console.log(name, N, "run ended", rec.state); continue; }
    const res = mgr.results(s.id);
    const eq = wedgeEquivalent(v.triso);
    const out = { name, N, eq, cells: res.cells.slice().sort((p, q) => p.r - q.r), checks: res.checks.map((c) => ({ id: c.id, value: c.value, verdict: c.verdict })) };
    fs.writeFileSync(path.join(__dirname, "runs", `${name}-N${N}.json`), JSON.stringify(out));
    const fvc = res.checks.find((c) => c.id === "crossCheckFv");
    console.log(name, N, "cells", out.cells.length, "crossCheckFv", fvc && fvc.value, fvc && fvc.verdict);
  }
})();
