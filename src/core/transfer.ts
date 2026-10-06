// Shared pieces of FEED's transfer commands (SEED's contract: seed.transfer-request/0.2, seed.transfer-recipe/0.2).
//
// The two transfers, `heating-to-pin` (transferRequest.ts) and `coolant-boundary` (transferBoundary.ts), read SEED's request. SEED owns
// the approval, the digests and the revisions; FEED owns the physics and the target case. FEED's earlier provisional boundary recipe
// (feed.transfer-recipe/0.1, its own approval and digest) was replaced by SEED's contract on 2026-10-06 and removed.
//
// Pure functions, no I/O; the case is never modified in place.

export interface TransferIssue {
  code: string;
  field: string;
  message: string;
}
export type Failed = { ok: false; errors: TransferIssue[] };

export interface Z {
  min: number;
  max: number;
}

/** Relative tolerance for comparing axial coordinates, as a fraction of the interval concerned. */
const REL_Z = 1e-9;

/** Do the (sorted) intervals overlap in their interiors? Returns the offending pair's index or -1. */
export function firstOverlap(zs: Z[]): number {
  const order = zs.map((z, i) => ({ z, i })).sort((a, b) => a.z.min - b.z.min);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!.z;
    const cur = order[k]!.z;
    const tol = REL_Z * Math.min(prev.max - prev.min, cur.max - cur.min);
    if (cur.min < prev.max - tol) return order[k]!.i;
  }
  return -1;
}
