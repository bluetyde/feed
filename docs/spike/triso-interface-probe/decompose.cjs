// Throw-away probe: which part of OFFBEAT's scheme makes the deviation? Each part switched alone on top of FEED's series scheme, and each part removed from the OFFBEAT replica.
const fs = require("fs");
const { chain, SERIES, OFFB } = require("./replica.cjs");
const maxd = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const names = ["coldest", "hottest", "median", "thickest-buffer", "thinnest-sic"];
const parts = [["interior", "pl"], ["iface", "lin"], ["gap", "pl"], ["out", "pl"]];
for (const N of [12, 24, 48, 96]) {
  console.log(`--- N=${N}: max |scheme - FEED series| (K)`);
  for (const nm of names) {
    const run = JSON.parse(fs.readFileSync(`docs/spike/triso-interface-probe/runs/triso-pop-${nm}-N${N}.json`, "utf8"));
    const ser = chain(run.eq, N, SERIES).T;
    const row = [nm.padEnd(16)];
    row.push("full " + maxd(chain(run.eq, N, OFFB).T, ser).toFixed(4));
    for (const [p, v] of parts) row.push(p + "-only " + maxd(chain(run.eq, N, { ...SERIES, [p]: v }).T, ser).toFixed(4));
    row.push("kernel-centre signed (full) " + (chain(run.eq, N, OFFB).T[0] - ser[0]).toFixed(4));
    console.log(row.join(" | "));
  }
}
