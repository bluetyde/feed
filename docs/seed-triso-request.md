# Request to SEED: oracle entries for sampled coated particles, and what to do with a population

Written 2026-10-16 for the SEED agent, from FEED's plan 13, milestone T6. **Not sent. Nothing was pushed to SEED. Sending this is the user's decision**, not FEED's or the agent's. FEED has written 19 new oracle entries in a **separate folder, `oracles/seed-triso/`** (15 good, 4 bad-input, 0 known-limit), on the branch `claude/triso-t6` of FEED, **not on FEED's main**. The 125 entries of `oracles/seed` and their files are untouched (FEED's tests hash them), so SEED's `tests/feed-oracles.test.ts`, which accepts exact sets (92 or 101 on the version read, 2026-10-16), is not affected until SEED points `SEED_FEED_ORACLES` at the new folder or merges it on purpose.

## What is new

A **coated particle (TRISO)** is a sphere: a fuel kernel and two to four coating layers (buffer, inner pyrolytic carbon, silicon carbide, outer pyrolytic carbon). FEED's case for it has `geometry.kind: "triso"` and `assumptions.geometry: "1D-sphere"` ([triso.md](triso.md)); SEED passes the case to FEED unchanged. A particle's FEED result is `feed.results/0.1` with **`kind: "triso"`**: `cells` (the temperature of every cell with its radius and region), `regions` (for kernel, buffer, inner PyC, SiC, outer PyC: the temperature at the inner and outer face and the drop), `summary` and the usual `checks` and `domain`.

A **population** is not a new kind of run: it is N particles drawn from distributions the case states (a `population` section with a size, a seed and distributions of the kernel radius, each layer's thickness, a power factor and the matrix temperature), each run through FEED's independent closed form in a worker thread, and the spread reported. It is a **sample of a stated population, not a prediction for a real core**; FEED's model is thermal only. The entries do not pin the population. They pin **five sampled particles** of the example population (`examples/synthetic-triso-population.json`, 2000 particles, seed 20261016), each written out as a case of constants and run through the real solver: the hottest, the median, the coldest, the one with the thickest buffer and the one with the thinnest SiC layer.

| Case | Entries | What it tests |
|---|---|---|
| `triso-pop-hottest` (particle 1355) | kernel centre, buffer drop, gap drop | the hottest kernel of the 2000: 978.39 K |
| `triso-pop-median` (398) | the same three | the particle nearest the median: 928.93 K |
| `triso-pop-coldest` (817) | the same three | the coldest kernel: 867.63 K |
| `triso-pop-thickest-buffer` (1098) | the same three | a buffer of 123.5 um: the layer drop follows the sampled thickness |
| `triso-pop-thinnest-sic` (7) | the same three | a SiC layer of 30.3 um |
| 4 refusals | `case-validation` | a population of 0 particles (`E_OUT_OF_RANGE`), a truncation that cannot be sampled (`E_POPULATION_UNSAMPLABLE`), a distribution for a layer the particle lacks (`E_GEOMETRY`), a population on a pin (`E_UNSUPPORTED`) |

That is 15 good entries and 4 refusals. The only new refusal code is **`E_POPULATION_UNSAMPLABLE`**; the other three are in use already. If the adapter keeps a list of codes, add it.

## New quantities (SEED has to know them)

| Name | Unit | How FEED's result holds it | Kind |
|---|---|---|---|
| `temperature_kernel_centre` | K | `summary.kernelCentreT`: the first kernel cell plus the parabola's rise q R^2 / (6 k) over the cell's radius (the centre is **not** a cell centre, unlike `temperature_peak` of a pin) | new scalar, pinned by 5 entries |
| `temperature_drop_buffer` | K | `regions[1].drop`: the temperature at the buffer's inner face minus at its outer face | new scalar, **the per-layer quantity**, pinned by 5 entries |
| `temperature_drop_gap` | K | `summary.gapDeltaT`: the two patch values of the buffer-to-inner-PyC gap, inner minus outer | new scalar, pinned by 5 entries |

**The per-layer quantity is new for SEED.** FEED's result has the drop of **every** region (`regions[i].drop`: kernel, buffer, inner PyC, SiC, outer PyC) and of the film; the entries pin the buffer's because it is the largest and best resolved (11 to 14 K), and the gap's. The other layers' drops are 0.08 to 0.4 K at this power, below what a tolerance of the solver's resolution can pin meaningfully (the SiC's is 0.08 K); a hotter case would allow them. The question below is how SEED wants a per-region quantity: one scalar per region (as here), or a series over the regions.

