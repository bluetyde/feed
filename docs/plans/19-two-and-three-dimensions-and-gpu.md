# Plan 19: Two and three dimensions, and whether a GPU helps

Status: **drafted 2026-10-24 on the owner's question ("what remains; when can 2D and 3D come into play; can GPU acceleration be done"). Not approved; nothing is built.** Every number about the machine was read on 2026-10-24; every statement about a library or a solver that was not run here is marked UNVERIFIED.

## 1. Where FEED stands on dimensions (facts from the repository)

| What | Solved by OFFBEAT | Checked against |
|---|---|---|
| A pin, plate or particle, one slice (radius, or through-thickness, or a sphere) | one-cell-wide wedge or slab | closed forms and a finite-volume solution, written without the solver |
| A stack of slices along the height (a pin or a plate) | **one (r, z) problem**, N layers per solid, end faces insulated (plan 12 A0); axial conduction is in OFFBEAT's cells | plates: FEED's own **two-dimensional (r, z) finite-volume reference** (plan 15, steady and transient). Pins: N one-dimensional solutions plus an **allowance** for the heat along the height (the owner kept it that way after plan 15 B0) |
| Mechanics (pin) | one radial slice, steady (plan 17 adds time) | the independent thermo-elastic solution (closed form) |
| Mechanics (particle) | a sphere | the independent layered-sphere solution |
| 3D | **nothing is solved in 3D.** The "3D view" draws the stack from the 1.5D result | none |

So two dimensions already **exist**: OFFBEAT solves (r, z) for every stack, and the plate stack has a matching independent reference. What does not exist: a two-dimensional reference for a stack of **pins**, two-dimensional **mechanics**, shaped pellets (dishes, chamfers), and anything with an **azimuthal** variation.

## 2. What "2D and 3D coming into play" can mean, and the gate for each

**(a) Pins on the 2D reference (small, and worth less than for plates). BUILT 2026-10-24 on branch claude/pins-2d, the middle option, on the owner's word; not merged until the owner says so.** Plan 15's kernel (`geometry.ts`) already serves pins and plates; the owner's decision after B0 (2026-10-16) was that a pin keeps the allowance, **because at TRIGA length the axial effect (1.06 K at 0.381 m) is smaller than the pin's own radial offset (about 3.4 K, from the cell-middle nodes with a logarithmic conductance, the same in the one-dimensional reference)**, so a 2D reference would not tighten the check there. It would pay for **short pins and steep power shapes**, where the allowance is large against the real effect (a 0.06 m plate: allowance 48 K for a 22.4 K deviation). The plan's own middle option is a reference used for a pin **only where the axial effect exceeds the radial bound**. It is also the base the 2D mechanics reference (D2) would stand on. Needs the owner's word. Cost: a few sessions, no new physics.

**(b) Two-dimensional mechanics (medium).** OFFBEAT's (r, z) mechanics with axial strain, an axial gap and contact at the pellet ends, and a stack with mechanics (today refused). The independent check needs an **axisymmetric finite-element solution** written in FEED (plan 17's M3 will already write a numerical solution with a modulus that varies with radius, in one dimension; (b) extends it). **Gate: plan 17 reaches M3**, because it fixes how mechanics results over time and the contact are checked.

**(c) Shaped geometry in 2D (medium).** Dished and chamfered pellets, a gap that varies along the height, a fuel with a stepped radius. Needs the case writer to generate a non-uniform (r, z) mesh and the references to follow it. No new physics, new mesh and new checks.

