// Mutation run for plan 16 (trisoInterfaceAllowance and its use). Baseline must be green; each mutant is applied to a copy and restored.
const fs = require("fs");
const { spawnSync } = require("child_process");
const file = "src/core/trisoResults.ts";
const orig = fs.readFileSync(file, "utf8");
fs.writeFileSync("C:/agents/claude/mut-triso-interface.orig", orig);
const TESTS = ["tests/trisoInterface.test.ts", "tests/trisoResults.test.ts", "tests/trisoPopulationGolden.test.ts"];
function run() {
  const r = spawnSync("npx", ["vitest", "run", ...TESTS], { encoding: "utf8", shell: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /Tests\s+(.*)/.exec(out);
  return { code: r.status, summary: m ? m[1].trim() : "NO SUMMARY" };
}
const mutants = [
  ["the gap treated as an interface", "    if (ri === 1) continue; // the gap sits on the buffer's outer face\n", ""],
  ["face conductivity weights swapped", "(k1 * d2 + k2 * d1) / (d1 + d2)", "(k1 * d1 + k2 * d2) / (d1 + d2)"],
  ["d1 from half the cell width", "const d1 = face - SPHERE.centroid(face - hIn, face);", "const d1 = hIn / 2;"],
  ["d2 from half the cell width", "const d2 = SPHERE.centroid(face, face + hOut) - face;", "const d2 = hOut / 2;"],
  ["no division by the face area", "/ SPHERE.area(face);\n    interfaces.push", ";\n    interfaces.push"],
  ["no power factor", "const shift = (P * ((d1 + d2)", "const shift = (1e-3 * ((d1 + d2)"],
  ["k1 at the inner face of its region", "closed.regions[ri]!.outerT)", "closed.regions[ri]!.innerT)"],
  ["k2 at the outer face of its region", "closed.regions[ri + 1]!.innerT)", "closed.regions[ri + 1]!.outerT)"],
  ["outside region's cell width from the inner region's count", "(bounds[ri + 2]! - bounds[ri + 1]!) / eq.cells[ri + 1]!", "(bounds[ri + 2]! - bounds[ri + 1]!) / eq.cells[ri]!"],
  ["inner width from the outer region's count", "(bounds[ri + 1]! - bounds[ri]!) / eq.cells[ri]!", "(bounds[ri + 1]! - bounds[ri]!) / eq.cells[ri + 1]!"],
  ["forRegion counts interfaces strictly outside (>)", "i.outside >= ri)", "i.outside > ri)"],
  ["forRegion counts the wrong side (<=)", "i.outside >= ri)", "i.outside <= ri)"],
  ["forRegion without the absolute value", "s + Math.abs(i.shift), 0));\n  return", "s + i.shift, 0));\n  return"],
  ["total is the buffer's sum", "total: forRegion[0]!", "total: forRegion[1]!"],
  ["safety factor 1", "export const TRISO_INTERFACE_SAFETY = 1.25;", "export const TRISO_INTERFACE_SAFETY = 1;"],
  ["safety factor 2", "export const TRISO_INTERFACE_SAFETY = 1.25;", "export const TRISO_INTERFACE_SAFETY = 2;"],
  ["the finite-volume bound without the allowance", "const fvBound = fvBase + fvAllowance;", "const fvBound = fvBase;"],
  ["the finite-volume bound with the allowance twice", "const fvBound = fvBase + fvAllowance;", "const fvBound = fvBase + 3 * fvAllowance;"],
  ["closed forms without the allowance", "+ Math.max(TRISO_CLOSED_FORM_RISE_FRACTION * rise, TRISO_CLOSED_FORM_FLOOR) + interfaceAllowance;", "+ Math.max(TRISO_CLOSED_FORM_RISE_FRACTION * rise, TRISO_CLOSED_FORM_FLOOR);"],
  ["closed forms with the total for every region", "TRISO_INTERFACE_SAFETY * interfaceShift.forRegion[ri]!", "TRISO_INTERFACE_SAFETY * interfaceShift.total"],
  ["the allowance not in the note", "${fvAllowance.toPrecision(3)} K interface allowance", "${fvAllowance.toPrecision(3)} K margin"],
  ["the note's bound is the base", "bound ${fvBound.toPrecision(3)} K = ${fvBase.toPrecision(3)} K (0.3 %", "bound ${fvBase.toPrecision(3)} K = ${fvBase.toPrecision(3)} K (0.3 %"],
  ["fvBase floor lost", "const fvBase = Math.max(TRISO_FV_RISE_FRACTION * rise, TRISO_FV_FLOOR);", "const fvBase = TRISO_FV_RISE_FRACTION * rise;"],
];
console.log("baseline ...");
const base = run();
console.log("baseline:", base.code, base.summary);
if (base.code !== 0 || !/passed/.test(base.summary) || /failed/.test(base.summary)) { console.log("BASELINE NOT GREEN: abort"); process.exit(2); }
const results = [];
for (const [name, from, to] of mutants) {
  if (!orig.includes(from)) { console.log("SKIP (pattern absent):", name); results.push([name, "PATTERN ABSENT"]); continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  const r = run();
  fs.writeFileSync(file, orig);
  const killed = r.code !== 0 && /failed/.test(r.summary);
  console.log((killed ? "KILLED  " : r.code !== 0 ? "CRASHED " : "SURVIVED") + " | " + name + " | exit " + r.code + " | " + r.summary);
  results.push([name, killed ? "killed" : r.code !== 0 ? "crashed" : "SURVIVED"]);
}
fs.writeFileSync(file, orig);
console.log("restored:", fs.readFileSync(file, "utf8") === orig);
console.log("survivors:", results.filter((r) => r[1] !== "killed").map((r) => r.join(": ")).join("; ") || "none");
