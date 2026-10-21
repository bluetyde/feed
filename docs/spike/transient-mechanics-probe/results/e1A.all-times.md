# e1A: every written time

| time | what | T fuel max K | contact (indep.) | P OFFBEAT MPa | P indep. (OFFBEAT T) MPa | err % | P indep. (FV T) MPa | err % | gap OFFBEAT / indep. um | disp | stress | equil | contact | disp / stress / contact (FV T) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5.0 ms |  | 294 | no | 0.00 | 0.00 | - | 0.00 | - | 19.88 / 19.89 | FAIL | FAIL | ok | ok | FAIL / FAIL / ok |
| 10.0 ms |  | 296 | no | 0.00 | 0.00 | - | 0.00 | - | 19.33 / 19.36 | FAIL | FAIL | ok | ok | FAIL / FAIL / ok |
| 15.0 ms |  | 307 | no | 0.00 | 0.00 | - | 0.00 | - | 16.79 / 16.94 | FAIL | FAIL | ok | ok | FAIL / FAIL / ok |
| 20.0 ms | before closing | 352 | no | 0.00 | 0.00 | - | 0.00 | - | 5.94 / 6.61 | FAIL | FAIL | FAIL | FAIL | FAIL / FAIL / FAIL |
| 25.0 ms | after closing | 503 | yes | 23.09 | 6.85 | 237.34 | 6.86 | 236.81 | 58.93 / 0.00 | FAIL | FAIL | ok | FAIL | FAIL / FAIL / FAIL |
| 30.0 ms | 30 ms | 781 | yes | 26.71 | 22.33 | 19.64 | 22.36 | 19.48 | 51.64 / 0.00 | FAIL | FAIL | ok | FAIL | FAIL / FAIL / FAIL |
| 35.0 ms |  | 995 | yes | 57.91 | 34.04 | 70.15 | 34.07 | 69.96 | 34.81 / 0.00 | FAIL | FAIL | ok | FAIL | FAIL / FAIL / FAIL |
| 40.0 ms |  | 1072 | yes | 45.54 | 37.83 | 20.38 | 37.87 | 20.26 | 86.97 / 0.00 | FAIL | FAIL | ok | FAIL | FAIL / FAIL / FAIL |
| 45.0 ms | peak P+end | 1091 | yes | 57.12 | 38.31 | 49.11 | 38.35 | 48.95 | 142.66 / 0.00 | FAIL | FAIL | ok | FAIL | FAIL / FAIL / FAIL |

times written: 9; with contact in both: 5; worst |P error| (OFFBEAT T): 237.34 %, (FV T): 236.81 %
failed checks over all written times (OFFBEAT T): disp 9, stress 9, equil 1, contact 6; (FV T): disp 9, stress 9, equil 1, contact 6
over the 5 times with contact: failed disp 5, stress 5, equil 0, contact 5

