// src/core.mjs — convexity repair core. Pure ES module.
// No `three`, no window/document/navigator, no I/O, no env vars, module top level has no side effects.
// A closed mesh is convex iff every face plane is a supporting plane: for every face plane
// (n, d) with outward unit normal n and offset d, every vertex v satisfies n.v <= d.
// Repair = move violating vertices so that no vertex is outside any face half-space, minimising
// the per-vertex L-infinity displacement, and iterate the (planes -> shift -> new planes)
// fixed point. The exact per-vertex L-infinity minimiser is computed by enumerating active
// constraint subsets of size <= 3; there is no LP solver and no heuristic direction.

/** Axis-aligned bounding-box diagonal of a mesh (also the natural length scale). */
export function bboxDiagonal(mesh) {
  const V = mesh.vertices;
  if (!V.length) return 0;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const v of V) {
    for (let k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k];
      if (v[k] > hi[k]) hi[k] = v[k];
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/** Signed volume via the divergence theorem (positive for outward-consistent winding). */
export function meshVolume(mesh) {
  const { vertices: V, faces: F } = mesh;
  let s = 0;
  for (const f of F) {
    const a = V[f[0]];
    const b = V[f[1]];
    const c = V[f[2]];
    s +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return s / 6;
}

/**
 * Half-space audit of every undirected edge, used only to refuse malformed input.
 * Returns { watertight, nonManifoldEdges, inconsistentEdges }.
 */
export function edgeAudit(mesh) {
  const dir = new Map();
  const und = new Map();
  for (const f of mesh.faces) {
    for (let i = 0; i < 3; i++) {
      const a = f[i];
      const b = f[(i + 1) % 3];
      dir.set(a + '>' + b, (dir.get(a + '>' + b) || 0) + 1);
      const k = a < b ? a + '-' + b : b + '-' + a;
      und.set(k, (und.get(k) || 0) + 1);
    }
  }
  let nonManifold = 0;
  for (const [, n] of und) if (n !== 2) nonManifold++;
  // An edge is consistently wound iff its two directed appearances are opposite.
  let inconsistent = 0;
  for (const [k, n] of dir) {
    const [a, b] = k.split('>');
    const opp = dir.get(b + '>' + a) || 0;
    if (opp !== n) inconsistent++;
  }
  return { watertight: nonManifold === 0 && inconsistent === 0, nonManifoldEdges: nonManifold, inconsistentEdges: inconsistent };
}

/** Outward face planes. Degenerate faces yield null and are reported, never silently dropped. */
export function facePlanes(mesh, eps) {
  const { vertices: V, faces: F } = mesh;
  const out = [];
  let degenerate = 0;
  for (const f of F) {
    const p = V[f[0]];
    const q = V[f[1]];
    const r = V[f[2]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const L = Math.hypot(n[0], n[1], n[2]);
    if (!(L > eps)) {
      out.push(null);
      degenerate++;
      continue;
    }
    n = [n[0] / L, n[1] / L, n[2] / L];
    out.push({ normal: n, offset: n[0] * p[0] + n[1] * p[1] + n[2] * p[2], face: f });
  }
  return { planes: out, degenerate };
}

/**
 * Supporting-plane audit. `eps` is an absolute tolerance supplied by the caller;
 * `auditRelative` derives it as epsRel * bboxDiagonal so the verdict is scale invariant.
 */
export function auditSupportingPlanes(mesh, eps) {
  const { planes, degenerate } = facePlanes(mesh, eps);
  const violations = [];
  let maxExcess = 0;
  const V = mesh.vertices;
  for (let vi = 0; vi < V.length; vi++) {
    const v = V[vi];
    for (let fi = 0; fi < planes.length; fi++) {
      const pl = planes[fi];
      if (!pl) continue;
      const e = pl.normal[0] * v[0] + pl.normal[1] * v[1] + pl.normal[2] * v[2] - pl.offset;
      if (e > eps) {
        violations.push({ vertex: vi, face: fi, excess: e });
        if (e > maxExcess) maxExcess = e;
      }
    }
  }
  return {
    violations,
    violationCount: violations.length,
    violatingVertices: new Set(violations.map((x) => x.vertex)).size,
    maxExcess,
    planeCount: planes.filter(Boolean).length,
    planeNormals: planes.map((p) => (p ? p.normal : null)),
    degenerateFaces: degenerate,
    isConvex: violations.length === 0,
  };
}

/** Convenience wrapper: audit with a scale-relative tolerance. */
export function auditRelative(mesh, epsRel = 1e-9) {
  const diag = bboxDiagonal(mesh);
  return auditSupportingPlanes(mesh, epsRel * diag);
}

const linf = (t) => Math.max(Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2]));

// Solve the 4x4 linear system M x = rhs by Gaussian elimination with partial pivoting.
function solve4(M, rhs) {
  const A = [M[0].slice().concat(rhs[0]), M[1].slice().concat(rhs[1]), M[2].slice().concat(rhs[2]), M[3].slice().concat(rhs[3])];
  for (let col = 0; col < 4; col++) {
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (!(Math.abs(A[piv][col]) > 1e-12)) return null;
    if (piv !== col) {
      const t = A[piv];
      A[piv] = A[col];
      A[col] = t;
    }
    const p = A[col][col];
    for (let c = col; c < 5; c++) A[col][c] /= p;
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c < 5; c++) A[r][c] -= f * A[col][c];
    }
  }
  return [A[0][4], A[1][4], A[2][4], A[3][4]];
}

