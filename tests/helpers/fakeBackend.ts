// A scripted backend: writes the same native files solver/run-feed.sh writes, from saved real OFFBEAT output, with
// chosen faults. Lets the run manager be tested without the solver.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { BackendOutcome, RunBackend } from "../../src/core/runManager";

export type Script = "triso-good" | "triso-no-zones" | "triso-wrong-zones" | "triso-no-patch" | "burnup-good" | "burnup-no-k" | "burnup-wrong-basis" | "status--1" | "status-0.5" | "status-256" | "exit-124" | "exit-137" | "bad-exit-record" | "log-is-dir" | "no-endtime" | "good" | "good-exit-0" | "fatal" | "unconverged" | "drifting" | "no-rate-record" | "exit-1-complete" | "fatal-in-log" | "no-iteration-records" | "sigabrt" | "sigfpe" | "mesh-fails" | "truncated" | "nan" | "early-end" | "no-exit-record" | "infra-error" | "hang";

const golden = (f: string) => readFileSync(join(__dirname, "..", "golden", "offbeat-syn", f), "utf8");
/** Real OFFBEAT logs from the non-convergence probe: one step that converged (6 outer iterations), one that hit its cap unconverged. */
/** The golden probe logs are one-second runs; a fake steady run ends at 5e7 s and the judge requires the log's last step to be at the final time (Codex review 2026-10-11), so the time label is moved. */
const atFinalTime = (log: string) => log.replace("Time = 1 seconds", "Time = 5e+07 seconds");
export const convergedLog = () => atFinalTime(readFileSync(join(__dirname, "..", "golden", "offbeat-convergence", "converged-1s.log.txt"), "utf8"));
/** The real log of a full steady run (84 time steps to 5e7 s; the last step printed a relative temperature change of -0). */
export const steadyLog = () => readFileSync(join(__dirname, "..", "golden", "offbeat-convergence", "steady-full-run.log.txt"), "utf8");
export const unconvergedLog = () => atFinalTime(readFileSync(join(__dirname, "..", "golden", "offbeat-convergence", "capped-unconverged.log.txt"), "utf8"));

export class FakeBackend implements RunBackend {
  runs: string[] = [];
  cancels: string[] = [];
  private release = new Map<string, () => void>();
  constructor(private script: Script | ((n: number) => Script)) {}

  private pick(): Script {
    return typeof this.script === "function" ? this.script(this.runs.length) : this.script;
  }

