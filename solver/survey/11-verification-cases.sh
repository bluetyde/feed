#!/bin/bash
# read-only: OFFBEAT's own verification and test cases (candidates for the mechanics reference cases, docs/plans/09-mechanics.md)
B=/home/feed/OpenFOAM/feed-9/applications/solvers/offbeat/Cases
echo "== Verification"; ls "$B/Verification"
echo "== testCases"; ls "$B/testCases" | head -80
for d in "$B"/Verification/*/; do echo "-- $d"; ls "$d" | head -20; done
