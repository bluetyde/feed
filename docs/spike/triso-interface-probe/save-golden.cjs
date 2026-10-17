// Throw-away: run a sampled particle's case at N cells per region through OFFBEAT and save the raw output (T, C, cellZones, normalized.json, rate.json) in tests/golden/offbeat-triso-mesh/<role>-<N>.
// Usage (repo root, after npm run build): node docs/spike/triso-interface-probe/save-golden.cjs <role> <N> [<N> ...]   (role: coldest hottest median thickest-buffer thinnest-sic)
const fs = require("fs");
const path = require("path");
const os = require("os");
const root = process.cwd();
const { RunManager } = require(path.join(root, "dist/core/runManager.js"));
const { WslBackend } = require(path.join(root, "dist/core/wslBackend.js"));
const { lastRelativeRate } = require(path.join(root, "dist/core/steadyState.js"));
const role = process.argv[2];
const doc0 = JSON.parse(fs.readFileSync(path.join(root, "oracles/seed-triso/models", `triso-pop-${role}.case.json`), "utf8"));
(async () => {
  for (const N of process.argv.slice(3).map(Number)) {
    const doc = JSON.parse(JSON.stringify(doc0));
    doc.mesh = { kernelCells: N, bufferCells: N, ipycCells: N, sicCells: N, opycCells: N };
    const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "feed-iface-g-"));
    const mgr = new RunManager({ runsRoot, backend: new WslBackend(), timeoutMs: 900000 });
    const s = mgr.start(doc);
    if (!s.ok) throw new Error("refused " + JSON.stringify(s));
    const rec = await mgr.done(s.id);
    if (rec.state !== "completed") throw new Error("run ended " + rec.state);
    const res = mgr.results(s.id);
    const dir = path.join(runsRoot, s.id), native = path.join(dir, "native", "final");
    const out = path.join(root, "tests", "golden", "offbeat-triso-mesh", `${role}-${N}`);
    fs.mkdirSync(out, { recursive: true });
    for (const f of ["T", "C", "cellZones"]) fs.copyFileSync(path.join(native, f), path.join(out, f));
    fs.copyFileSync(path.join(dir, "normalized.json"), path.join(out, "normalized.json"));
    const log = fs.readFileSync(path.join(dir, "native", "log.offbeat"), "utf8");
    fs.writeFileSync(path.join(out, "rate.json"), JSON.stringify({ relativeRate: lastRelativeRate(log), time: res.time, steps: (log.match(/^Time = /gm) || []).length, exitCode: rec.exitCode }, null, 2) + "\n");
    console.log("saved", out);
  }
})();