  async run({ id, nativeDir }: { id: string; inputsDir: string; nativeDir: string; timeoutMs: number }): Promise<BackendOutcome> {
    const script = this.pick();
    this.runs.push(id);
    mkdirSync(join(nativeDir, "final"), { recursive: true });
    const exit = (blockMeshExit: number, offbeatExit: number, finalTime: number) => writeFileSync(join(nativeDir, "exit.json"), JSON.stringify({ blockMeshExit, offbeatExit, finalTime }));
    switch (script) {
      case "infra-error":
        throw new Error("wsl.exe not found");
      case "hang":
        await new Promise<void>((resolve) => this.release.set(id, resolve));
        return { cancelled: true };
      case "no-exit-record":
        return { cancelled: false };
      case "mesh-fails":
        writeFileSync(join(nativeDir, "log.blockMesh"), "--> FOAM FATAL ERROR:\ncannot create mesh\n");
        exit(1, -1, 0);
        return { cancelled: false };
      case "fatal":
        writeFileSync(join(nativeDir, "log.offbeat"), "Create mesh\n--> FOAM FATAL IO ERROR:\nkeyword lhgr is undefined in dictionary\n\nFOAM exiting\n");
        exit(0, 1, 0);
        return { cancelled: false };
      case "sigabrt":
        writeFileSync(join(nativeDir, "log.offbeat"), "--> FOAM FATAL IO ERROR:\nunknown material\n#3 Foam::constantLhgr\n");
        exit(0, 134, 0);
        return { cancelled: false };
      case "sigfpe":
        writeFileSync(join(nativeDir, "log.offbeat"), "Time = 1\n#5 Foam::LimbackCreepModel::correctCreep\n");
        exit(0, 136, 0);
        return { cancelled: false };
      case "early-end":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 139, 1000);
        return { cancelled: false };
      case "truncated": {
        const T = golden("T");
        writeFileSync(join(nativeDir, "log.offbeat"), steadyLog()); // a converged run whose field file is cut short
        writeFileSync(join(nativeDir, "final", "T"), T.slice(0, T.indexOf("1101.0777")));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 139, 50000000);
        return { cancelled: false };
      }
      case "nan": {
        writeFileSync(join(nativeDir, "log.offbeat"), steadyLog()); // a converged run whose field has a nan
        writeFileSync(join(nativeDir, "final", "T"), golden("T").replace("1299.6625", "nan"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 0, 50000000);
        return { cancelled: false };
      }
      case "status--1":
      case "status-0.5":
      case "status-256":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, script === "status--1" ? -1 : script === "status-0.5" ? 0.5 : 256, 50000000);
        return { cancelled: false };
      case "exit-124":
      case "exit-137":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, script === "exit-124" ? 124 : 137, 50000000);
        return { cancelled: false };
      case "bad-exit-record":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        writeFileSync(join(nativeDir, "exit.json"), JSON.stringify({ blockMeshExit: 0, finalTime: 50000000 }));
        return { cancelled: false };
      case "log-is-dir":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 139, 50000000);
        rmSync(join(nativeDir, "log.offbeat"), { force: true });
        mkdirSync(join(nativeDir, "log.offbeat")); // reading it throws EISDIR
        return { cancelled: false };
      case "no-endtime": {
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 139, 1000); // would pass a gate whose intended end time defaulted to 0
        const mf = join(nativeDir, "..", "feed-manifest.json");
        const m = JSON.parse(readFileSync(mf, "utf8"));
        m.choices = {};
        writeFileSync(mf, JSON.stringify(m));
        return { cancelled: false };
      }
      // FEED's burnup case (40 MWd/kgHM) as the real OFFBEAT wrote it: the fields T C k Bu of the last time; with k missing, or with Bu on the wrong basis (0.8815 for 0.881)
      case "burnup-good":
      case "burnup-no-k":
      case "burnup-wrong-basis": {
        const b = (f: string) => readFileSync(join(__dirname, "..", "golden", "offbeat-burnup", f), "utf8");
        writeFileSync(join(nativeDir, "final", "T"), b("T"));
        writeFileSync(join(nativeDir, "final", "C"), b("C"));
        if (script !== "burnup-no-k") writeFileSync(join(nativeDir, "final", "k"), b("k"));
        const lines = b("Bu").split("\n");
        const start = lines.findIndex((l) => l.trim() === "(");
        const bu = script === "burnup-wrong-basis" ? lines.map((l, i) => (i > start && i <= start + 20 ? String((Number(l) * 0.8815) / 0.881) : l)).join("\n") : b("Bu");
        writeFileSync(join(nativeDir, "final", "Bu"), bu);
        writeFileSync(join(nativeDir, "log.offbeat"), steadyLog());
        exit(0, 139, 50000000);
        return { cancelled: false };
      }
      // a coated particle (tests/golden/offbeat-triso/steady): the real fields of the wedge, its cell zones and the real log of the run
      case "triso-good":
      case "triso-no-zones":
      case "triso-wrong-zones":
      case "triso-no-patch": {
        const t = (f: string) => readFileSync(join(__dirname, "..", "golden", "offbeat-triso", "steady", f), "utf8");
        writeFileSync(join(nativeDir, "final", "T"), script === "triso-no-patch" ? t("T").replace(/bufferOuter/g, "bufferOuterX") : t("T"));
        writeFileSync(join(nativeDir, "final", "C"), t("C"));
        // the buffer and the next layer's zones swapped by name: every cell is in a zone whose radii it is not within
        if (script === "triso-wrong-zones") writeFileSync(join(nativeDir, "final", "cellZones"), t("cellZones").replace(/Buffer/g, "XX").replace(/IPyC/g, "Buffer").replace(/XX/g, "IPyC"));
        else if (script !== "triso-no-zones") writeFileSync(join(nativeDir, "final", "cellZones"), t("cellZones"));
        writeFileSync(join(nativeDir, "log.offbeat"), t("log.offbeat.txt"));
        exit(0, 139, 50000000);
        return { cancelled: false };
      }
      case "good":
      case "good-exit-0":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        writeFileSync(join(nativeDir, "log.offbeat"), steadyLog());
        exit(0, script === "good" ? 139 : 0, 50000000);
        return { cancelled: false };
      // complete, finite output at the intended end time, each with one thing wrong that only the log or the exit status shows
      // converged, but OFFBEAT's last step still printed a drift that is too large to call steady, or printed none at all
      case "drifting":
      case "no-rate-record":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        writeFileSync(
          join(nativeDir, "log.offbeat"),
          script === "drifting" ? steadyLog() + "\nMaximum deltaT calculated by thermal subsolver: 1 with a relative temperature change of 0.001 K/s\n" : steadyLog().split("\n").filter((l) => !l.includes("relative temperature change")).join("\n"),
        );
        exit(0, 139, 50000000);
        return { cancelled: false };
      case "unconverged":
      case "exit-1-complete":
      case "fatal-in-log":
      case "no-iteration-records":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        writeFileSync(
          join(nativeDir, "log.offbeat"),
          script === "unconverged" ? unconvergedLog() : script === "no-iteration-records" ? "Time = 5e+07 seconds\n" : script === "fatal-in-log" ? steadyLog() + "\n--> FOAM FATAL ERROR:\nsomething after the last write\n" : steadyLog(),
        );
        exit(0, script === "exit-1-complete" ? 1 : 139, 50000000);
        return { cancelled: false };
    }
  }

  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
    this.release.get(id)?.();
  }
}
