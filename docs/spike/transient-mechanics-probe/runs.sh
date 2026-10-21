#!/usr/bin/env bash
# Throw-away (plan 17 M0): the exact arguments of every run of the probe, in the order they were made (each is `go.sh <tag> <gen-case.cjs arguments>`; go.sh generates the case, runs it in
# the feed-solver distro and prints the convergence of every step). The case and output folders go to $M0DIR (default: the session's scratch folder), so set M0DIR and M0WSL (the same
# folder as the distro sees it) before running anything. Run ONE at a time: a pulse with mechanics takes 1 to 2.5 minutes of one core. This file is a record, not a script to run whole.
cd "$(dirname "$0")/../../.."          # the clone; `npm run build` must have been run (the scripts read dist/core)
G=./docs/spike/transient-mechanics-probe/go.sh
COOL="--cool-s 100 --cool-dt-ms 50 --cool-outputs 100"
IMP="--implicit 1 --inner-bc traction"

# 1. FEED's writer as it is (explicit gapContact 0.7, the hole's zeroGradient, 1000 outer iterations): zero cold gap, stopped by hand at 25 ms; and a 20 micron gap for 45 ms
bash $G gap0-p07 --gap-um 0 --penalty 0.7            # (run by hand with run-case.sh, stopped; log in results/gap0-writer-as-is.log-summary.json)
bash $G w-g20-p07 --gap-um 20 --penalty 0.7 --end-ms 45 --outputs 9

# 2. what changes the convergence (45 ms windows, a cap of 100 outer iterations, 20 micron gap, the hole traction-free unless said)
for s in "e1A --penalty 0.7" "e1B --penalty 0.3"; do set -- $s; t=$1; shift; bash $G $t --gap-um 20 --max-outer 100 --end-ms 45 --outputs 9 "$@"; done   # the hole's zeroGradient
for s in "e2H1 --penalty 0.7" "e2H2 --penalty 0.3" "h-g20-p05 --penalty 0.5" "e2H3 --penalty 0.7 --relax 0.3" "e2H4 --penalty 0.7 --relax 0.8" "e2H5 --penalty 0.7 --ncorr 10" "e2H6 --penalty 0.7 --relax-interface 1.0" "e2H7 --penalty 0.7 --relax-interface 0.3"; do
  set -- $s; t=$1; shift; bash $G $t --gap-um 20 --max-outer 100 --end-ms 45 --outputs 9 --inner-bc traction "$@"; done
for s in "e3I1 --penalty 0.1" "e3I2 --penalty 0.05" "e3I3 --penalty 0.1 --relax-interface 0.03" "e3I4 --penalty 0.7 --implicit 1" "e3I5 --penalty 0.1 --implicit 1" "e3I6 --penalty 0.03"; do
  set -- $s; t=$1; shift; bash $G $t --gap-um 20 --max-outer 100 --end-ms 45 --outputs 9 --inner-bc traction "$@"; done

# 3. the grid: implicit contact, hole free, 1000 outer iterations, the pulse then a 100 s cooldown (a restart at 100 ms with a step of 50 ms), 100 + 100 outputs
for gap in 20 40 0; do for pf in 0.7 0.5 0.3; do
  bash $G i-g${gap}-p${pf/./} --gap-um $gap --penalty $pf $IMP --outputs 100 $COOL; done; done

# 4. the controls and the cost matrix (mechanics off; mechanics on without contact: a 300 micron gap with the cladding wall kept at 0.508 mm)
bash $G c-g20 --mech 0 --gap-um 20 --outputs 100 $COOL
bash $G c-g0 --mech 0 --gap-um 0 --outputs 100 $COOL
bash $G c-g40 --mech 0 --gap-um 40 --outputs 100 $COOL
bash $G c-g300 --mech 0 --gap-um 300 --keep-thickness 1 --outputs 100 $COOL
bash $G n-g300-p07 --gap-um 300 --keep-thickness 1 --penalty 0.7 $IMP --outputs 100 $COOL
bash $G x-g20-p01 --gap-um 20 --penalty 0.1 --inner-bc traction --outputs 100 $COOL        # the explicit contact at the factor that converges

# 5. question 5: OFFBEAT's own E(T) and thermal strain, and the restarts
bash $G l2-g20-p07 --gap-um 20 --penalty 0.7 $IMP --laws 1 --outputs 100 $COOL
bash $G r0b-g20 --gap-um 20 --penalty 0.7 $IMP --ref-ms 60 --outputs 100 $COOL
bash $G r1-g20 --gap-um 20 --penalty 0.7 $IMP --end-ms 60 --restart-to-ms 100 --outputs 60
bash $G r2-g20 --gap-um 20 --penalty 0.7 $IMP --end-ms 60 --restart-to-ms 100 --outputs 60 --stage2-e 35530355136.67851 --stage2-alpha 0.000012625690111017233   # a no-op: see the note
bash $G r3-g20 --gap-um 20 --penalty 0.7 $IMP --end-ms 60 --restart-to-ms 100 --outputs 60 --e-fuel 62.7e9 --alpha-fuel 1.0e-5 --stage2-e 35530355136.67851 --stage2-alpha 0.000012625690111017233

# 6. question 6: the inertial term of smallStrain switched on (d2dt2 Euler, the real densities), against the static scheme with the same constants, 45 ms
C="--gap-um 20 --penalty 0.7 --implicit 1 --inner-bc traction --outputs 45 --end-ms 45 --e-fuel 35594353231.85351 --alpha-fuel 0.000012608910821674068"
bash $G dyn2-g20 $C --dynamic 1
bash $G sta2-g20 $C

# the analysis of a run (needs the scratch folder of the run; --interp: the thermal strain linear between cell centres instead of piecewise constant)
#   node analyze.cjs $M0DIR/in-<tag> $M0DIR/out-<tag> --json $M0DIR/an-<tag>.json ; node table.cjs $M0DIR/an-<tag>.json ; node fails.cjs $M0DIR/an-<tag>.json [--fv]
#   node collect.cjs $M0DIR <tags...>   node combined-table.cjs $M0DIR 20   node summary-table.cjs $M0DIR <tags...>   node restart-compare.cjs <outA> <outB> <from s> <to s>
#   node tcompare.cjs <outMech> <outControl>   node q5-reduction-error.cjs   node q6-inertia.cjs   node penalty-gain.cjs   node vp.cjs (self-check of the law solver)
