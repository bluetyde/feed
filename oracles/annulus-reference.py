# Independent reference for annular fuel (insulated hole): numerical integration, not the closed form used in src/core.
import math
def simpson(f, a, b, n=20000):
    h = (b - a) / n
    s = f(a) + f(b)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * f(a + i * h)
    return s * h / 3
def annulus_rise(q, k, R, ri):
    # k dT/dr = -q (r^2 - ri^2) / (2 pi r (R^2 - ri^2)) ; rise = T(ri) - T(R) = integral from ri to R of q (r^2-ri^2)/(2 pi k r (R^2-ri^2)) dr
    return simpson(lambda r: q * (r * r - ri * ri) / (2 * math.pi * k * r * (R * R - ri * ri)), ri, R)
def pin_centre(q, kf, R, ri, hgap, rci, rco, kc, hfilm, tb):
    film = q / (2 * math.pi * rco * hfilm)
    clad = q * math.log(rco / rci) / (2 * math.pi * kc)
    gap = q / (2 * math.pi * R * hgap)
    return tb + film + clad + gap + annulus_rise(q, kf, R, ri)
print("annulus synthetic deltaT", round(annulus_rise(20000, 3, 0.0041, 0.001), 4))
print("annulus solid-limit deltaT (ri=1e-9)", round(annulus_rise(20000, 3, 0.0041, 1e-9), 4), "vs", round(20000/(4*math.pi*3), 4))
print("annulus UT-like deltaT", round(annulus_rise(64970.5512, 18, 0.018161, 0.003175), 4))
print("pin centre annular synthetic", round(pin_centre(20000, 3, 0.0041, 0.001, 5000, 0.00418, 0.00475, 15, 30000, 573), 4))