**What SEED's adapter does with a particle today** (read in `adapters/feed/cli.cjs` and `docs/adapter-feed.md`, SEED main `4852a17`): `collect` accepts a steady `feed.results/0.1` result only with a non-empty `radial` list, which a particle record does not have, so it would refuse the result as `E_OUTPUT_INCOMPLETE`. The adapter needs a reader for `kind: "triso"` (the three quantities above, from the fields named) before these entries can run through it. `validate` already passes FEED's refusal codes through, so the four refusal entries need no change.

## How FEED reads each entry

- A **particle** is run and judged: closed form of the layered sphere at every cell's radius (one check per region), FEED's finite-volume solution cell by cell, the energy balance from the two outermost cells, the gap's drop, the wall, the steadiness and the property ranges. `collect` should refuse a particle whose checks fail, as for a pin.
- The mesh of every case is **48 cells in every region**. The solver's mesh is a 2 degree wedge of the sphere whose radii are lambda = 0.999695 times the case's (derived in `src/core/trisoWedge.ts`): the drops it gives are lambda^2 times the sphere's, the gap's lambda times. The tolerances carry that.

## How the expected values were made, and the tolerances

The expected value is the closed form of the layered sphere with constant conductivities (the kernel's parabola, each shell's P/(4 pi k)(1/r1 - 1/r2), the gap's P/(4 pi R^2 h), the film), written out in `scripts/gen-seed-oracles-triso.cjs` in plain arithmetic, **with nothing from FEED's `src/core` and no solver output**. The generator carries **its own copy of the sampler** (xoshiro128**, splitmix32, Box-Muller) and picks the five particles itself; FEED's test holds that copy against FEED's sampler (the same five of the 2000, with the same values to 1e-12). Tolerances are fixed in the generator before any run and are part of each entry's hash:

1. **The mesh**: 0.5 % of the particle's internal rise (the kernel centre above the outer wall; FEED's own bound of a cell against the closed form) plus 5 x (the kernel's drop) / 48^2 (the pin's discretisation bound).
2. **The wedge**: (1 - lambda^2) of the expected value (for the gap's drop: 1 - lambda).
3. The sum, rounded up to 0.05 K (0.005 K for the gap's drop, which is 1 % of the drop + 0.005 K + the wedge term, FEED's `gapDrop` check).

The tolerances are 0.10 to 0.15 K for the kernel centre and the buffer's drop (about 0.6 to 0.9 % of the internal rise) and 0.01 K for the gap's drop (4 %).

## What the real solver gave

FEED's test (`tests/seedOracleTriso.test.ts`) runs the five committed cases through FEED's writer and run manager into the real solver (WSL distro `feed-solver`) with `FEED_SOLVER=1`, and keeps the output (`tests/golden/seed-oracles-triso/`) so that the comparison also runs without the solver. Every check of every run passes. Observed minus expected, with the tolerance:

| Entry | Expected | Solver minus expected | Tolerance |
|---|---|---|---|
| hottest: kernel centre / buffer drop / gap drop | 978.3868 K / 12.2051 K / 0.2752 K | -0.029 / -0.016 / -0.0001 K | 0.15 / 0.10 / 0.01 K |
| median | 928.9331 K / 12.5032 K / 0.26858 K | -0.034 / -0.020 / -0.0001 K | 0.15 / 0.10 / 0.01 K |
| coldest | 867.6299 K / 10.6732 K / 0.25315 K | -0.018 / -0.008 / -0.0001 K | 0.10 / 0.10 / 0.01 K |
| thickest buffer | 916.1762 K / 12.5130 K / 0.22643 K | -0.055 / -0.037 / -0.0001 K | 0.10 / 0.10 / 0.01 K |
| thinnest SiC | 930.6547 K / 13.4277 K / 0.26507 K | -0.048 / -0.030 / -0.0001 K | 0.15 / 0.15 / 0.01 K |

The solver is inside every tolerance; the most any uses is 55 % (the kernel centre of the thickest-buffer particle, 0.055 of 0.10 K) and the gap's drop uses 1 % of its tolerance. The five runs take a few seconds together. **A finding that shaped the cases:** on the 12 cells per region of FEED's other examples, four of these sampled particles failed the run's own finite-volume cross-check (0.046 to 0.19 K against bounds of 0.044 to 0.050 K) because OFFBEAT's error at the kernel-buffer interface grows with the buffer's thickness; on 48 cells every check passes. The entries therefore use 48 cells, and **say so**: a case run on 12 cells can be refused by FEED's own checks.

## Questions for SEED

1. **The adapter and the per-region quantity.** Will SEED's adapter read a particle's result (`kind: "triso"`) and collect `temperature_kernel_centre`, `temperature_drop_buffer` and `temperature_drop_gap`? Does SEED want **one scalar per region** (`temperature_drop_<region>`, as the entries do), a **series** `temperature_drop_by_region` over the regions (as the stack request asked for `temperature_peak_by_slice`), or a position (`at`) on a scalar? FEED can regenerate the entries either way.
2. **A batch (study) of a population: does SEED want to run the sampled particles itself?** Three ways, each real:
   - **(a) FEED runs the population, SEED sees one run.** FEED's closed form does thousands of particles a second; the result is the spread. Today a case with a `population` section is passed to `headless run` unchanged and **runs only the nominal particle** (the section is read and validated, not run); the population is run by FEED's editor and server route. A `headless` verb that runs it and writes a `feed.results` record of its own (statistics, histogram, rejected counts, the five representatives) is not built; it would be a new quantity family (`temperature_kernel_centre_p95`, ...). Want it?
   - **(b) SEED's sweep, for the representatives only.** The study sweep (SEED's `docs/sweeps.md`) has study parameters with bounds, runs cases one after another, 10 by default and 10000 at most. Five or ten OFFBEAT runs (the hottest, the median, the coldest, ...) are a sweep; two thousand are not (each is a full solver run). FEED can write the representatives as case files (`particleDocument`, in the tests today; an editor button or a verb `population-cases` is easy to add).
   - **(c) A statistic as an oracle.** An entry holds one scalar, so a population's mean can be pinned (the closed form's mean over the distributions is a quadrature: FEED's test does this for the Jensen correction), but a sampled percentile depends on the generator, which is bit-exact only on one JavaScript engine (the normal draw uses `Math.log` and `Math.cos`). FEED would pin a statistic with a tolerance of several standard errors, not to the digit. Is that useful to SEED?
