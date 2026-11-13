// tools/gen-sample.mjs — deterministic sample generator.
// Builds exactly-convex analytic polyhedra, then searches (fixed seed, fixed candidate order)
// for a vertex perturbation that really breaks supporting-plane convexity, and records whether
// the repair converges or honestly refuses. Run twice -> byte-identical data/.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { auditRelative, repairConvexity, bboxDiagonal, meshVolume, edgeAudit } from '../src/core.mjs';

const SEED = 0x5eed1234;
const OUT = new URL('../data/', import.meta.url);
const factualRef = {};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function orientOutward(mesh) {
  if (meshVolume(mesh) < 0) mesh.faces = mesh.faces.map((f) => [f[0], f[2], f[1]]);
  return mesh;
}

function cube() {
  const V = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) V.push([x, y, z]);
  // index = x + 2y + 4z
  const i = (x, y, z) => (x ? 1 : 0) + (y ? 2 : 0) + (z ? 4 : 0);
  const F = [];
  const quad = (a, b, c, d) => {
    F.push([a, b, c], [a, c, d]);
  };
  quad(i(0, 0, 0), i(0, 1, 0), i(1, 1, 0), i(1, 0, 0));
  quad(i(0, 0, 1), i(1, 0, 1), i(1, 1, 1), i(0, 1, 1));
  quad(i(0, 0, 0), i(0, 0, 1), i(0, 1, 1), i(0, 1, 0));
  quad(i(1, 0, 0), i(1, 1, 0), i(1, 1, 1), i(1, 0, 1));
  quad(i(0, 0, 0), i(1, 0, 0), i(1, 0, 1), i(0, 0, 1));
  quad(i(0, 1, 0), i(0, 1, 1), i(1, 1, 1), i(1, 1, 0));
  return orientOutward({ vertices: V, faces: F });
}

function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const p = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const L = Math.hypot(1, t);
  const V = p.map((v) => [v[0] / L, v[1] / L, v[2] / L]);
  const F = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return orientOutward({ vertices: V, faces: F });
}

function octahedron() {
  const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const F = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  return orientOutward({ vertices: V, faces: F });
}

function ring(n, y, r, phase) {
  const out = [];
  for (let s = 0; s < n; s++) {
    const a = phase + (2 * Math.PI * s) / n;
    out.push([r * Math.cos(a), y, r * Math.sin(a)]);
  }
  return out;
}

function prism(n) {
  const V = [...ring(n, -1, 1, Math.PI / 2), ...ring(n, 1, 1, Math.PI / 2)];
  const F = [];
  const b = (s) => s % n;
  const t = (s) => n + (s % n);
  for (let s = 0; s < n; s++) {
    F.push([b(s), b(s + 1), t(s + 1)], [b(s), t(s + 1), t(s)]);
  }
  for (let s = 1; s < n - 1; s++) F.push([b(0), b(s + 1), b(s)]);
  for (let s = 1; s < n - 1; s++) F.push([t(0), t(s), t(s + 1)]);
  return orientOutward({ vertices: V, faces: F });
}

function cone(n) {
  const V = [...ring(n, -1, 1, Math.PI / 2), [0, 1, 0]];
  const ap = V.length - 1;
  const F = [];
  for (let s = 0; s < n; s++) F.push([s, (s + 1) % n, ap]);
  for (let s = 1; s < n - 1; s++) F.push([0, s + 1, s]);
  return orientOutward({ vertices: V, faces: F });
}

function bipyramid(n) {
  const V = [...ring(n, 0, 1, Math.PI / 2), [0, 1, 0], [0, -1, 0]];
  const up = V.length - 2;
  const dn = V.length - 1;
  const F = [];
  for (let s = 0; s < n; s++) F.push([s, (s + 1) % n, up], [(s + 1) % n, s, dn]);
  return orientOutward({ vertices: V, faces: F });
}

function antiprism(n) {
  const V = [...ring(n, -0.5, 1, 0), ...ring(n, 0.5, 1, Math.PI / n)];
  const b = (s) => s % n;
  const t = (s) => n + (s % n);
  const F = [];
  for (let s = 0; s < n; s++) {
    F.push([b(s), b(s + 1), t(s)]);
    F.push([t(s), b(s + 1), t(s + 1)]);
  }
  for (let s = 1; s < n - 1; s++) F.push([b(0), b(s), b(s + 1)]);
  for (let s = 1; s < n - 1; s++) F.push([t(0), t(s + 1), t(s)]);
  return orientOutward({ vertices: V, faces: F });
}

function centroid(V) {
  const c = [0, 0, 0];
  for (const v of V) for (let k = 0; k < 3; k++) c[k] += v[k];
  return c.map((x) => x / V.length);
}

function perturb(base, picked, factor) {
  const c = centroid(base.vertices);
  const V = base.vertices.map((v) => [v[0], v[1], v[2]]);
  for (const p of picked) {
    const v = V[p];
    V[p] = [c[0] + (v[0] - c[0]) * factor, c[1] + (v[1] - c[1]) * factor, c[2] + (v[2] - c[2]) * factor];
  }
  return { vertices: V, faces: base.faces.map((f) => f.slice()) };
}

function pickIndices(count, k, rand) {
  const idx = new Set();
  let guard = 0;
  while (idx.size < k && guard++ < 500) idx.add(Math.floor(rand() * count));
  return [...idx].sort((a, b) => a - b);
}

const FACTORS = [1.3, 1.25, 1.2, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 1.1, 1.15, 0.5, 0.45, 0.4, 0.3, 1.7, 1.8];

