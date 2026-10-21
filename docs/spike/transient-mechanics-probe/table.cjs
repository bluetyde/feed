// Throw-away (plan 17 M0): the sampled-times table of one run from the JSON that analyze.cjs wrote. The sampled times are the ones the brief asks for: just before the gap closes, just
// after, the largest contact pressure, a mid-cooldown time, just before it reopens, just after, and the end. usage: node table.cjs <an-tag.json> [--all]
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const all = process.argv.includes("--all");
const rows = j.rows.filter((r) => !r.missing);
const touch = (r) => r.withOffbeatT.indepContact;
let firstClose = rows.findIndex(touch);
let peak = 0;
rows.forEach((r, i) => { if (r.withOffbeatT.indepP > rows[peak].withOffbeatT.indepP) peak = i; });
let reopen = -1;
for (let i = Math.max(peak, 0); i < rows.length; i++) if (!touch(rows[i])) { reopen = i; break; }
const pick = new Map();
const add = (i, label) => { if (i >= 0 && i < rows.length) pick.set(i, (pick.get(i) ? pick.get(i) + "+" : "") + label); };
add(firstClose - 1, "before closing");
add(firstClose, "after closing");
add(rows.findIndex((r) => r.time >= 0.03), "30 ms");
add(peak, "peak P");
add(rows.findIndex((r) => r.time >= 0.0999), "end of pulse");
add(rows.findIndex((r) => r.time >= 30), "30 s");
add(reopen - 1, "before reopening");
add(reopen, "after reopening");
add(rows.length - 1, "end");
const f = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "-" : Number(x).toFixed(d));
const yn = (x) => (x ? "ok" : "FAIL");
const out = [];
out.push("| time | what | T fuel max K | contact (indep.) | P OFFBEAT MPa | P indep. (OFFBEAT T) MPa | err % | P indep. (FV T) MPa | err % | gap OFFBEAT / indep. um | disp | stress | equil | contact | disp / stress / contact (FV T) |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
const idxs = all ? rows.map((_, i) => i) : [...pick.keys()].sort((a, b) => a - b);
for (const i of idxs) {
  const r = rows[i];
  const a = r.withOffbeatT, b = r.withFvT;
  const t = r.time < 1 ? f(r.time * 1e3, 1) + " ms" : f(r.time, 1) + " s";
  out.push(
    `| ${t} | ${pick.get(i) || ""} | ${f(r.Tfuel.max, 0)} | ${a.indepContact ? "yes" : "no"} | ${f((a.offP ?? 0) / 1e6)} | ${f(a.indepP / 1e6)} | ${f((a.pErrRel ?? NaN) * 100, 2)} | ${b ? f(b.indepP / 1e6) : "-"} | ${b ? f((b.pErrRel ?? NaN) * 100, 2) : "-"} | ${f(a.offGapUm)} / ${f(a.indepGapUm)} | ${yn(a.uOk)} | ${yn(a.sOk)} | ${yn(a.eqOk)} | ${yn(a.contactOk)} | ${b ? [b.uOk, b.sOk, b.contactOk].map((x) => (x ? "ok" : "FAIL")).join(" / ") : "-"} |`,
  );
}
// the worst over the contact times
const contactRows = rows.filter((r) => r.withOffbeatT.indepContact && r.withOffbeatT.offContact);
const worst = (get) => contactRows.reduce((m, r) => { const v = get(r); return v === undefined || v === null || Number.isNaN(v) ? m : Math.max(m, Math.abs(v)); }, 0);
const nAll = rows.length;
const cnt = (g, k) => rows.filter((r) => g(r) && !g(r)[k]).length;
out.push("");
out.push(`times written: ${nAll}; with contact in both: ${contactRows.length}; worst |P error| (OFFBEAT T): ${f(worst((r) => r.withOffbeatT.pErrRel) * 100, 2)} %, (FV T): ${f(worst((r) => r.withFvT && r.withFvT.pErrRel) * 100, 2)} %`);
out.push(`failed checks over all written times (OFFBEAT T): disp ${cnt((r) => r.withOffbeatT, "uOk")}, stress ${cnt((r) => r.withOffbeatT, "sOk")}, equil ${cnt((r) => r.withOffbeatT, "eqOk")}, contact ${cnt((r) => r.withOffbeatT, "contactOk")}; (FV T): disp ${cnt((r) => r.withFvT, "uOk")}, stress ${cnt((r) => r.withFvT, "sOk")}, equil ${cnt((r) => r.withFvT, "eqOk")}, contact ${cnt((r) => r.withFvT, "contactOk")}`);
const cr = rows.filter((r) => r.withOffbeatT.indepContact);
out.push(`over the ${cr.length} times with contact: failed disp ${cr.filter((r) => !r.withOffbeatT.uOk).length}, stress ${cr.filter((r) => !r.withOffbeatT.sOk).length}, equil ${cr.filter((r) => !r.withOffbeatT.eqOk).length}, contact ${cr.filter((r) => !r.withOffbeatT.contactOk).length}`);
console.log(out.join("\n"));
