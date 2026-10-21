// Throw-away (plan 17 M0): the sampled times of one cold gap side by side for the three penalty factors (implicit contact), OFFBEAT's contact pressure and its error against the independent
// solution with OFFBEAT's own temperatures (thermal strain piecewise constant per cell), and whether the four checks pass for each factor. usage: node combined-table.cjs <scratchM0Dir> <gapUm>
const fs = require("fs");
const path = require("path");
const [M, gap] = process.argv.slice(2);
const load = (pf) => JSON.parse(fs.readFileSync(path.join(M, `an-i-g${gap}-p${pf}.json`), "utf8")).rows.filter((r) => !r.missing);
const runs = { "0.3": load("03"), "0.5": load("05"), "0.7": load("07") };
const base = runs["0.7"];
const touch = (r) => r.withOffbeatT.indepContact;
const firstClose = base.findIndex(touch);
let peak = 0;
base.forEach((r, i) => { if (r.withOffbeatT.indepP > base[peak].withOffbeatT.indepP) peak = i; });
let reopen = -1;
for (let i = peak; i < base.length; i++) if (!touch(base[i])) { reopen = i; break; }
const pick = new Map();
const add = (i, label) => { if (i >= 0 && i < base.length) pick.set(i, (pick.get(i) ? pick.get(i) + ", " : "") + label); };
add(firstClose - 1, "last time before closing");
add(firstClose, "first time closed");
add(base.findIndex((r) => r.time >= 0.03), "rising power");
add(peak, "largest pressure");
add(base.findIndex((r) => r.time >= 0.0999), "end of the pulse");
add(base.findIndex((r) => r.time >= 10), "cooling");
if (reopen >= 0) {
  add(reopen - 1, "last time in contact");
  add(reopen, "first time reopened");
  add(reopen + 10, "reopened");
} else {
  add(base.findIndex((r) => r.time >= 30), "cooling");
  add(base.length - 1, "end of the cooldown (still in contact)");
}
const f = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "-" : Number(x).toFixed(d));
const all4 = (r) => r.withOffbeatT.uOk && r.withOffbeatT.sOk && r.withOffbeatT.eqOk && r.withOffbeatT.contactOk;
const flags = (r) => `${r.withOffbeatT.uOk ? "u" : "-"}${r.withOffbeatT.sOk ? "s" : "-"}${r.withOffbeatT.eqOk ? "e" : "-"}${r.withOffbeatT.contactOk ? "c" : "-"}`;
const out = [`| time | what | fuel T max K | independent P MPa (gap um) | factor 0.3: P MPa (error %) checks | factor 0.5 | factor 0.7 |`, "|---|---|---|---|---|---|---|"];
for (const i of [...pick.keys()].sort((a, b) => a - b)) {
  const r = base[i];
  const t = r.time < 1 ? f(r.time * 1e3, 0) + " ms" : f(r.time, 1) + " s";
  const cells = ["0.3", "0.5", "0.7"].map((pf) => {
    const x = runs[pf][i];
    const a = x.withOffbeatT;
    const err = a.indepContact && a.offContact ? ` (${f((a.pErrRel ?? 0) * 100, 2)} %)` : a.indepContact ? " (touch differs)" : "";
    return `${f((a.offP ?? 0) / 1e6)}${err}${a.indepContact ? "" : ", gap " + f(a.offGapUm, 2) + " um"} ${flags(x)}`;
  });
  out.push(`| ${t} | ${pick.get(i)} | ${f(r.Tfuel.max, 0)} | ${r.withOffbeatT.indepContact ? f(r.withOffbeatT.indepP / 1e6) : "open, " + f(r.withOffbeatT.indepGapUm, 2)} | ${cells.join(" | ")} |`);
}
out.push("", "checks: u displacement, s stress, e equilibrium, c contact; a letter is shown when that check passes, '-' when it fails. all_four_pass_everywhere_in_contact: " + Object.entries(runs).map(([k, rs]) => `${k}: ${rs.filter((r) => r.withOffbeatT.indepContact).every(all4)}`).join(", "));
console.log(out.join("\n"));
