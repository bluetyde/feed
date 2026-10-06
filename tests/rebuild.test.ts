// The clean-distro rebuild (F0 exit review, finding 1), kept as saved evidence: solver/rebuild/rebuild-report.json and packages-rebuild.txt,
// made by scripts/verify-rebuild.cjs after importing the pinned Ubuntu rootfs under a new name and running the two scripts. Runs without the solver.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const report = JSON.parse(read("solver/rebuild/rebuild-report.json"));
const pins = Object.fromEntries(
  read("solver/pins.env")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

describe("the clean rebuild reproduced the pinned stack", () => {
  it("passed every comparison, in a distro other than the original", () => {
    expect(report.passed).toBe(true);
    expect(report.originalDistro).toBe("feed-solver");
    expect(report.rebuiltDistro).toBe("feed-solver-rebuild");
  });

  it("the rebuilt distro has the pinned OFFBEAT commit, the pinned OpenFOAM package, the run user, gcc 11.4.0 and Ubuntu 22.04, same as the original", () => {
    const b = report.identity.rebuilt;
    expect(report.identity.same).toBe(true);
    expect(b.offbeatCommit).toBe(pins.OFFBEAT_COMMIT);
    expect(b.openfoamPackage).toBe(pins.OPENFOAM_VERSION);
    expect(b.runUser).toMatch(/^uid=1000\(feed\)/);
    expect(b.compiler).toMatch(/gcc .* 11\.4\.0/);
    expect(b.openfoam).toBe("9");
    expect(b.os).toMatch(/Ubuntu 22\.04/);
    expect(b.offbeatWorkingTree).toEqual(["M offbeatLib/Make/files"]); // only the symlink OFFBEAT's own build repoints to select the Foundation variant
  });

  it("the licence texts the rebuilt stack ships have the hashes saved in docs/licences", () => {
    expect(report.licences).toMatchObject({ collectExit: 0, sameHashesAsSaved: true });
  });

  it("every saved oracle result was regenerated in the rebuild and is identical to the saved file (largest difference 0 K)", () => {
    const o = report.oracleResults;
    const saved = readdirSync(join(root, "solver", "cases"))
      .filter((n) => n.endsWith(".params.json"))
      .map((n) => n.replace(".params.json", ".json"))
      .filter((n) => readdirSync(join(root, "solver", "results")).includes(n))
      .sort();
    expect(o.allIdentical).toBe(true);
    expect(o.regenerated).toBe(9);
    expect(o.runs.map((r: any) => r.saved).sort()).toEqual(saved);
    for (const r of o.runs) expect(r).toMatchObject({ runExit: 0, identical: true, maxAbsDifferenceK: 0 });
  });

  it("the upstream baseline regenerated in the rebuild equals the saved one (byte-identical final fields, same probe series, same verification numbers)", () => {
    expect(report.upstreamBaseline).toMatchObject({ generatorExit: 0, identicalToSaved: true });
  });
});

describe("the package inventory", () => {
  const inventory = read("solver/rebuild/packages-rebuild.txt").trim().split("\n");
  const p = report.packages;

  it("is the saved list of the rebuilt distro: sorted, one version per package, with the pinned OpenFOAM and compiler in it", () => {
    expect(inventory).toHaveLength(p.rebuilt);
    expect([...inventory].sort()).toEqual(inventory);
    expect(new Set(inventory.map((l) => l.split("\t")[0])).size).toBe(inventory.length);
    expect(inventory).toContain("openfoam9\t" + pins.OPENFOAM_VERSION);
    expect(inventory.find((l) => l.startsWith("gcc-11\t"))).toMatch(/11\.4\.0-1ubuntu1~22\.04\.3/);
  });

  it("the rebuild has nothing the original lacks, and what the original has extra is gdb and its libraries (installed by hand for the crash investigation)", () => {
    expect(p.onlyInRebuilt).toEqual([]);
    expect(p.onlyInOriginal).toEqual(["gdb", "libbabeltrace1:amd64", "libboost-regex1.74.0:amd64", "libc6-dbg:amd64", "libdebuginfod-common", "libdebuginfod1:amd64", "libipt2", "libsource-highlight-common", "libsource-highlight4v5"]);
  });

  it("the versions that differ are base-system packages the original was upgraded in; none is in the compiler, the C and C++ libraries, MPI, boost, CGAL, OpenFOAM or the build tools", () => {
    const toolchain = /^(gcc|g\+\+|cpp|libgcc|libstdc|libc6|libc-|libm|binutils|make|flex|bison|cmake|zlib|libopenmpi|openmpi|libboost|libcgal|openfoam|python3(\.10)?$|libpython3|libreadline|gnuplot|git$)/;
    expect(p.versionDifferences.length).toBeGreaterThan(0);
    for (const d of p.versionDifferences) {
      expect(d.package, d.package).not.toMatch(toolchain);
      expect(d.original).not.toBe(d.rebuilt);
    }
  });
});
