// Checks a clean rebuild of the solver distro against the original and against the evidence saved in this repository
// (F0 exit review, finding 1: "record one fresh-import rebuild with a package and compiler inventory and newly generated oracle
// comparisons meeting the existing tolerances"). The rebuild itself is: import the pinned Ubuntu rootfs under a new name, run
// solver/setup-feed-solver.sh as root, then solver/build-offbeat.sh as user feed (docs/spike/F0-note.md, 'Clean-distro rebuild').
//
//   usage: node scripts/verify-rebuild.cjs <rebuilt distro name>
//
// It compares, in this order, and writes solver/rebuild/rebuild-report.json and solver/rebuild/packages-rebuild.txt:
//   1. identity: OFFBEAT commit and working tree, the openfoam9 package version, the run user, the compiler, OpenFOAM's version;
//   2. the installed package inventory against the original distro's;
//   3. the licence texts the pinned stack ships (solver/collect-licences.sh) against docs/licences/third-party/SHA256SUMS;
//   4. every saved oracle result in solver/results regenerated in the rebuild with solver/run-oracle.sh, compared with the saved file;
//   5. the upstream baseline (scripts/make-upstream-baseline.cjs) regenerated in the rebuild, compared with the saved one.
// Nothing in the original distro is changed and nothing is deleted.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const ORIGINAL = "feed-solver";
const REBUILD = process.argv[2];
if (!REBUILD || REBUILD === ORIGINAL) {
  console.error("usage: node scripts/verify-rebuild.cjs <rebuilt distro name>   (not the original, " + ORIGINAL + ")");
  process.exit(2);
}
const inDistro = "/mnt/" + root[0].toLowerCase() + root.slice(2).replace(/\\/g, "/");
const toDistro = (p) => "/mnt/" + p[0].toLowerCase() + path.resolve(p).slice(2).replace(/\\/g, "/");
const wsl = (distro, user, args) => {
  const r = spawnSync("wsl.exe", ["-d", distro, "-u", user, "--exec", ...args], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
};
const sh = (distro, cmd, user = "feed") => wsl(distro, user, ["bash", "-c", cmd]);
const OFF = "~/OpenFOAM/feed-9/applications/solvers/offbeat";
const stamp = Date.now().toString(36);
const report = { about: "Clean-distro rebuild verification, made by scripts/verify-rebuild.cjs", rebuiltDistro: REBUILD, originalDistro: ORIGINAL };

// ---- 1. identity
const identity = (d) => ({
  offbeatCommit: sh(d, `git -C ${OFF} rev-parse HEAD`).out.trim(),
  offbeatWorkingTree: sh(d, `git -C ${OFF} status --porcelain`).out.trim().split("\n").filter(Boolean),
  openfoamPackage: sh(d, "dpkg-query -W -f='${Version}' openfoam9").out.trim(),
  runUser: sh(d, "id feed").out.trim(),
  compiler: sh(d, "gcc --version | head -1").out.trim(),
  openfoam: sh(d, "set +eu; source /opt/openfoam9/etc/bashrc; echo $WM_PROJECT_VERSION").out.trim(),
  os: sh(d, "grep PRETTY_NAME /etc/os-release").out.trim(),
});
const a = identity(ORIGINAL);
const b = identity(REBUILD);
report.identity = { original: a, rebuilt: b, same: JSON.stringify(a) === JSON.stringify(b) };

// ---- 2. packages
const packages = (d) => new Map(sh(d, "dpkg-query -W -f='${binary:Package}\\t${Version}\\n' | sort", "root").out.trim().split("\n").map((l) => l.split("\t")));
const pa = packages(ORIGINAL);
const pb = packages(REBUILD);
const onlyOriginal = [...pa.keys()].filter((k) => !pb.has(k)).sort();
const onlyRebuilt = [...pb.keys()].filter((k) => !pa.has(k)).sort();
const versionDiffs = [...pa.keys()].filter((k) => pb.has(k) && pa.get(k) !== pb.get(k)).map((k) => ({ package: k, original: pa.get(k), rebuilt: pb.get(k) }));
fs.mkdirSync(path.join(root, "solver", "rebuild"), { recursive: true });
fs.writeFileSync(path.join(root, "solver", "rebuild", "packages-rebuild.txt"), [...pb].map(([k, v]) => k + "\t" + v).join("\n") + "\n");
report.packages = { original: pa.size, rebuilt: pb.size, onlyInOriginal: onlyOriginal, onlyInRebuilt: onlyRebuilt, versionDifferences: versionDiffs };

// ---- 3. licence texts
const licDir = path.join(os.tmpdir(), "feed-rebuild-licences-" + stamp);
const lic = wsl(REBUILD, "feed", ["bash", inDistro + "/solver/collect-licences.sh", toDistro(licDir)]);
const savedSums = fs.readFileSync(path.join(root, "docs", "licences", "third-party", "SHA256SUMS"), "utf8");
const newSums = fs.existsSync(path.join(licDir, "SHA256SUMS")) ? fs.readFileSync(path.join(licDir, "SHA256SUMS"), "utf8") : "";
report.licences = { collectExit: lic.code, sameHashesAsSaved: newSums !== "" && newSums === savedSums, note: lic.code === 0 ? undefined : (lic.err || lic.out).slice(0, 400) };

// ---- 4. the saved oracle results, regenerated
const casesDir = path.join(root, "solver", "cases");
const resultsDir = path.join(root, "solver", "results");
const oracle = [];
for (const f of fs.readdirSync(casesDir).filter((n) => n.endsWith(".params.json")).sort()) {
  const saved = path.join(resultsDir, f.replace(".params.json", ".json"));
  if (!fs.existsSync(saved)) continue; // a params file with no saved result (the unnumbered synthetic-pin one)
  const tag = `rb-${stamp}-${f.replace(".params.json", "")}`;
  const run = wsl(REBUILD, "feed", ["bash", inDistro + "/solver/run-oracle.sh", inDistro + "/solver/cases/" + f, tag]);
  const got = sh(REBUILD, `cat ~/runs/oracle-${tag}/result.json`);
  let identical = false;
  let maxAbsT = null;
  try {
    const x = JSON.parse(got.out);
    const y = JSON.parse(fs.readFileSync(saved, "utf8"));
    identical = JSON.stringify(x) === JSON.stringify(y);
    maxAbsT = x.T.length === y.T.length ? Math.max(...x.T.map((v, i) => Math.abs(v - y.T[i]))) : null;
  } catch (e) {
    identical = false;
  }
  oracle.push({ params: f, saved: path.basename(saved), runExit: run.code, identical, maxAbsDifferenceK: maxAbsT });
}
report.oracleResults = { regenerated: oracle.length, allIdentical: oracle.length > 0 && oracle.every((o) => o.identical), runs: oracle };

// ---- 5. the upstream baseline
const tmpBaseline = path.join(os.tmpdir(), "feed-rebuild-baseline-" + stamp + ".json");
const gen = spawnSync(process.execPath, [path.join(root, "scripts", "make-upstream-baseline.cjs")], { encoding: "utf8", env: { ...process.env, FEED_DISTRO: REBUILD, FEED_BASELINE_OUT: tmpBaseline }, maxBuffer: 1 << 28 });
let baselineSame = false;
try {
  baselineSame = JSON.stringify(JSON.parse(fs.readFileSync(tmpBaseline, "utf8"))) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, "solver", "results", "upstream-baseline.json"), "utf8")));
} catch (e) {
  baselineSame = false;
}
report.upstreamBaseline = { generatorExit: gen.status, identicalToSaved: baselineSame, note: gen.status === 0 ? undefined : (gen.stderr || "").slice(0, 400) };

report.passed = report.identity.same && report.licences.sameHashesAsSaved && report.oracleResults.allIdentical && report.upstreamBaseline.identicalToSaved;
fs.writeFileSync(path.join(root, "solver", "rebuild", "rebuild-report.json"), JSON.stringify(report, null, 1) + "\n");
console.log(JSON.stringify({ passed: report.passed, identitySame: report.identity.same, packages: { original: pa.size, rebuilt: pb.size, onlyInOriginal: onlyOriginal.length, onlyInRebuilt: onlyRebuilt.length, versionDifferences: versionDiffs.length }, licencesSame: report.licences.sameHashesAsSaved, oracle: { n: oracle.length, allIdentical: report.oracleResults.allIdentical }, baselineIdentical: baselineSame }, null, 1));
