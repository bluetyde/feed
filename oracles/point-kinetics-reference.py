"""An independent reference for the point-kinetics pulse generator (src/core/pointKinetics.ts).

Written without reference to the TypeScript: fixed-step classical RK4 (the TypeScript is adaptive Dormand-Prince), a bisection on the
temperature for the enthalpy (the TypeScript solves the quadratic in closed form), and the feedback reactivity by numerical quadrature of
the coefficient (the TypeScript integrates it analytically). Pure Python, standard library only.

Usage: python3 point-kinetics-reference.py <cases.json> > results.json
Each case: {name, spec, ctx} in SI (the shapes of KineticsSpec and KineticsContext). Output per case: peak power, time of peak, total energy,
full width at half maximum, the fuel's final average temperature and its peak rise.
"""
import json
import math
import sys


def solve(spec, ctx):
    groups = spec["groups"]
    m = len(groups)
    beta_i = [g["beta"] for g in groups]
    lam_i = [g["lambda"] for g in groups]
    beta = sum(beta_i)
    L = spec["generationTime"]
    share = spec["peakingFactor"] / (spec["pins"] * spec["activeLength"])
    area = ctx["fuelArea"]
    ca, cb = ctx["fuelC"]["a"], ctx["fuelC"]["b"]
    T0 = ctx["startTemperature"]
    fb = spec["feedback"]

    def enthalpy(T):  # J/m3 above 0 K
        return ca * T + 0.5 * cb * T * T

    def temperature_for(e):  # bisection: enthalpy(T) - enthalpy(T0) = e
        lo, hi = T0, T0 + 1.0
        while enthalpy(hi) - enthalpy(T0) < e:
            hi = T0 + 2.0 * (hi - T0)
            if hi > 1e7:
                raise RuntimeError("no temperature")
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            if enthalpy(mid) - enthalpy(T0) < e:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    def alpha(T):
        return fb["alpha"] if fb["kind"] == "constant" else fb["a"] + fb["b"] * T

    def feedback_rho(T):  # Simpson quadrature of alpha from T0 to T
        n = 200
        h = (T - T0) / n
        if h == 0:
            return 0.0
        s = alpha(T0) + alpha(T)
        for i in range(1, n):
            s += (4 if i % 2 else 2) * alpha(T0 + i * h)
        return s * h / 3.0

    def inserted(t):
        it = spec["insertionTime"]
        return spec["reactivity"] * (min(1.0, t / it) if it > 0 else 1.0)

    def f(t, y):
        P = y[0]
        E = y[m + 1]
        T = T0 + 0.0 if E <= 0 else temperature_for(E * share / area)
        rho = inserted(t) + feedback_rho(T)
        d = [0.0] * (m + 2)
        d[0] = (rho - beta) / L * P + sum(lam_i[i] * y[1 + i] for i in range(m))
        for i in range(m):
            d[1 + i] = beta_i[i] / L * P - lam_i[i] * y[1 + i]
        d[m + 1] = P
        return d

    y = [spec["initialPower"]] + [beta_i[i] * spec["initialPower"] / (lam_i[i] * L) for i in range(m)] + [0.0]
    dt = spec.get("referenceStep", 2e-6)
    n = int(round(spec["endTime"] / dt))
    ts, ps, es = [0.0], [y[0]], [0.0]
    t = 0.0
    for _ in range(n):
        k1 = f(t, y)
        k2 = f(t + dt / 2, [y[i] + dt / 2 * k1[i] for i in range(len(y))])
        k3 = f(t + dt / 2, [y[i] + dt / 2 * k2[i] for i in range(len(y))])
        k4 = f(t + dt, [y[i] + dt * k3[i] for i in range(len(y))])
        y = [y[i] + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) for i in range(len(y))]
        t += dt
        ts.append(t)
        ps.append(y[0])
        es.append(y[m + 1])
    ip = max(range(len(ps)), key=lambda i: ps[i])
    # parabola through the three points around the maximum for the peak value and time
    if 0 < ip < len(ps) - 1:
        a, b, c = ps[ip - 1], ps[ip], ps[ip + 1]
        den = a - 2 * b + c
        shift = 0.5 * (a - c) / den if den != 0 else 0.0
        peak = b - 0.25 * (a - c) * shift
        tpeak = ts[ip] + shift * dt
    else:
        peak, tpeak = ps[ip], ts[ip]
    half = peak / 2
    up = down = None
    for i in range(ip, 0, -1):
        if ps[i - 1] <= half:
            up = ts[i - 1] + (half - ps[i - 1]) / (ps[i] - ps[i - 1]) * dt
            break
    for i in range(ip, len(ps) - 1):
        if ps[i + 1] <= half:
            down = ts[i] + (ps[i] - half) / (ps[i] - ps[i + 1]) * dt
            break
    total = es[-1]
    Tfinal = T0 if total <= 0 else temperature_for(total * share / area)
    return {
        "peakPower": peak,
        "timeOfPeak": tpeak,
        "totalEnergy": total,
        "fwhm": (down - up) if up is not None and down is not None else None,
        "finalFuelTemperature": Tfinal,
        "peakFuelRise": Tfinal - T0 if ps[-1] < peak else None,
        "finalPower": ps[-1],
    }


def main():
    cases = json.load(open(sys.argv[1]))
    out = []
    for c in cases:
        out.append({"name": c["name"], "spec": c["spec"], "ctx": c["ctx"], "reference": solve(c["spec"], c["ctx"])})
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
