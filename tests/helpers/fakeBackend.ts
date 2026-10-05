// A scripted backend: writes the same native files solver/run-feed.sh writes, from saved real OFFBEAT output, with
// chosen faults. Lets the run manager be tested without the solver.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BackendOutcome, RunBackend } from "../../src/core/runManager";

export type Script = "good" | "good-exit-0" | "fatal" | "sigabrt" | "sigfpe" | "mesh-fails" | "truncated" | "nan" | "early-end" | "no-exit-record" | "infra-error" | "hang";

const golden = (f: string) => readFileSync(join(__dirname, "..", "golden", "offbeat-syn", f), "utf8");

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
        writeFileSync(join(nativeDir, "final", "T"), T.slice(0, T.indexOf("1101.0777")));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 139, 50000000);
        return { cancelled: false };
      }
      case "nan": {
        writeFileSync(join(nativeDir, "final", "T"), golden("T").replace("1299.6625", "nan"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        exit(0, 0, 50000000);
        return { cancelled: false };
      }
      case "good":
      case "good-exit-0":
        writeFileSync(join(nativeDir, "final", "T"), golden("T"));
        writeFileSync(join(nativeDir, "final", "C"), golden("C"));
        writeFileSync(join(nativeDir, "log.offbeat"), "Time = 5e+07 seconds\n");
        exit(0, script === "good" ? 139 : 0, 50000000);
        return { cancelled: false };
    }
  }

  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
    this.release.get(id)?.();
  }
}
