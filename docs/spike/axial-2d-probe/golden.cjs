"use strict";
// Plan 15, B0 probe: read the saved real OFFBEAT runs of tests/golden (steady: T and C at the end, transient: times/<t>/T) layer by layer.
const fs = require("fs");
const path = require("path");
const D = path.join(__dirname, "..", "..", "..", "dist", "core");
const RP = require(D + "/resultsParser");
const root = path.join(__dirname, "..", "..", "..", "tests", "golden");

const STEADY = [
  ...["cosine", "rise", "short"].map((n) => ["pin steady " + n, "offbeat-stack/" + n]),
  ...["cosine", "len0.19", "len0.381", "len0.762", "negative", "ramp", "rise", "short", "steep"].map((n) => ["plate steady " + n, "offbeat-plate-stack/" + n]),
];
const TRANSIENT = [
  ...["asym", "coastdown", "pulse", "short", "shortcool"].map((n) => ["pin transient " + n, "offbeat-stack-transient/" + n]),
  ...["transient-asym", "transient-lossofcooling", "transient-lossofcooling-limit", "transient-lossofcooling-long", "transient-lossofcooling-short", "transient-pulse", "transient-short"].map((n) => ["plate " + n, "offbeat-plate-stack/" + n]),
];

const readCase = (dir) => JSON.parse(fs.readFileSync(path.join(root, dir, "normalized.json"), "utf8"));

/** The cells of a stack field by layer: [layer][i], fuel inner to outer then cladding inner to outer; walls per layer. */
function byLayer(c, Ttext) {
  const N = c.axial.slices, nf = c.mesh.fuelCells, nc = c.mesh.claddingCells;
  const T = RP.parseScalarField(Ttext, "T");
  if (T.length !== N * (nf + nc)) throw new Error("cell count " + T.length);
  const faces = RP.parsePatchValues(Ttext, "cladOuter");
  const walls = faces.length === N ? faces : new Array(N).fill(faces[0]);
  const L = [];
  for (let k = 0; k < N; k++) {
    const row = [];
    for (let i = 0; i < nf; i++) row.push(T[k * nf + i]);
    for (let i = 0; i < nc; i++) row.push(T[N * nf + k * nc + i]);
    L.push(row);
  }
  return { T: L, walls };
}

function readSteady(dir) {
  const c = readCase(dir);
  const f = fs.readFileSync(path.join(root, dir, "T"), "utf8");
  return { c, ...byLayer(c, f) };
}

function readTransient(dir) {
  const c = readCase(dir);
  const base = path.join(root, dir, "times");
  const times = fs.readdirSync(base).map((s) => ({ s, t: parseFloat(s) })).sort((a, b) => a.t - b.t);
  const fields = times.map((x) => ({ time: x.t, text: fs.readFileSync(path.join(base, x.s, "T"), "utf8") }));
  const C = fs.readFileSync(path.join(root, dir, "C"), "utf8");
  return { c, C, fields, layers: fields.map((f) => ({ time: f.time, ...byLayer(c, f.text) })) };
}

module.exports = { STEADY, TRANSIENT, readCase, readSteady, readTransient, byLayer, RP };
