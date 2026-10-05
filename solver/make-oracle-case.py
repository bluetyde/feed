#!/usr/bin/env python3
"""Builds a thermal-only OFFBEAT case (1D wedge, constant properties) from parameters, starting from a copy of the
upstream generic_pwr_1D test case. Parameters are SI. Run inside the feed-solver distro as user "feed".

usage: make-oracle-case.py <params.json> <outDir>

params.json: {"qPrime": W/m, "fuelRadius": m, "claddingInnerRadius": m, "claddingOuterRadius": m,
              "fuelK": W/m/K, "claddingK": W/m/K, "gapConductance": W/m2/K,
              "boundary": {"kind": "convective", "bulkTemperature": K, "h": W/m2/K} or {"kind": "surface-temperature", "temperature": K},
              "fuelCells": int, "claddingCells": int, "endTime": s, "initialTemperature": K}

This is the seed of the case writer (plan 03): a typed case in, solver files out, only modelled options written.
"""
import json, os, re, shutil, subprocess, sys

TEMPLATE = os.path.expanduser("~/OpenFOAM/feed-9/applications/solvers/offbeat/Cases/testCases/generic_pwr_1D")


def main(params_path, out):
    p = json.load(open(params_path))
    if os.path.exists(out):
        shutil.rmtree(out)
    shutil.copytree(TEMPLATE, out, symlinks=False)  # follows the rodMaker.py symlink
    os.chdir(out)

    # --- rodDict: geometry in mm, one fuel block, one cladding block, one axial cell
    rod = open("rodDict").read()
    mm = lambda v: repr(round(v * 1000.0, 9))

    def setkey(text, key, value):
        pat = re.compile(r"^('%s':\s*).*$" % re.escape(key), re.M)
        assert pat.search(text), key
        return pat.sub(lambda m: m.group(1) + value + ",", text, count=1)

    rod = setkey(rod, "nBlocksFuel", "1")
    rod = setkey(rod, "nBlocksClad", "1")
    rod = setkey(rod, "blockNameFuel", "['fuel']")
    rod = setkey(rod, "blockNameClad", "['cladding']")
    rod = setkey(rod, "rInnerFuel", "[0.0]")
    rod = setkey(rod, "rInnerClad", "[%s]" % mm(p["claddingInnerRadius"]))
    rod = setkey(rod, "rOuterFuel", "[%s]" % mm(p["fuelRadius"]))
    rod = setkey(rod, "rOuterClad", "[%s]" % mm(p["claddingOuterRadius"]))
    rod = setkey(rod, "heightFuel", "[1000]")
    rod = setkey(rod, "heightClad", "[1000]")
    rod = setkey(rod, "nCellsRFuel", "[%d]" % p["fuelCells"])
    rod = setkey(rod, "nCellsRClad", "[%d]" % p["claddingCells"])
    rod = setkey(rod, "nCellsZFuel", "[1]")
    rod = setkey(rod, "nCellsZClad", "[1]")
    open("rodDict", "w").write(rod)
    subprocess.check_call(["python3", "rodMaker.py"], stdout=subprocess.DEVNULL)
    shutil.move("blockMeshDict", "system/blockMeshDict")
    subprocess.check_call("blockMesh > log.blockMesh 2>&1", shell=True)

    # --- constant/solverDict: keep the upstream header, write the body from scratch (only modelled options)
    old = open("constant/solverDict").read()
    header = old[: old.index("thermalSolver")]
    prop = lambda name, dims, v: "        %-12s %s %s  %r;\n" % (name, name, dims, v)

    def material(name, k):
        if isinstance(k, dict):
            lin = k["linear"]
            # OFFBEAT's steel1515TiTobbe model is k = par1 + par2 * T[degC]; with overridden coefficients it is any linear k(T)
            par2 = lin["b"]
            par1 = lin["a"] + 273.15 * lin["b"]
            kline = "        conductivityModel steel1515TiTobbe;\n        conductivity { par1 %r; par2 %r; }\n" % (par1, par2)
            kval = ""
        else:
            kline = ""
            kval = "        k           k     [1 1 -3 -1 0]  %r;\n" % k
        return (
            "    %s\n    {\n        material constant;\n" % name
            + "        rho         rho   [1 -3 0 0 0]   %r;\n" % 10000.0
            + "        Cp          Cp    [0 2 -2 -1 0]  %r;\n" % 300.0
            + kval + kline
            + "        emissivity  emissivity [0 0 0 0 0] 0.8;\n"
            + "        E           E     [1 -1 -2 0 0]  2e11;\n"
            + "        nu          nu    [0 0 0 0 0]    0.3;\n"
            + "        G           G     [1 -1 -2 0 0]  7.69e10;\n"
            + "        alpha       alpha [0 0 0 0 0]    1e-5;\n"
            + "        Tref        Tref  [0 0 0 1 0]    300;\n"
            + "        rheologyModel elasticity;\n    }\n"
        )

    body = f"""thermalSolver           solidConduction;
mechanicsSolver         fromLatestTime;
neutronicsSolver        none;
elementTransport        none;

materialProperties      byZone;
rheology                byMaterial;

heatSource              constantLhgr;
burnup                  none;
fastFlux                none;
corrosion               fromLatestTime;
gapGas                  none;
fgr                     none;
sliceMapper             autoAxialSlices;

globalOptions
{{
    pinDirection            (0 0 1);
    reactorType             "LWR";
}}

thermalSolverOptions
{{
    heatFluxSummary     on;
}}

heatSourceOptions
{{
    lhgr        {p["qPrime"]!r};
    axialProfile {{ type flat; }}
    radialProfile {{ type flat; }}
    materials ( fuel );
}}

materials
{{
{material("fuel", p["fuelK"])}
{material("cladding", p["claddingK"])}}}

// ************************************************************************* //
"""
    open("constant/solverDict", "w").write(header + body)
    for f in ("constant/axialProfile", "constant/systemPressure"):
        pass  # left in place; unused by this configuration

    # --- 0/T: coupled gap with constant conductance, outer boundary, wedge
    T0 = p.get("initialTemperature", 900.0)
    b = p["boundary"]
    if b["kind"] == "convective":
        outer = "type convectiveHTC;\n        T0 uniform %r;\n        h uniform %r;\n        value uniform %r;" % (b["bulkTemperature"], b["h"], T0)
    else:
        outer = "type fixedValue;\n        value uniform %r;" % b["temperature"]
    tfile = open("0/T").read()
    head = tfile[: tfile.index("dimensions")]
    gap = lambda n: """    %s
    {
        type            resistiveGap;
        patchType       regionCoupledOFFBEAT;
        coupled         true;
        kappa           k;
        alpha           uniform %r;
        value           $internalField;
    }
""" % (n, p["gapConductance"])
    t = head + f"""dimensions      [0 0 0 1 0 0 0];

internalField   uniform {T0!r};

boundaryField
{{
    ".*Front|.*Back"
    {{
        type            wedge;
        value           $internalField;
    }}
{gap("fuelOuter")}{gap("cladInner")}    cladOuter
    {{
        {outer}
    }}
}}

// ************************************************************************* //
"""
    open("0/T", "w").write(t)
    for f in ("0/gapGas", "0/neutronFlux0"):
        if os.path.exists(f):
            os.remove(f)

    # --- system/controlDict: fixed end time, no burnup/creep/fgr limits, probes at the axis and outer fuel/clad faces
    c = open("system/controlDict").read()
    c = re.sub(r"^endTime\s+.*$", "endTime         %r;" % p.get("endTime", 2000.0), c, flags=re.M)
    c = re.sub(r"^writeInterval\s+.*$", "writeInterval   1000;", c, flags=re.M)
    c = re.sub(r"^deltaT\s+.*$", "deltaT          1;", c, flags=re.M)
    open("system/controlDict", "w").write(c)
    for f in ("log.blockMesh",):
        pass


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
