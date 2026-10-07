# Independent reference for the adiabatic peak of a FEED transient case file: reads the case, integrates the power history
# (trapezoid on the tabulated points, exactly as the solver's linear interpolation does), divides by the annular fuel area and
# solves the integral of c dT = E''' for the fuel temperature, in 60-digit decimal arithmetic. No code shared with src/core.
# Usage: python oracles/transient-case-reference.py <case.json> [timeStep_ms outputs]
import json
import sys
from decimal import Decimal as D, getcontext

getcontext().prec = 60
PI = D("3.14159265358979323846264338327950288419716939937510582097494459")
TIME = {"s": D(1), "ms": D("0.001"), "us": D("0.000001")}
POWER = {"W/m": D(1), "kW/m": D(1000), "MW/m": D(1000000)}
LEN = {"m": D(1), "cm": D("0.01"), "mm": D("0.001")}
CV = {"J/m3/K": D(1), "J/cm3/K": D(1000000), "MJ/m3/K": D(1000000)}
CVB = {"J/m3/K2": D(1), "J/cm3/K2": D(1000000), "MJ/m3/K2": D(1000000)}
CVC = {"J/m3/K3": D(1), "J/cm3/K3": D(1000000), "MJ/m3/K3": D(1000000)}


def temp_k(q):
    return D(str(q["value"])) + (D("273.15") if q["unit"] == "degC" else D(0))


def adiabatic_peak(case):
    t = case["transient"]
    end = D(str(t["endTime"]["value"])) * TIME[t["endTime"]["unit"]]
    pts = [(D(str(p["time"]["value"])) * TIME[p["time"]["unit"]], D(str(p["linearHeatRate"]["value"])) * POWER[p["linearHeatRate"]["unit"]]) for p in t["powerHistory"]]
    e = D(0)
    for (t0, q0), (t1, q1) in zip(pts, pts[1:]):
        if t0 >= end:
            break
        if t1 > end:
            q1 = q0 + (q1 - q0) * (end - t0) / (t1 - t0)
            t1 = end
        e += (q0 + q1) / 2 * (t1 - t0)
    g = case["geometry"]
    r = D(str(g["fuelRadius"]["value"])) * LEN[g["fuelRadius"]["unit"]]
    ri = D(0)
    if "fuelInnerRadius" in g:
        ri = D(str(g["fuelInnerRadius"]["value"])) * LEN[g["fuelInnerRadius"]["unit"]]
    area = PI * (r * r - ri * ri)
    e3 = e / area
    t0k = temp_k(t["initialTemperature"])
    s = case["materials"]["fuel"]["sets"]["thermal.volumetricHeatCapacity"]
    if s["model"] == "constant":
        peak = t0k + e3 / (D(str(s["value"]["value"])) * CV[s["value"]["unit"]])
    elif s["model"] == "polynomial":
        # c = a + b T + c2 T^2: bisection on the integral from t0k, 200 halvings in 60-digit arithmetic
        a = D(str(s["a"]["value"])) * CV[s["a"]["unit"]]
        b = D(str(s["b"]["value"])) * CVB[s["b"]["unit"]]
        c2 = D(str(s["c"]["value"])) * CVC[s["c"]["unit"]]

        def prim(T):
            return a * T + b * T * T / 2 + c2 * T * T * T / 3

        lo, hi = t0k, t0k + D(5000)
        for _ in range(200):
            mid = (lo + hi) / 2
            if prim(mid) - prim(t0k) < e3:
                lo = mid
            else:
                hi = mid
        peak = (lo + hi) / 2
    else:
        a = D(str(s["a"]["value"])) * CV[s["a"]["unit"]]
        b = D(str(s["b"]["value"])) * CVB[s["b"]["unit"]]
        kc = a + b * t0k
        peak = t0k + 2 * e3 / (kc + (kc * kc + 2 * b * e3).sqrt())
    return e, e3, peak


if __name__ == "__main__":
    case = json.load(open(sys.argv[1]))
    e, e3, peak = adiabatic_peak(case)
    print("energy per length (J/m):", round(float(e), 6))
    print("energy per fuel volume (J/m3):", round(float(e3), 3))
    print("adiabatic peak (K):", round(float(peak), 6))
