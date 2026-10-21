// Throw-away (plan 17 M0): saves the small results of runs into docs/spike/transient-mechanics-probe/results/ (the selected-times table and the all-times table of each run, and the
// convergence summaries of all of them in one JSON) and prints the convergence table. The big files (the fields of every time) stay in the scratch folder.
// usage: node collect.cjs <scratchM0Dir> <tag> [<tag> ...]     (needs an-<tag>.json from analyze.cjs for the tables; out-<tag>/log.offbeat.summary.json from go.sh for the convergence)
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const M = process.argv[2];
const tags = process.argv.slice(3);
const dest = path.join(__dirname, "results");
fs.mkdirSync(dest, { recursive: true });
const conv = {};
const lines = ["| run | stage | steps | mean outer iterations | max | steps over the cap | steps not converged (T / D) | worst relResidualD | wall s (real/user/sys) |", "|---|---|---|---|---|---|---|---|---|"];
for (const t of tags) {
  const an = path.join(M, `an-${t}.json`);
  if (fs.existsSync(an)) {
    const sel = execFileSync("node", [path.join(__dirname, "table.cjs"), an], { encoding: "utf8" });
    const all = execFileSync("node", [path.join(__dirname, "table.cjs"), an, "--all"], { encoding: "utf8" });
    fs.writeFileSync(path.join(dest, `${t}.table.md`), `# ${t}: selected times\n\n${sel}\n`);
    fs.writeFileSync(path.join(dest, `${t}.all-times.md`), `# ${t}: every written time\n\n${all}\n`);
  }
  const exit = fs.existsSync(path.join(M, `out-${t}`, "exit.json")) ? JSON.parse(fs.readFileSync(path.join(M, `out-${t}`, "exit.json"), "utf8")) : {};
  conv[t] = { exit };
  for (const [stage, file, wallKey] of [["1", "log.offbeat.summary.json", "stage1_real_user_sys_s"], ["2", "log.offbeat2.summary.json", "stage2_real_user_sys_s"]]) {
    const f = path.join(M, `out-${t}`, file);
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f, "utf8")).summary;
    conv[t][`stage${stage}`] = s;
    lines.push(`| ${t} | ${stage} | ${s.steps} | ${s.meanIterations.toFixed(1)} | ${s.maxIterations} | ${s.stepsAtMaxOuter} | ${s.stepsNotConverged} (${s.thermalNotConverged} / ${s.mechNotConverged}) | ${s.worstRelD.toExponential(2)} | ${exit[wallKey] ? exit[wallKey].join(" / ") : "-"} |`);
  }
}
const jf = path.join(dest, "convergence.json");
const old = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, "utf8")) : {};
fs.writeFileSync(jf, JSON.stringify({ ...old, ...conv }, null, 1) + "\n");
console.log(lines.join("\n"));
