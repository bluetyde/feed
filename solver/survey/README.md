# The property-model survey's queries

Read-only shell scripts that were run against OFFBEAT's source at the pinned commit (`solver/pins.env`) inside the `feed-solver` distro, to produce [docs/spike/property-model-survey.md](../../docs/spike/property-model-survey.md). They only list, grep and print; they change nothing under OFFBEAT's tree. Every claim in the survey that is not marked "run" can be checked by repeating one of them.

Run one from PowerShell (not Git Bash, which rewrites `/mnt/...` paths):

```
wsl -d feed-solver -u feed --exec bash "/mnt/c/.../fuel-performance-studio/solver/survey/04-equations.sh" conductivity 60
wsl -d feed-solver -u feed --exec bash "/mnt/c/.../fuel-performance-studio/solver/survey/show.sh" materials/materialModel/constantMaterial.C 26 90
```

| Script | What it prints |
|---|---|
| `01-catalogue.sh` | the model families and every model file under `materials/materialModel` |
| `02-names-and-keywords.sh` | the registered name of each conductivity and heat-capacity model and the keywords it reads |
| `03-tables-and-selector.sh` | whether any property model is tabulated, `userParameters.H`, and the model selector (`New`) |
| `04-equations.sh <family> [lines]` | the body of `correct()` (the equation) and the constructor defaults of each model of `conductivity` or `heatCapacity` |
| `05-gap-models.sh`, `06-fuelrodgap.sh` | the gap boundary conditions and the gap-gas models |
| `07-fields-and-defaults.sh` | which fields each conductivity model needs, and the default models of each material class |
| `08-heatcapacity-fields.sh` | the same for heat capacity |
| `09-mechanics.sh`, `10-mechanics-details.sh` | OFFBEAT's mechanics solvers, constitutive laws, elasticity and expansion models, the mechanical boundary patch fields (for [plan 09](../../docs/plans/09-mechanics.md)) |
| `11-verification-cases.sh`, `12-mechanics-cases.sh` | OFFBEAT's own verification and test cases, and how its mechanics cases are set up |
| `show.sh <file> [from] [to]` | any file under `offbeatLib` with line numbers |

What was run rather than read is in `tests/propertyModelProbe.test.ts` (`FEED_SOLVER=1`).
