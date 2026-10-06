// The cases the independent Python reference solves (oracles/point-kinetics-reference.py). Writes the input to stdout as JSON.
// Run: node scripts/make-kinetics-reference-cases.cjs > cases.json; python3 oracles/point-kinetics-reference.py cases.json > oracles/point-kinetics-reference.json
const KEEPIN = [
  [0.000215, 0.0124],
  [0.001424, 0.0305],
  [0.001274, 0.111],
  [0.002568, 0.301],
  [0.000748, 1.14],
  [0.000273, 3.01],
].map(([beta, lambda]) => ({ beta, lambda }));
const BETA = KEEPIN.reduce((s, g) => s + g.beta, 0);
const cases = [
  {
    name: "synthetic-pulse-kinetics example: $3 step, constant feedback, constant heat capacity",
    spec: { reactivity: 3 * BETA, insertionTime: 0, generationTime: 4e-5, groups: KEEPIN, feedback: { kind: "constant", alpha: -1e-4 }, initialPower: 1000, pins: 100, activeLength: 0.5, peakingFactor: 1, endTime: 0.06, referenceStep: 5e-6 },
    ctx: { fuelArea: Math.PI * 0.0041 ** 2, fuelC: { a: 3e6, b: 0 }, startTemperature: 300 },
  },
  {
    name: "ramped $2.5, linear feedback, linear heat capacity, peaking 1.3 on 4 pins of 0.5 m, warm start",
    spec: { reactivity: 2.5 * BETA, insertionTime: 0.005, generationTime: 6e-5, groups: KEEPIN, feedback: { kind: "linear", a: -9e-5, b: -2e-8, range: [250, 2000] }, initialPower: 200, pins: 4, activeLength: 0.5, peakingFactor: 1.3, endTime: 0.08, referenceStep: 5e-6 },
    ctx: { fuelArea: 5e-5, fuelC: { a: 2e6, b: 3000 }, startTemperature: 350 },
  },
  {
    name: "prompt only (no delayed groups), constant feedback: the Nordheim-Fuchs case",
    spec: { reactivity: 0.01, insertionTime: 0, generationTime: 1e-4, groups: [], feedback: { kind: "constant", alpha: -1e-4 }, initialPower: 1, pins: 1, activeLength: 1, peakingFactor: 1, endTime: 0.3, referenceStep: 1e-5 },
    ctx: { fuelArea: 1e-4, fuelC: { a: 3e6, b: 0 }, startTemperature: 300 },
  },
];
process.stdout.write(JSON.stringify(cases, null, 1) + "\n");