function search(base, mode) {
  const rand = mulberry32(SEED ^ hash(base.vertices.length * 1000 + base.faces.length));
  const n = base.vertices.length;
  const ks = [Math.max(1, Math.round(n / 5)), Math.max(1, Math.round(n / 4)), Math.max(1, Math.round(n / 3)), Math.max(2, Math.round(n / 2))];
  const candidates = [];
  for (const k of ks) {
    // evenly spread is the most robust: one dent per angular sector
    const spread = [];
    for (let i = 0; i < k; i++) spread.push(Math.floor(n * ((i + 0.5) / k)));
    candidates.push([...new Set(spread)].sort((a, b) => a - b));
    for (let draw = 0; draw < 3; draw++) candidates.push(pickIndices(n, k, rand));
  }
  let fallback = null;
  for (const picked of candidates) {
    if (!picked.length) continue;
    for (const factor of FACTORS) {
      const dem = perturb(base, picked, factor);
      const before = auditRelative(dem, 1e-9);
      if (before.violationCount === 0) continue;
      const rep = repairConvexity(dem, { epsRel: 1e-9 });
      if (mode === 'repairable') {
        if (rep.status === 'converged') return { picked, factor, dem, before, rep };
      } else if (rep.status === 'refused' && rep.residual !== null && rep.residual > 0) {
        // Prefer a refusal that made real progress before refusing (iterations > 0).
        if (rep.iterations > 0) return { picked, factor, dem, before, rep };
        if (!fallback) fallback = { picked, factor, dem, before, rep };
      }
    }
  }
  return fallback;
}

function hash(x) {
  let h = 2166136261 >>> 0;
  const s = String(x);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const SPECS = [
  { name: 'cube-bump', kind: 'cube', mode: 'repairable', body: cube },
  { name: 'icosahedron-dent', kind: 'icosahedron', mode: 'repairable', body: icosahedron },
  { name: 'prism8-bump', kind: 'prism8', mode: 'repairable', body: () => prism(8) },
  { name: 'cone24-dent', kind: 'cone24', mode: 'repairable', body: () => cone(24) },
  { name: 'cone16-dent', kind: 'cone16', mode: 'repairable', body: () => cone(16) },
  { name: 'prism16-dent', kind: 'prism16', mode: 'repairable', body: () => prism(16) },
  { name: 'bipyramid12-dent', kind: 'bipyramid12', mode: 'refusal', body: () => bipyramid(12) },
  { name: 'cone8-dent', kind: 'cone8', mode: 'refusal', body: () => cone(8) },
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const index = [];
const reference = { generatedBy: 'tools/gen-sample.mjs', epsRel: 1e-9, meshes: [] };

for (const spec of SPECS) {
  const base = spec.body();
  const baseAudit = auditRelative(base, 1e-9);
  const edge = edgeAudit(base);
  if (baseAudit.violationCount !== 0) throw new Error(`base ${spec.name} is not convex: ${baseAudit.violationCount}`);
  if (!edge.watertight) throw new Error(`base ${spec.name} is not watertight: ${JSON.stringify(edge)}`);
  const found = search(base, spec.mode);
  if (!found) throw new Error(`no ${spec.mode} perturbation found for ${spec.name}`);
  const { picked, factor, dem, before, rep } = found;
  const diag = bboxDiagonal(base);
  const record = {
    name: spec.name,
    kind: spec.kind,
    mode: spec.mode,
    base: { vertices: base.vertices, faces: base.faces },
    punctured: { vertices: dem.vertices, faces: dem.faces },
    perturbation: { pickedVertices: picked, radialFactor: factor },
  };
  writeFileSync(new URL(`${spec.name}.json`, OUT), JSON.stringify(record));
  reference.meshes.push({
    name: spec.name,
    mode: spec.mode,
    bboxDiagonal: diag,
    baseViolations: baseAudit.violationCount,
    baseMaxExcess: baseAudit.maxExcess,
    beforeViolations: before.violationCount,
    beforeViolatingVertices: before.violatingVertices,
    beforeMaxExcess: before.maxExcess,
    repairedStatus: rep.status,
    repairedReason: rep.reason,
    repairedIterations: rep.iterations,
    repairedHistory: rep.history,
    repairedResidual: rep.residual,
    repairedMaxExcess: rep.maxExcess ?? null,
    maxIterShift: rep.maxIterShift,
    totalShift: rep.totalShift,
  });
  index.push({ name: spec.name, kind: spec.kind, mode: spec.mode });
  factualRef[spec.name] = rep.status;
}

writeFileSync(new URL('index.json', OUT), JSON.stringify({ meshes: index }));
writeFileSync(new URL('reference.json', OUT), JSON.stringify(reference));
const repairable = reference.meshes.filter((m) => m.mode === 'repairable');
const refusal = reference.meshes.filter((m) => m.mode === 'refusal');
console.log(`wrote ${reference.meshes.length} meshes to data/`);
for (const m of reference.meshes) {
  console.log(
    `  ${m.name.padEnd(20)} ${m.mode.padEnd(10)} before=${String(m.beforeViolations).padStart(3)} ` +
      `status=${m.repairedStatus.padEnd(9)} iters=${String(m.repairedIterations).padStart(2)} ` +
      `residual=${m.repairedResidual} maxShift=${m.maxIterShift.toExponential(3)}`
  );
}
console.log(`repairable converged: ${repairable.filter((m) => m.repairedStatus === 'converged').length}/${repairable.length}`);
console.log(`refusal honest: ${refusal.filter((m) => m.repairedStatus === 'refused' && m.repairedResidual > 0).length}/${refusal.length}`);