**(d) Three dimensions (large).** The pieces that need 3D are azimuthal: an eccentric pellet, cooling from one side, a plate with a non-uniform face, pellet chips. Needs, in order:
1. a **probe** that a 3D mesh runs in the pinned OFFBEAT (mesh generation, convergence, run time, the fields a reader needs, running in parallel: UNVERIFIED for every item, OFFBEAT's test cases in the distro were not found by name, only the solver source);
2. an **oracle that exists before the feature**: a **degenerate 3D case**, an axisymmetric pin meshed in 3D, must reproduce the (r, z) result to a stated tolerance; the asymmetric cases have closed forms only for simple thermal shapes (an eccentric annulus, a cos θ coolant variation on a cylinder: series solutions) and none for mechanics beyond small-perturbation formulas;
3. the 3D **view** shows fields, not only the 1.5D drawing (the view exists; fields on it are new);
4. 3D mechanics last.

**Gate: (a) and (b) done**, or the owner chooses a 3D case that cannot wait. Rough order: (a), then (b) and (c), then (d), each its own step with a design note, probe, reference case, mutation run and Codex review, as for every earlier plan.

## 3. What remains on FEED outside this plan

From TODO.md (14 open lines on 2026-10-24) and the 2026-10-20 decisions: plan 17 M2 to M7 (the stress through a TRIGA pulse, about 6 to 9 sessions, decisions D1 to D9 accepted, M0 and M1 done, the writer needs implicit contact and per-time fields); plan 14 M4 to M6 (the particle's mechanics in the editor; both carbon moduli as library entries, the case names one); plan 15 B6 (numerical expected values for the stack in the SEED oracle entries, next to the analytic ones: a request to SEED, not a FEED change); plan 18 (parity with OFFBEAT, P1 to P9; four owner questions open); the compact and pebble editor panel; the heating-to-particle transfer; SEED's answer to the two requests; the SEED equivalence item of plan 05; the release items the owner holds (the repository is public; the legal review line and the history rewrite stay the owner's); stages I and F of plan 14 (not approved).

## 4. Can a GPU help? What was found, and what it means

**On this machine (read 2026-10-24).** An NVIDIA GeForce RTX 5070 with 12 GB, driver 617.14. **CUDA is present through MATLAB R2026a**: its `bin\win64` holds the CUDA 12 runtime libraries (cudart, cublas, cudnn, nvrtc 12.0 and 12.8). The full **CUDA Toolkit is not installed** (no `nvcc`, no `CUDA_PATH`). The `feed-solver` WSL distro sees the GPU driver (`nvidia-smi -L` lists the card, `libcuda.so` is in `/usr/lib/wsl/lib`) but holds no CUDA toolkit, no PETSc, no AmgX, no Ginkgo. Sixteen cores and about 15 GB of memory are visible to the distro. The solver is OpenFOAM 9 (Foundation) with OFFBEAT at the pinned commit: **a CPU and MPI build**.

**Where the time goes today (measured).** The meshes are small: tens to a few thousand cells per slice, up to tens of thousands for a stack. A steady case takes seconds. A pulse with mechanics takes 70 to 130 s of CPU for 2000 steps (plan 17 M0, 55 to 140 times the thermal-only run), and the cost there is the number of contact and displacement iterations per step, not the size of the matrices. A GPU gives **no gain on a problem this small**: moving the data and launching the kernels costs more than the solve. The same holds for FEED's own finite-volume references (a banded solve of up to a few million unknown-steps, 25 s at most in the worker): they are small, banded and already inside the deadline.

**Where a GPU could help, and what stands in the way.**

| Place | Would it help | What stands in the way |
|---|---|---|
| OFFBEAT on a 3D mesh of about 100 000 to 1 000 000 cells | **Possibly**, in the linear solves (displacement and temperature, algebraic multigrid) | OpenFOAM 9 has no GPU solver. The usual route is an external library coupled to OpenFOAM (PETSc with CUDA, AmgX, a Ginkgo-based wrapper): whether one builds against OpenFOAM Foundation 9 and works with OFFBEAT's own segregated displacement solve and contact loop is **UNVERIFIED** and is engineering, not a switch. It needs the CUDA Toolkit installed in the distro (a download of several GB, the owner's decision) |
| FEED's own references on a 3D problem | Possibly, if they must solve above about 100 000 unknowns | An FEED-written 3D reference should stay small by structure (symmetry, banded or reduced forms), as the 2D one does. GPU code in the MIT repository adds a toolchain and a dependency the project has avoided; a prototype in MATLAB (gpuArray) can measure the gain first, with the repository depending on none of it (MATLAB is licensed: prototypes only) |
| Populations and sweeps (many independent cases) | **No need.** A population of 100 000 particles takes 0.3 s on worker threads today | none |
| The regression suite | No (CPU time is in process start and the real solver, not in linear algebra) | none |

**A limit of the card.** A GeForce card runs double precision (the precision these solvers use) at a small fraction of its single-precision rate (the usual figure for recent GeForce cards is 1/64; to be measured on this card, not assumed). The usual workaround is a single-precision multigrid preconditioner with a double-precision outer iteration; whether the library route supports it is UNVERIFIED.

**Cheaper speed-ups first, none needing a GPU.**
- **Overlap the independent runs with OFFBEAT.** Today a transient's independent runs start only **after** OFFBEAT has finished (`runManager.ts`, the post-run reading), although they need only the normalised case, not OFFBEAT's output. Starting them with the solver makes the wall time the larger of the two instead of their sum. **Measured 2026-10-24** (one run each through the real solver and the run manager, wall clock, the machine not verified idle, so indicative): a pulse took 7.2 s in all, of which the independent runs took 0.1 s (an overlap would save about 1 %); the plate stack with its cooling lost took 7.8 s, of which the independent runs took 0.4 s and the stack's two-dimensional reference 3.7 s (an overlap would save about 3.7 s, a little under half). A steady case has no independent runs (closed forms) and a mechanics pulse is dominated by the solver's 70 to 130 s. The saving is real only for stacks, and the estimate in an earlier version of this plan ("a few seconds for a pulse, up to about 25 s for a large stack") was wrong for the pulse and was the cap, not a measurement, for the stack.
- **Split the "full" job** (the same-mesh run, the doubled-mesh run and the half-step run, one worker thread, one after another) into three threads, and the 2D reference's base, half-step and doubled-mesh solves likewise: **not worth doing** by the measurement above (the three runs took 0.4 s together; the reference's 3.7 s would be hidden behind OFFBEAT's once overlapped). Revisit only if the work cap is raised.
- MPI decomposition of one OFFBEAT run across the 16 cores (`mpirun` is in the distro; whether OFFBEAT's contact and the case writer survive `decomposePar` is UNVERIFIED and needs a probe on a 2D or 3D mesh).
- Fewer contact iterations: the plan 17 M0 finding (implicit contact converges where the explicit penalty does not) is itself the largest saving.
- The 2D reference's cost: now about 7 times the work after the coupled error estimates; the factorisation can be reused between the base, half-step and doubled-mesh solves.

**Decision rule for the GPU (proposed).** Do nothing about a GPU until a realistic 3D case exists. Then time it on the CPU with MPI. **Only if** a realistic 3D case takes more than about 30 minutes on the 16 cores, probe a GPU linear-solver library inside the distro, in a clone, as a separate program (GPL OFFBEAT and any GPU library stay out of the MIT repository, as the solver does now; licences of the libraries are UNVERIFIED and checked first). Before that, measure with a throw-away MATLAB gpuArray version of a 3D conduction solve what size the break-even is on this card: a few hours' work, no change to FEED.

## 5. Steps (proposed; each needs the owner's word)

| Step | What | Gate |
|---|---|---|
| **D0** Probe | A 2D (r, z) mesh with shaped pellets and a 3D sector of a pin through the pinned OFFBEAT: does it mesh, converge, parallelise (`decomposePar`), and what does it cost; a throw-away MATLAB gpuArray timing of a conduction solve at 1e4, 1e5, 1e6 unknowns (double and single) | the probe note; stops the plan if a 3D mesh does not run |
| **D1** Pins on the 2D reference | **built 2026-10-24 (branch claude/pins-2d, the middle option):** a pin uses the reference only where the heat along the height exceeds its radial mesh bound; long pins keep the allowance | the owner reopened it, middle option |
| **D2** Two-dimensional mechanics | an axisymmetric finite-element independent solution, a stack with mechanics, the end contact | plan 17 M3 done |
| **D3** Shaped 2D geometry | non-uniform (r, z) meshes in the writer and the references | D1 |
| **D4** Three dimensions, thermal | a 3D case type, the degenerate-3D oracle, the series-solution oracles, fields on the 3D view | D0 gate met, D1 done |
| **D5** Parallel runs | start a transient's independent runs together with OFFBEAT instead of after it (measured: saves about half of a plate stack transient's 7.8 s, 1 % of a pulse's); splitting the runs over threads is not worth it; MPI decomposition of OFFBEAT only if D0 shows it works (and the meshes are large enough for it to matter) | none (can come first); helps transients, not steady cases or mechanics pulses |
| **D6** GPU probe | only under the decision rule above | a 3D case slower than about 30 minutes on 16 cores |
| **D7** Three dimensions, mechanics | after D2 and D4 | later |

## 6. Questions for the owner

1. Reopen "pins keep the allowance" (D1): wholesale, only for short pins and steep shapes (the plan 15 middle option), or not until 2D mechanics (D2) needs it?
2. Install the CUDA Toolkit in the `feed-solver` distro now (several GB), or only after D0 shows a case that needs it? (The MATLAB timing in D0 needs no installation.)
3. Which 3D case first, if any is wanted: an eccentric pellet, one-sided cooling, or a plate with a non-uniform face?
4. D5 (start the independent runs together with OFFBEAT) first? Measured: it saves about half the time of a stack transient and almost nothing for a pulse or a steady case.
