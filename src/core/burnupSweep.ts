// The cost of burnup on a pin: the closed-form centre temperature at a range of burnups, everything else as the case states it (docs/plans/10-burnup.md M4). No solver:
// every point is FEED's own closed form on the burnup law, so it is an INDEPENDENT ESTIMATE, labelled so; the solver's run at the case's own burnup is the check on the
// one point that is also a run. A frozen-burnup snapshot at each burnup: the gap, the power and the coolant are the case's, nothing evolves.
import { quickLook } from "./quickLook";
import { NFI_RANGE } from "./uo2Nfi";
import { validateCase } from "./validate";

/** The burnups of the plot, MWd/kgHM: every 5 up to 60 and the top of the model's range. The case's own burnup is added. */
export const SWEEP_BURNUPS: readonly number[] = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, NFI_RANGE.burnup[1]];

export interface SweepPoint {
  /** MWd/kgHM, heavy-metal basis. */
  burnup: number;
  /** The closed-form temperature of the fuel centre and of the fuel surface, K; absent when the case at this burnup is refused (then `problem` says why). */
  centreT?: number;
  fuelSurfaceT?: number;
  /** 'out-of-domain' when the fuel runs outside the temperature range of the model. */
  verdict?: "in-domain" | "out-of-domain";
  problem?: string;
}

export interface BurnupSweep {
  /** The case's own burnup, one of the points. */
  stated: number;
  points: SweepPoint[];
  note: string;
}

export const SWEEP_NOTE =
  "Closed-form estimates from FEED's own arithmetic on the burnup law, no solver run: a frozen-burnup snapshot at each burnup, with the gap, the power and the coolant as the case states them. Nothing evolves, so this is how the same pin would run with fuel of that burnup, not how a rod ages.";

/** The sweep of a valid case that has a burnup, or why there is none. */
export function burnupSweep(doc: unknown): { ok: true; sweep: BurnupSweep } | { ok: false; reason: string } {
  const v = validateCase(doc);
  if (!v.normalized) return { ok: false, reason: "the case is not valid: " + (v.errors[0]?.message ?? "see the problems list") };
  if (!v.normalized.burnup || v.normalized.fuelConductivity.kind !== "uo2-nfi") return { ok: false, reason: "the case has no burnup: the fuel's conductivity does not depend on it" };
  const stated = v.normalized.burnup.value;
  const grid = [...new Set([...SWEEP_BURNUPS, stated])].sort((a, b) => a - b);
  const points: SweepPoint[] = grid.map((B) => {
    const d = JSON.parse(JSON.stringify(doc));
    d.burnup = { ...d.burnup, value: { value: B, unit: "MWd/kgHM" } };
    const r = validateCase(d);
    if (!r.normalized) return { burnup: B, problem: r.errors[0]?.message ?? "refused" };
    const look = quickLook(r.normalized);
    return { burnup: B, centreT: look.temperatures.centreT, fuelSurfaceT: look.temperatures.fuelSurfaceT, verdict: look.verdict };
  });
  return { ok: true, sweep: { stated, points, note: SWEEP_NOTE } };
}
