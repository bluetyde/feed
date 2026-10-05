#!/usr/bin/env python3
"""Reads an OFFBEAT thermal case's final-time fields into one JSON file (the raw material for the results parser, plan 03).
Needs cell centres: run `postProcess -func writeCellCentres -latestTime` first (run-oracle.sh does).

usage: extract-result.py <caseDir> <out.json>
"""
import json, os, re, sys


def time_dirs(case):
    out = []
    for d in os.listdir(case):
        try:
            out.append((float(d), d))
        except ValueError:
            pass
    return [d for _, d in sorted(out)]


def read_list(path, vector=False):
    """internalField of a volScalarField/volVectorField as a list; also returns the text for boundary parsing."""
    text = open(path).read()
    m = re.search(r"internalField\s+nonuniform\s+List<\w+>\s*(\d+)\s*\(", text)
    if not m:
        m2 = re.search(r"internalField\s+uniform\s+([^;]+);", text)
        raise SystemExit("uniform internalField not supported here: %s" % (m2.group(1) if m2 else path))
    n = int(m.group(1))
    body = text[m.end():]
    if vector:
        vals = re.findall(r"\(\s*([-+.\deE]+)\s+([-+.\deE]+)\s+([-+.\deE]+)\s*\)", body)[:n]
        return [[float(a) for a in v] for v in vals], text
    vals = []
    for line in body.splitlines():
        line = line.strip()
        if line == ")":
            break
        if line:
            vals.append(float(line))
        if len(vals) == n:
            break
    return vals, text


def patch_value(text, patch):
    m = re.search(r"\b%s\s*\{(.*?)\n\s*\}" % re.escape(patch), text, re.S)
    if not m:
        return None
    v = re.search(r"value\s+uniform\s+([-+.\deE]+)", m.group(1))
    if v:
        return float(v.group(1))
    v = re.search(r"value\s+nonuniform\s+List<scalar>\s*\d+\s*\(\s*([-+.\deE]+)", m.group(1))
    return float(v.group(1)) if v else None


def main(case, out):
    times = time_dirs(case)
    last = times[-1]
    T, ttext = read_list(os.path.join(case, last, "T"))
    C, _ = read_list(os.path.join(case, last, "C"), vector=True)
    r = [(c[0] ** 2 + c[1] ** 2) ** 0.5 for c in C]
    res = {
        "time": float(last),
        "timesWritten": times,
        "nCells": len(T),
        "r": r,
        "T": T,
        "cladOuterWallT": patch_value(ttext, "cladOuter"),
    }
    json.dump(res, open(out, "w"), indent=1)
    print("cells", len(T), "r range", min(r), max(r), "T range", min(T), max(T), "wall", res["cladOuterWallT"])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
