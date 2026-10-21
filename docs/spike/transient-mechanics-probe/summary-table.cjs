// Throw-away (plan 17 M0): one line per analysed run, the agreement with the independent solution over all written times and over the times with contact. usage: node summary-table.cjs <scratchM0Dir> <tag>...
// The temperatures given to the independent solution are OFFBEAT's own of that time (column group 1) or FEED's finite-volume ones (column group 2).
const fs = require("fs");
const path = require("path");
const M = process.argv[2];
const tags = process.argv.slice(3);
const out = [
  "| run | cold gap um | contact model | factor | written times | with contact | worst P error | OFFBEAT T, all times: disp / stress / equil / contact fails | OFFBEAT T, times with contact | FV T, all times | FV T, times with contact |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];
const cnt = (rows, g, k) => rows.filter((r) => g(r) && !g(r)[k]).length;
for (const t of tags) {
  const j = JSON.parse(fs.readFileSync(path.join(M, `an-${t}.json`), "utf8"));
  const rows = j.rows.filter((r) => !r.missing);
  const rc = rows.filter((r) => r.withOffbeatT.indepContact);
  const both = rows.filter((r) => r.withOffbeatT.indepContact && r.withOffbeatT.offContact);
  const worst = both.reduce((m, r) => Math.max(m, Math.abs(r.withOffbeatT.pErrRel || 0)), 0);
  const ks = ["uOk", "sOk", "eqOk", "contactOk"];
  const o = (rs) => ks.map((k) => cnt(rs, (r) => r.withOffbeatT, k)).join(" / ");
  const f = (rs) => ks.map((k) => cnt(rs, (r) => r.withFvT, k)).join(" / ");
  out.push(`| ${t} | ${j.meta.gapUm} | ${j.meta.laws ? "implicit, OFFBEAT's own E(T) and strain laws" : t.startsWith("x-") ? "explicit" : "implicit"} | ${j.meta.penalty} | ${rows.length} | ${rc.length} | ${(worst * 100).toFixed(2)} % | ${o(rows)} | ${o(rc)} | ${f(rows)} | ${f(rc)} |`);
}
console.log(out.join("\n"));
