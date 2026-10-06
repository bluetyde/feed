// Regenerates solver/results/upstream-baseline.json: the saved baseline of OFFBEAT's own example and verification cases on the pinned
// stack (F0 exit review, finding 8). It runs, in the feed-solver distro and in COPIES (nothing in OFFBEAT's tree is touched, nothing is
// deleted):
//   - Cases/testCases/generic_pwr_1D twice (solver/run-example.sh), compares the two runs byte for byte (solver/compare-runs.sh),
//     hashes the input files and the output files, and keeps the probe series of temperature and burnup;
//   - Cases/Verification/heatConservation and testUserParameters with their own Allrun (solver/run-upstream-verification.sh);
//   and copies what OFFBEAT itself recorded for those two in Cases/Verification/results.
// Run it again after a clean-distro rebuild and compare with `git diff`: on the pinned stack the hashes must not change.
//   usage: node scripts/make-upstream-baseline.cjs
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const repoInDistro = "/mnt/" + root[0].toLowerCase() + root.slice(2).replace(/\\/g, "/");
const pins = Object.fromEntries(
  fs
    .readFileSync(path.join(root, "solver", "pins.env"), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

/** Run a bash command line in the distro as user feed; returns { code, out } with carriage returns removed. */
function distro(cmd) {
  const r = spawnSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", "-c", cmd], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, "") };
}
function script(name, ...args) {
  const r = spawnSync("wsl.exe", ["-d", "feed-solver", "-u", "feed", "--exec", "bash", repoInDistro + "/solver/" + name, ...args], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
}
const must = (r, what) => {
  if (r.code !== 0) throw new Error(what + " failed (exit " + r.code + "): " + (r.err || r.out).slice(0, 600));
  return r;
};
const OFF = "~/OpenFOAM/feed-9/applications/solvers/offbeat";
const stamp = Date.now().toString(36);

// ---- the pinned stack
const commit = distro(`git -C ${OFF} rev-parse HEAD`).out.trim();
if (commit !== pins.OFFBEAT_COMMIT) throw new Error("PIN MISMATCH: OFFBEAT is at " + commit + ", the pin is " + pins.OFFBEAT_COMMIT);
const commitDate = distro(`git -C ${OFF} log -1 --format=%cI`).out.trim();

// ---- generic_pwr_1D, twice
const tags = ["a", "b"].map((x) => `baseline-${stamp}-${x}`);
const runs = tags.map((t) => {
  const r = must(script("run-example.sh", "generic_pwr_1D", t), "run-example.sh " + t);
  // the run tag and the wall time are left out: they differ on every run and would make every regeneration a different file
  return { offbeatExit: Number(/offbeat exit (\d+)/.exec(r.out)?.[1]) };
});
const dirOf = (t) => `generic_pwr_1D-${t}`;
const OUTPUT_FILES = ["31500000/T", "31500000/Bu", "31500000/D", "postProcessing/probes/0/T", "postProcessing/probes/0/Bu"];
const cmp = script("compare-runs.sh", dirOf(tags[0]), dirOf(tags[1]), ...OUTPUT_FILES);
const sums = (rel) => Object.fromEntries(distro(`cd ~/runs/${dirOf(tags[0])} && sha256sum ${rel} | sort -k2`).out.trim().split("\n").map((l) => { const [h, f] = l.split(/\s+/); return [f, h]; }));
const inputFiles = distro(`cd ~/runs/${dirOf(tags[0])} && find rodDict constant system 0 -type f | sort | tr '\\n' ' '`).out.trim();
const log = distro(`cat ~/runs/${dirOf(tags[0])}/log.offbeat`).out;
const probe = (name) =>
  distro(`cat ~/runs/${dirOf(tags[0])}/postProcessing/probes/0/${name}`)
    .out.split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.trim().split(/\s+/).slice(0, 2).map(Number));
const probeT = probe("T");
const probeBu = probe("Bu");
const timeDirs = distro(`cd ~/runs/${dirOf(tags[0])} && ls -d [0-9]* | tr '\\n' ' '`).out.trim().split(/\s+/);

// ---- OFFBEAT's own verification cases, run with their own Allrun, and what upstream recorded for them
function verification(name) {
  const r = must(script("run-upstream-verification.sh", name, `baseline-${stamp}`), "run-upstream-verification.sh " + name);
  return r.out.split("== results\n")[1].trim().split("\n");
}
const recordedAll = distro(`cat ${OFF}/Cases/Verification/results`).out;
const recordedSection = (name) => {
  const lines = recordedAll.split("\n");
  const i = lines.findIndex((l) => l.trim() === name + "/:");
  const out = [];
  for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) out.push(lines[j].trim());
  return out;
};
const heat = verification("heatConservation");
const user = verification("testUserParameters");
const num = (lines, re) => Number(new RegExp(re).exec(lines.join("\n"))[1]);

const baseline = {
  about: "Saved baseline of OFFBEAT's own example and verification cases on the pinned stack (F0 exit review finding 8). Generated by scripts/make-upstream-baseline.cjs; see docs/spike/F0-note.md section 'Upstream example baseline'.",
  pins: { offbeatCommit: commit, offbeatCommitDate: commitDate, openfoam: "Foundation 9", openfoamPackage: pins.OPENFOAM_PACKAGE + " " + pins.OPENFOAM_VERSION },
  tolerances: {
    sameStack: "the files listed under example.outputSha256 are byte-identical (sha256) on the pinned stack",
    otherStack: "after a rebuild or on another machine, if the bytes differ: every probe temperature within 0.01 K, every probe burnup within a relative 1e-4, the heat numbers within 0.01 W, the testUserParameters temperature within 0.05 K",
    publishedFigure: "every digitized point of the tutorial figure inside a +-2 pixel tube around the probe curve (docs/sources/offbeat-lwr1d-tutorial-fig4.json)",
    upstreamCriteria: "testUserParameters: upstream's own pass rule, relative error below 0.5% of its expected 1040.01 K; heatConservation: upstream states no rule, 0.1% of the expected 300 W is used here",
  },
  example: {
    case: "Cases/testCases/generic_pwr_1D",
    howRun: "solver/run-example.sh generic_pwr_1D <tag>: cp -rL of the case, python3 rodMaker.py, blockMesh, offbeat (serial)",
    scope: "a full fuel-performance model (burnup, fission-gas release, gap gas, mechanics with creep and plasticity, time-dependent power), not the thermal subset FEED uses; the saved comparison covers the temperature and burnup probe at (0 0 1.5) and the byte identity of the final fields",
    runs,
    determinism: { files: OUTPUT_FILES, compareExit: cmp.code, compareOutput: cmp.out.trim().split("\n") },
    steps: Number(/Total Timesteps = (\d+)/g.exec(log.split("Execution Time").slice(-1)[0] ? "Execution Time" + log.split("Execution Time").slice(-1)[0] : "")?.[1]),
    timeDirs,
    inputFiles: inputFiles.split(/\s+/),
    inputSha256: sums(inputFiles),
    outputSha256: sums(OUTPUT_FILES.join(" ")),
    probe: { point: "(0 0 1.5)", temperatureK: probeT, burnupMWdPerTonne: probeBu },
    summary: { peakK: Math.max(...probeT.map((p) => p[1])), peakAtDays: probeT.reduce((b, p) => (p[1] > b[1] ? p : b))[0] / 86400, finalK: probeT[probeT.length - 1][1], finalBurnupMWdPerKg: probeBu[probeBu.length - 1][1] / 1000, finalTimeS: probeT[probeT.length - 1][0] },
  },
  verification: {
    heatConservation: {
      howRun: "solver/run-upstream-verification.sh heatConservation <tag> (the case's own Allrun, in a copy)",
      ours: { fuelOuterW: num(heat, "fuelOuter patch: ([0-9.eE+-]+) W"), cladInnerW: num(heat, "cladInner patch: ([0-9.eE+-]+) W"), expectedW: num(heat, "heat produced: ([0-9.eE+-]+) W") },
      oursRaw: heat,
      upstreamRecorded: recordedSection("heatConservation"),
    },
    testUserParameters: {
      howRun: "solver/run-upstream-verification.sh testUserParameters <tag> (the case's own Allrun, in a copy; perturbation 1.25 of the behavioural models)",
      ours: { probeTemperatureK: num(user, "1.25 : ([0-9.eE+-]+) K"), expectedK: num(user, "perturb. 1.25: ([0-9.eE+-]+) K"), relativeError: num(user, "Relative error: ([0-9.eE+-]+)") },
      oursRaw: user,
      upstreamRecorded: recordedSection("testUserParameters"),
    },
    upstreamResultsFile: { path: "Cases/Verification/results", sha256: distro(`sha256sum ${OFF}/Cases/Verification/results`).out.split(" ")[0], date: recordedAll.split("\n")[4].trim() },
  },
};
fs.writeFileSync(path.join(root, "solver", "results", "upstream-baseline.json"), JSON.stringify(baseline, null, 1) + "\n");
console.log("saved solver/results/upstream-baseline.json:", probeT.length, "probe points; compare exit", cmp.code, "; heat", baseline.verification.heatConservation.ours, "; user", baseline.verification.testUserParameters.ours);
