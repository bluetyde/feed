# Tests

Acceptance gates are in [../PLAN.md](../PLAN.md); the verification design is [plan 04](../docs/plans/04-verification.md). Run with `npm test`.

- `oracleTable.test.ts`: the closed-form oracle table ([../oracles/closed-form-table.json](../oracles/closed-form-table.json)) against the implementation; twelve deliberately wrong implementations (mutants) must each fail it; refusal and out-of-domain entries.
- `crossCheck.test.ts`: the closed forms against an independent finite-volume solve (`helpers/fvRadial.ts`, test-only): synthetic pin, 25 randomized pins, conductivity integral, energy balance, second-order refinement, and wrong runs (conductivity, dropped gap, scaled power, swapped regions) that must fail.
- `validate.test.ts`: every good and bad vector in `schema/vectors/`; every error code has a bad vector and every emitted code is declared.

No solver test exists yet (F0 is not done). A passing run here shows the oracle values and the validator are consistent with themselves and with a second method; it does not show any solver output is right.
