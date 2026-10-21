// Throw-away (plan 17 M0): why the contact pressure error of the penalty contact is 1 / (1 + gain) and why only the implicit contact is stable at a large factor. Read from OFFBEAT's
// contactFvPatchVectorField (not copied): the penalty stiffness is factor x min(K A / V) of the two boundary cells, so p = k_p x overlap; the loop gain of the explicit
// Neumann-Neumann iteration is k_p x (the fuel's compliance + the cladding's compliance) (the radial displacement per unit pressure at the interface), and the overlap that remains
// is the fraction 1 / (1 + gain) of the free overlap. Fuel: Lame tube with the hole, outer pressure. Cladding: the thin shell a^2 / (E t). usage: node penalty-gain.cjs
const E = 35.59e9, nu = 0.32, b = 18.161e-3, a = 3.175e-3;
const Kf = E / (3 * (1 - 2 * nu)), hf = (b - a) / 60; // bulk modulus, thickness of the fuel's outer cell (60 cells)
const Kc = 190e9 / (3 * (1 - 2 * 0.3)), hc = 0.508e-3 / 8; // the cladding's (8 cells)
const kp = Math.min(Kf / hf, Kc / hc);
const Cf = ((b / E) * ((1 - nu) * b * b + (1 + nu) * a * a)) / (b * b - a * a);
const Cc = 0.018161 ** 2 / (190e9 * 0.508e-3);
console.log(`K/h fuel ${(Kf / hf).toExponential(3)}, cladding ${(Kc / hc).toExponential(3)} Pa/m; compliance fuel ${Cf.toExponential(2)}, cladding ${Cc.toExponential(2)} m/Pa`);
for (const f of [0.05, 0.1, 0.3, 0.5, 0.7]) {
  const g = f * kp * (Cf + Cc);
  console.log(`factor ${f}: gain ${g.toFixed(0)}, predicted pressure error ${(-100 / (1 + g)).toFixed(2)} %`);
}
