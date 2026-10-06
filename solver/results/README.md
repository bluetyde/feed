# Saved OFFBEAT outputs

Real solver output, saved so the tests run without the solver. Produced 2026-10-05 in the `feed-solver` distro with OpenFOAM Foundation 9 and OFFBEAT `80e84450a115b0c411e1bfa5d166379f6bf6c084` (see [../PINS.md](../PINS.md)).

| File | Case (params in `../cases/`) | Meaning |
|---|---|---|
| `synthetic-pin.mesh1..4.json` | `synthetic-pin.mesh1..4.params.json`: the synthetic oracle pin with 10/3, 20/6, 40/12, 80/24 fuel/cladding cells | refinement study |
| `steady-state-calibration.json` | the synthetic pin (10/3 cells) run to 10 end times from 2 s to 1e6 s (`../probe-nonconvergence.sh` with `PROBE_ENDTIME`), each against the 5e7 s run | the steady-state gate's bound against true deviations |
| `upstream-baseline.json` | OFFBEAT's `generic_pwr_1D` (twice, byte-compared) and its verification cases `heatConservation` and `testUserParameters`, with upstream's recorded numbers, made by `../../scripts/make-upstream-baseline.cjs` | the upstream baseline (F0 note) |
| `nonconvergence-probe.json` | the non-convergence probe (see the F0 note) | what OFFBEAT does at `maxOuterIter` |
| `ksu-hot-element.json` | `ksu-hot-element.params.json`: K-State TRIGA hot element, zero cold gap | sourced check against SAR Table 4.8 |

Each file holds the final time (5e7 s, a true steady state), cell-centre radius `r` (m), temperature `T` (K) and the outer-wall patch temperature. They are written by `../extract-result.py`; regenerate with `../run-oracle.sh <params> <tag>` and copy `result.json` out of `~/runs/oracle-<tag>/` in the distro.

**Steady state needs a long end time.** A first set of runs ended at 2000 s, which OFFBEAT covered in two steps (1 s, then one implicit step of 1999 s). The leftover heat-storage term made the fuel about 0.5 K cold and the error stopped shrinking with mesh refinement. At 5e7 s the error falls at close to second order. The first set was discarded.