3. **The seed.** SEED's adapter refuses a request `seed` (FEED is deterministic). The population's seed is part of the **case** (a named, stated input), not a request seed, so SEED passes it unchanged: please confirm that is what SEED wants, and that the replay policy (relative 1e-9) is fine for it.
4. **The folder.** `oracles/seed-triso/` is separate on purpose. Does SEED want one folder (a merge into `oracles/seed`, a new count of 144 = 94 good, 47 bad-input, 3 known-limit) or two? FEED will not change the 125 either way.
5. **The code `E_POPULATION_UNSAMPLABLE`** and the new warning `W_POPULATION_REJECTION` (a distribution loses more than 1 % of its draws to invalid values and the sample is conditioned on being valid) if the adapter keeps a list.

## Not covered

The other layers' drops (below the solver's resolution at this power), a transient particle, a temperature-dependent conductivity in a sampled particle (the closed form handles it; no entry), a particle on a mesh of 12 cells, a population's statistics, the packing fraction's arithmetic in a case (FEED's own tests), any real fuel: the numbers are illustrative and synthetic, and the model is thermal only. A power per particle from an OpenMC tally is not a transfer yet ([triso.md](triso.md), "Power from OpenMC"; question for SEED: is a `heating-to-particle` field wanted?).

## Files

`oracles/seed-triso/entries/feed-triso-pop-*` (15), `feed-bad-*` (4), `oracles/seed-triso/models/triso-pop-*.case.json` (5) and `bad-*.case.json` (4), `oracles/seed-triso/README.md`, `scripts/gen-seed-oracles-triso.cjs`, `tests/seedOracleTriso.test.ts`, `tests/golden/seed-oracles-triso/`; [triso.md](triso.md), `examples/synthetic-triso-population.json`.
