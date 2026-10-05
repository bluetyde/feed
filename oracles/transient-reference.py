# Independent reference values for the exact transient solutions in src/core/transientExact.ts (plan 08).
# A different method from the TypeScript: Bessel functions by their ascending power series in 150-digit decimal arithmetic,
# zeros of J0 by Newton's method on that series, no integral representation. Run: python oracles/transient-reference.py
from decimal import Decimal as D, getcontext
import math

getcontext().prec = 150
PI = D("3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798214808651")


def j0(x):
    x = D(x)
    q = x * x / 4
    term = D(1)
    s = D(1)
    k = 0
    while True:
        k += 1
        term = -term * q / (k * k)
        s += term
        if abs(term) < D(10) ** -110 and k > 5:
            return s


def j1(x):
    x = D(x)
    q = x * x / 4
    term = x / 2
    s = term
    k = 0
    while True:
        k += 1
        term = -term * q / (k * (k + 1))
        s += term
        if abs(term) < D(10) ** -110 and k > 5:
            return s


def zero(k):
    x = (D(k) - D("0.25")) * PI
    for _ in range(40):
        dx = j0(x) / (-j1(x))
        x -= dx
        if abs(dx) < D(10) ** -40:
            break
    return x


ZEROS = [zero(k) for k in range(1, 121)]


def cooling(r, t, R, alpha, dT0):
    s = D(0)
    for lam in ZEROS:
        s += 2 * j0(lam * D(r) / D(R)) * (-lam * lam * D(alpha) * D(t) / (D(R) * D(R))).exp() / (lam * j1(lam))
    return D(dT0) * s


def heating(r, t, R, k, alpha, q3):
    s = D(0)
    for lam in ZEROS:
        s += j0(lam * D(r) / D(R)) * (-lam * lam * D(alpha) * D(t) / (D(R) * D(R))).exp() / (lam ** 3 * j1(lam))
    R, k, q3, r = D(R), D(k), D(q3), D(r)
    return q3 * R * R / (4 * k) * (1 - r * r / (R * R)) - 2 * q3 * R * R / k * s


def adiabatic(a, b, t0, e3):
    # a (T - t0) + b/2 (T^2 - t0^2) = e3, the root above t0
    a, b, t0, e3 = D(a), D(b), D(t0), D(e3)
    kc = a + b * t0
    return t0 + 2 * e3 / (kc + (kc * kc + 2 * b * e3).sqrt())


if __name__ == "__main__":
    R, alpha = "0.004", "0.000001"
    print("cooling centre t=8 s, dT0=300:", round(float(cooling("0", "8", R, alpha, "300")), 6))
    print("cooling r=2 mm t=4 s, dT0=300:", round(float(cooling("0.002", "4", R, alpha, "300")), 6))
    print("heating centre t=8 s, q3=5e8, k=3:", round(float(heating("0", "8", R, "3", alpha, "500000000")), 6))
    print("heating r=3 mm t=2 s:", round(float(heating("0.003", "2", R, "3", alpha, "500000000")), 6))
    e3 = 0.5 * 1e7 * 0.01 / (math.pi * 0.0041 ** 2)
    print("adiabatic linear c: T =", round(float(adiabatic("900000", "4170", "300", repr(e3))), 6))
