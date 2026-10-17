// Throw-away probe: OFFBEAT cells vs the chain schemes. Usage: node compare.cjs <runs/file.json> [profile]
const fs = require("fs");
const { chain, SERIES, OFFB } = require("./replica.cjs");
const run = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ser = chain(run.eq, run.N, SERIES), off = chain(run.eq, run.N, OFFB);
const maxd = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const oT = run.cells.map((c) => c.T);
console.log(run.name, "N", run.N, "max|OFFBEAT-FEED(series)|", maxd(oT, ser.T).toFixed(5), " max|OFFBEAT-replica|", maxd(oT, off.T).toExponential(2), " max|replica-FEED|", maxd(off.T, ser.T).toFixed(5));
if (process.argv[3]) oT.forEach((t, i) => console.log(i, run.cells[i].region, (t - ser.T[i]).toFixed(5), (t - off.T[i]).toExponential(2)));
