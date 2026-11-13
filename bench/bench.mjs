// bench/bench.mjs — timing harness: 1 warmup + N>=5 timed repetitions, cold start recorded separately.
import { readFileSync, writeFileSync } from 'node:fs';
import { auditRelative, bboxDiagonal, repairConvexity } from '../src/core.mjs';
import { repairNaive } from '../baseline/naive.mjs';

const root = new URL('../', import.meta.url);
const index = JSON.parse(readFileSync(new URL('data/index.json', root), 'utf8'));
const meshes = index.meshes.map((m) => {
  const rec = JSON.parse(readFileSync(new URL(`data/${m.name}.json`, root), 'utf8'));
  return { name: m.name, mode: m.mode, mesh: { vertices: rec.punctured.vertices, faces: rec.punctured.faces } };
});

const REPS = Number(process.env.REPS || 7);
const diagOf = (mesh) => bboxDiagonal(mesh);

function onePass() {
  const out = [];
  for (const { name, mesh } of meshes) {
    const t0 = process.hrtime.bigint();
    const r = repairConvexity(mesh, { epsRel: 1e-9 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const post = auditRelative({ vertices: r.vertices, faces: mesh.faces }, 1e-9);
    out.push({ name, ms, status: r.status, iterations: r.iterations, residual: post.violationCount, maxShift: r.maxIterShift });
  }
  return out;
}

function stats(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { min: s[0], median, p95: s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)], max: s[n - 1], mean, stddev: Math.sqrt(variance), rsd: mean > 0 ? Math.sqrt(variance) / mean : 0, n };
}

// cold start: very first call in this process
const coldStartMs = (() => {
  const t0 = process.hrtime.bigint();
  onePass();
  return Number(process.hrtime.bigint() - t0) / 1e6;
})();

// warmup
onePass();
const runs = [];
for (let i = 0; i < REPS; i++) runs.push(onePass());

const totals = runs.map((r) => r.reduce((a, b) => a + b.ms, 0));
const perMesh = {};
for (const { name } of meshes) {
  perMesh[name] = stats(runs.map((r) => r.find((x) => x.name === name).ms));
}
const byName = meshes.map((m) => m.name);
const statusByName = {};
for (const n of byName) {
  const rec = runs[0].find((x) => x.name === n);
  statusByName[n] = { status: rec.status, iterations: rec.iterations, postViolations: rec.residual, maxShift: rec.maxShift };
}

// naive baseline, same harness
const naiveRuns = [];
for (let i = 0; i < REPS; i++) {
  let ms = 0;
  let violations = 0;
  let shift = 0;
  for (const { mesh } of meshes) {
    const t0 = process.hrtime.bigint();
    const r = repairNaive(mesh, { epsRel: 1e-9 });
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const a = auditRelative({ vertices: r.vertices, faces: mesh.faces }, 1e-9);
    violations += a.violationCount;
    shift += r.maxShift;
  }
  naiveRuns.push({ ms, violations, shift });
}

const result = {
  generatedBy: 'bench/bench.mjs',
  reps: REPS,
  coldStartMs,
  totalMs: stats(totals),
  naiveBaselineMs: stats(naiveRuns.map((r) => r.ms)),
  linfShiftTotalExact: runs[0].reduce((a, b) => a + b.maxShift, 0),
  linfShiftTotalNaive: naiveRuns[0].shift,
  residualViolationsExact: runs[0].reduce((a, b) => a + b.residual, 0),
  residualViolationsNaive: naiveRuns[0].violations,
  perMesh,
  verdicts: statusByName,
};
writeFileSync(new URL('bench/result.json', root), JSON.stringify(result, null, 2) + '\n');
console.log(`cold start (all 8 meshes) : ${coldStartMs.toFixed(2)} ms`);
console.log(`warm total  median ${result.totalMs.median.toFixed(2)} ms | min ${result.totalMs.min.toFixed(2)} | p95 ${result.totalMs.p95.toFixed(2)} | stddev ${result.totalMs.stddev.toFixed(2)} | rsd ${(result.totalMs.rsd * 100).toFixed(1)}%  (n=${result.totalMs.n})`);
console.log(`naive total median ${result.naiveBaselineMs.median.toFixed(2)} ms | residual violations exact ${result.residualViolationsExact} vs naive ${result.residualViolationsNaive}`);
for (const n of byName) console.log(`  ${n.padEnd(18)} median ${perMesh[n].median.toFixed(2)} ms  ${statusByName[n].status} iters=${statusByName[n].iterations} postViol=${statusByName[n].postViolations}`);
