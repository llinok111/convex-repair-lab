// bench/verify.mjs — behavioural assertions on real generated data. Exit 0 = all pass, 1 = failure.
import { readFileSync } from 'node:fs';
import {
  auditRelative,
  auditSupportingPlanes,
  bboxDiagonal,
  edgeAudit,
  meshVolume,
  minLinfShift,
  repairConvexity,
} from '../src/core.mjs';
import { oracleMinLinfShift } from './oracle.mjs';
import { repairNaive } from '../baseline/naive.mjs';

const root = new URL('../', import.meta.url);
const index = JSON.parse(readFileSync(new URL('data/index.json', root), 'utf8'));
const reference = JSON.parse(readFileSync(new URL('data/reference.json', root), 'utf8'));
const refByName = new Map(reference.meshes.map((m) => [m.name, m]));

let failures = 0;
const check = (label, cond, detail) => {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label} :: ${detail}`);
};

function load(name) {
  return JSON.parse(readFileSync(new URL(`data/${name}.json`, root), 'utf8'));
}

function groupByVertex(mesh) {
  const audit = auditRelative(mesh, 1e-9);
  const byVertex = new Map();
  for (const x of audit.violations) {
    let l = byVertex.get(x.vertex);
    if (!l) byVertex.set(x.vertex, (l = []));
    l.push(x);
  }
  const planes = audit.planeNormals;
  return { audit, byVertex, planes };
}

console.log('=== A1/A2 base meshes are exactly convex, watertight, outward ===');
let baseConvex = 0;
let watertight = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const base = { vertices: rec.base.vertices, faces: rec.base.faces };
  const a = auditRelative(base, 1e-9);
  const e = edgeAudit(base);
  const v = meshVolume(base);
  baseConvex += a.violationCount === 0 ? 1 : 0;
  watertight += e.watertight && v > 0 ? 1 : 0;
}
check('base convex', baseConvex === index.meshes.length, `${baseConvex}/${index.meshes.length} bases have 0 supporting-plane violations`);
check('base watertight+outward', watertight === index.meshes.length, `${watertight}/${index.meshes.length} bases watertight and volume>0`);

console.log('=== A3 punctured meshes reproduce the recorded violation counts ===');
let beforeMatch = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const dem = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const a = auditRelative(dem, 1e-9);
  const want = refByName.get(m.name).beforeViolations;
  if (a.violationCount === want && want > 0) beforeMatch++;
}
check('before counts', beforeMatch === index.meshes.length, `${beforeMatch}/${index.meshes.length} punctured meshes reproduce recorded before= counts`);

console.log('=== A4/A5/A6 repair verdicts, no false success ===');
let convOk = 0;
let repairableN = 0;
let refusalOk = 0;
let refusalN = 0;
let falseSuccess = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const dem = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const r = repairConvexity(dem, { epsRel: 1e-9 });
  const ref = refByName.get(m.name);
  const post = auditSupportingPlanes({ vertices: r.vertices, faces: dem.faces }, r.eps);
  if (m.mode === 'repairable') {
    repairableN++;
    const ok = r.status === 'converged' && post.violationCount === 0 && r.iterations === ref.repairedIterations;
    convOk += ok ? 1 : 0;
    check(`${m.name} converged`, ok, `status=${r.status} residual=${post.violationCount} iters=${r.iterations}(ref ${ref.repairedIterations})`);
  } else {
    refusalN++;
    const ok = r.status === 'refused' && post.violationCount > 0 && r.residual > 0;
    refusalOk += ok ? 1 : 0;
    check(`${m.name} refuses honestly`, ok, `status=${r.status} reason=${r.reason} iters=${r.iterations} residual=${post.violationCount} (before ${ref.beforeViolations})`);
  }
  if (r.status === 'converged' && post.violationCount !== 0) falseSuccess++;
}
check('repairable converged', convOk === repairableN, `${convOk}/${repairableN} repairable meshes reach 0 violations`);
check('refusals honest', refusalOk === refusalN, `${refusalOk}/${refusalN} hard cases refuse with residual>0`);
check('no false success', falseSuccess === 0, `${falseSuccess} meshes claim converged while still violating a supporting plane`);

console.log('=== A7 exact solver is never beaten by the independent sampling oracle ===');
let checkedGroups = 0;
let oracleBeats = 0;
let oracleCovered = 0;
let infeasibleGroups = 0;
let worstGap = 0;
let maxActive = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const dem = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const { byVertex, planes } = groupByVertex(dem);
  for (const [, list] of byVertex) {
    const ns = list.map((x) => planes[x.face]);
    const es = list.map((x) => x.excess);
    maxActive = Math.max(maxActive, ns.length);
    const exact = minLinfShift(ns, es, bboxDiagonal(dem), 1e-12 * bboxDiagonal(dem));
    const orc = oracleMinLinfShift(ns, es, 20000, 400);
    checkedGroups++;
    if (!exact) {
      // exact claims no feasible shift exists; the oracle must not find one either
      infeasibleGroups++;
      if (orc.linf !== null) oracleBeats++;
      continue;
    }
    if (orc.linf === null) continue; // oracle cone sampling found nothing: weak, not a falsification
    oracleCovered++;
    if (orc.linf < exact.linf - 1e-9 * Math.max(1, exact.linf)) oracleBeats++;
    const gap = (orc.linf - exact.linf) / Math.max(orc.linf, 1e-300);
    worstGap = Math.max(worstGap, gap);
  }
}
check(
  'oracle never beats exact',
  oracleBeats === 0,
  `${checkedGroups} violating vertex groups (max ${maxActive} active planes): oracle produced a feasible point on ${oracleCovered} (${infeasibleGroups} groups where exact reports infeasible); ${oracleBeats} groups where the oracle beat or contradicted exact; worst oracle/exact gap = ${(worstGap * 100).toFixed(3)}%`
);

console.log('=== A8 exact solver output satisfies every violated half-space ===');
let feasible = 0;
let total = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const dem = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const { byVertex, planes } = groupByVertex(dem);
  for (const [, list] of byVertex) {
    const ns = list.map((x) => planes[x.face]);
    const es = list.map((x) => x.excess);
    const sol = minLinfShift(ns, es, bboxDiagonal(dem), 1e-12 * bboxDiagonal(dem));
    total++;
    if (!sol) continue;
    let ok = true;
    for (let k = 0; k < ns.length; k++) {
      const c = ns[k][0] * sol.t[0] + ns[k][1] * sol.t[1] + ns[k][2] * sol.t[2] + es[k];
      if (c > 1e-9) ok = false;
    }
    feasible += ok ? 1 : 0;
  }
}
check('shift feasible', feasible === total, `${feasible}/${total} exact shifts satisfy all violated half-spaces`);

console.log('=== A9 scale invariance 1e-6 .. 1e6 ===');
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
let scaleOk = 0;
let scaleTotal = 0;
let worstShiftRel = 0;
const scaleFails = [];
for (const m of index.meshes) {
  const rec = load(m.name);
  const base = recordMesh(rec.punctured);
  const ref = reference.meshes.find((x) => x.name === m.name);
  const r1 = repairConvexity(base, { epsRel: 1e-9 });
  for (const s of scales) {
    scaleTotal++;
    const scaled = { vertices: base.vertices.map((v) => v.map((c) => c * s)), faces: base.faces };
    const a = auditRelative(scaled, 1e-9);
    const r = repairConvexity(scaled, { epsRel: 1e-9 });
    const countOk = a.violationCount === ref.beforeViolations;
    const convOk = r.status === r1.status;
    const itOk = r.iterations === r1.iterations;
    let shiftOk = true;
    if (r.maxIterShift > 0 && r1.maxIterShift > 0) {
      const rel = Math.abs(r.maxIterShift / s - r1.maxIterShift) / r1.maxIterShift;
      worstShiftRel = Math.max(worstShiftRel, rel);
      shiftOk = rel <= 1e-9;
    }
    if (countOk && convOk && itOk && shiftOk) scaleOk++;
    else scaleFails.push(`${m.name}@${s} count:${a.violationCount}/${ref.beforeViolations} status:${r.status}/${r1.status} iters:${r.iterations}/${r1.iterations} shiftRel:${((r.maxIterShift / s - r1.maxIterShift) / (r1.maxIterShift || 1)).toExponential(2)}`);
  }
}
function recordMesh(m) {
  return { vertices: m.vertices, faces: m.faces };
}
check('scale invariance', scaleOk === scaleTotal, `${scaleOk}/${scaleTotal} (8 meshes x ${scales.length} scales) keep violation count, verdict and iteration count; worst relative shift drift ${worstShiftRel.toExponential(2)}`);
for (const f of scaleFails) console.log(`      scale-fail: ${f}`);

console.log('=== A10 naive one-pass baseline comparison ===');
let naiveBetter = 0;
let naiveResidualSum = 0;
let oursShiftSum = 0;
let naiveShiftSum = 0;
let oursResidual = 0;
for (const m of index.meshes) {
  const rec = load(m.name);
  const dem = { vertices: rec.punctured.vertices, faces: rec.punctured.faces };
  const exact = repairConvexity(dem, { epsRel: 1e-9 });
  const naive = repairNaive(dem, { epsRel: 1e-9 });
  const naiveAudit = auditSupportingPlanes({ vertices: naive.vertices, faces: dem.faces }, exact.eps);
  naiveResidualSum += naiveAudit.violationCount;
  oursResidual += (exact.status === 'converged' ? 0 : exact.residual ?? 0);
  oursShiftSum += exact.maxIterShift;
  naiveShiftSum += naive.maxShift;
  if (naiveAudit.violationCount > 0) naiveBetter++;
}
check('naive baseline leaves violations', naiveBetter > 0, `naive single-plane one-pass leaves ${naiveResidualSum} supporting-plane violations across ${naiveBetter}/8 meshes (ours ${oursResidual} on refusals, 0 on the 6 converged)`);
console.log(`  info: total L-inf shift ours=${oursShiftSum.toFixed(6)} vs naive=${naiveShiftSum.toFixed(6)}`);

console.log('');
console.log(failures === 0 ? `ALL ASSERTIONS PASSED (${failures} failures)` : `FAILED: ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