// Enumerate all index combinations of size k from n (k <= 4).
function* combos(n, k) {
  if (k > n || k <= 0) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * EXACT minimiser of ||t||_inf subject to n_i . t <= -e_i (e_i > 0 = violation).
 * Formulated as the small LP  min delta  s.t.  A x <= rhs,  x = (t0,t1,t2,delta),
 * whose constraint rows are the violated planes plus the six box faces t_k <= delta and
 * -t_k <= delta. The optimum of an LP is attained at a vertex, i.e. at the intersection of
 * 4 independent active constraints, so every 4-subset of the rows is solved and checked for
 * feasibility. This is why both plane-active AND box-active optima are found; enumerating only
 * plane subsets (an earlier version) silently missed optima such as the bipyramid case where
 * only one plane plus one box face is active.
 * Scale-relative tolerances; returns { t, linf } or null when the LP is infeasible.
 */
export function minLinfShift(normals, excesses, scale, tol) {
  const m = normals.length;
  if (m === 0) return { t: [0, 0, 0], linf: 0 };
  const S = Math.max(tol > 0 ? tol : 0, 1e-12 * scale);
  const rows = [];
  for (let i = 0; i < m; i++) {
    rows.push({ a: [normals[i][0], normals[i][1], normals[i][2], 0], rhs: -excesses[i] });
  }
  for (let k = 0; k < 3; k++) {
    const p = [0, 0, 0, -1];
    p[k] = 1;
    rows.push({ a: p.slice(), rhs: 0 });
    const q = [0, 0, 0, -1];
    q[k] = -1;
    rows.push({ a: q.slice(), rhs: 0 });
  }
  const planeRows = [];
  const boxRows = [];
  for (let i = 0; i < m; i++) planeRows.push(rows[i]);
  for (let i = m; i < rows.length; i++) boxRows.push(rows[i]);
  let best = null;
  const trySet = (set) => {
    const M = [set[0].a, set[1].a, set[2].a, set[3].a];
    const rhs = [set[0].rhs, set[1].rhs, set[2].rhs, set[3].rhs];
    const x = solve4(M, rhs);
    if (!x) return;
    if (!(x[3] >= -S)) return;
    for (let r = 0; r < rows.length; r++) {
      const v = rows[r].a[0] * x[0] + rows[r].a[1] * x[1] + rows[r].a[2] * x[2] + rows[r].a[3] * x[3];
      if (v > rows[r].rhs + S) return;
    }
    if (linf([x[0], x[1], x[2]]) > x[3] + S) return;
    if (!best || x[3] < best.linf - S) best = { t: [x[0], x[1], x[2]], linf: x[3] };
  };
  // An LP vertex needs 4 independent active rows. Rows from the plane family have a zero last
  // coordinate, so 4 of them are always dependent: at most 3 planes can be active at a vertex.
  const pick = (arr, k) => {
    const out = [];
    for (const c of combos(arr.length, k)) out.push(c.map((i) => arr[i]));
    return out;
  };
  for (const pb of combos(boxRows.length, 4)) trySet(pb.map((i) => boxRows[i]));
  for (let np = 1; np <= 3; np++) {
    for (const ps of combos(planeRows.length, np)) {
      for (const bs of combos(boxRows.length, 4 - np)) {
        trySet([...ps.map((i) => planeRows[i]), ...bs.map((i) => boxRows[i])]);
      }
    }
  }
  return best;
}

/**
 * Fixed-point convexity repair.
 * The fixed point is iterated in NORMALISED space (bbox diagonal = 1) and the result is mapped
 * back by the diagonal. That makes the verdict, the iteration count and the relative shift
 * scale-equivariant by construction (see README "scale invariance"), instead of relying on
 * absolute thresholds happening to survive six orders of magnitude.
 * status: "converged" (0 violations) | "refused" (with a machine-readable reason).
 * A refusal never claims success: `residual` is the measured violation count of the mesh at the
 * point of refusal, and it is left untouched.
 */
export function repairConvexity(mesh, options = {}) {
  const diag = bboxDiagonal(mesh);
  if (!(diag > 0)) {
    return { status: 'refused', reason: 'degenerate-bbox', vertices: mesh.vertices.map((v) => v.slice()), iterations: 0, history: [], residual: null, maxExcess: null, maxIterShift: 0, totalShift: 0, eps: 0, diag: 0 };
  }
  const unitMesh = { vertices: mesh.vertices.map((v) => [v[0] / diag, v[1] / diag, v[2] / diag]), faces: mesh.faces };
  const r = repairUnit(unitMesh, options);
  const scaled = { ...r, diag, vertices: r.vertices.map((v) => [v[0] * diag, v[1] * diag, v[2] * diag]) };
  for (const k of ['maxIterShift', 'totalShift', 'maxExcess', 'eps']) {
    if (typeof scaled[k] === 'number') scaled[k] *= diag;
  }
  return scaled;
}

function repairUnit(mesh, options = {}) {
  const diag = 1; // normalised space: bboxDiagonal(mesh) == 1
  const epsRel = options.epsRel ?? 1e-9;
  const eps = options.eps ?? epsRel * diag; // reporting tolerance
  // The fixed point is iterated at a tighter tolerance so that the reported "0 violations at eps"
  // survives an independent re-audit: a state with no violation above workEps cannot flip when
  // re-audited at the 1000x looser eps.
  const workEps = options.workEps ?? eps * (options.workEpsFactor ?? 1e-3);
  const tol = options.tol ?? 1e-10 * diag;
  const maxIterations = options.maxIterations ?? 60;
  const shiftBudget = (options.shiftBudgetRatio ?? 0.5) * diag;

  let vertices = mesh.vertices.map((v) => [v[0], v[1], v[2]]);
  const history = [];
  let totalShift = 0;
  let maxIterShift = 0;
  const base = { vertices: [], faces: mesh.faces };

  for (let it = 0; it < maxIterations; it++) {
    base.vertices = vertices;
    const audit = auditSupportingPlanes(base, workEps);
    history.push(audit.violationCount);
    if (audit.violationCount === 0) {
      return { status: 'converged', reason: 'zero-supporting-plane-violations', vertices, iterations: it, history, residual: 0, maxExcess: 0, maxIterShift, totalShift, eps, diag };
    }
    const byVertex = new Map();
    for (const x of audit.violations) {
      let list = byVertex.get(x.vertex);
      if (!list) byVertex.set(x.vertex, (list = []));
      list.push(x);
    }
    let iterShift = 0;
    for (const [vi, list] of byVertex) {
      const ns = list.map((x) => audit.planeNormals[x.face]);
      const es = list.map((x) => x.excess);
      const sol = minLinfShift(ns, es, diag, tol);
      if (!sol) {
        return { status: 'refused', reason: 'infeasible-vertex-' + vi, vertices, iterations: it, history, residual: audit.violationCount, maxExcess: audit.maxExcess, maxIterShift, totalShift, eps, diag };
      }
      vertices[vi] = [vertices[vi][0] + sol.t[0], vertices[vi][1] + sol.t[1], vertices[vi][2] + sol.t[2]];
      iterShift = Math.max(iterShift, sol.linf);
    }
    maxIterShift = Math.max(maxIterShift, iterShift);
    totalShift += iterShift;
    if (iterShift > shiftBudget) {
      const post = auditSupportingPlanes({ vertices, faces: mesh.faces }, eps);
      return { status: 'refused', reason: 'shift-budget-exceeded', vertices, iterations: it + 1, history, residual: post.violationCount, maxExcess: post.maxExcess, maxIterShift, totalShift, eps, diag };
    }
    if (iterShift === 0) {
      return { status: 'refused', reason: 'stalled-no-progress', vertices, iterations: it + 1, history, residual: audit.violationCount, maxExcess: audit.maxExcess, maxIterShift, totalShift, eps, diag };
    }
  }
  const final = auditSupportingPlanes({ vertices, faces: mesh.faces }, workEps);
  return { status: 'refused', reason: 'max-iterations', vertices, iterations: maxIterations, history, residual: final.violationCount, maxExcess: final.maxExcess, maxIterShift, totalShift, eps, diag };
}
