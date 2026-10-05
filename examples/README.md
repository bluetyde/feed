# Teaching cases

Each case carries a `label` (synthetic or sourced), units on every number, and in its `citation`/`description` what is read from where. Sourced cases are checked against the source's own numbers in `tests/`.

| File | What it is |
|---|---|
| `synthetic-pin.json` | Illustrative pin with closed-form answers (the oracle pin). Synthetic. |
| `annular-synthetic-pin.json` | The same with a 1 mm central hole (insulated). Synthetic. |
| `ksu-triga-hot-element.json` | K-State TRIGA hottest element, 1.25 MW, prescribed wall temperature; reproduces SAR Table 4.8. Sourced. |
| `ksu-triga-1p25mw-film.json` | The same with the SAR's film coefficient (eq. 7); reproduces eq. 9. The SAR's eq. 7 and Table 4.8 disagree by 8 K; see the case. Sourced. |
| `ut-triga-hot-channel-trace.json`, `ut-triga-hot-channel-annular.json` | UT-Austin hot channel against TRACE's digitized profile (Figure 4.30), solid and with the zirconium rod. Comparison cases, not oracles. Sourced, with values read from a figure. |

The solver is not redistributed with this repository; see the README for the licence and the third-party software note.
