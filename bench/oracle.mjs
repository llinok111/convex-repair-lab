// bench/oracle.mjs — INDEPENDENT upper-bound oracle for the per-vertex L-infinity minimal shift.
// Shares no constants and no code with src/core.mjs. Method:
//   * sample unit directions (Fibonacci sphere);
//   * keep only directions in the polar cone of the violated normals (n_i . d < 0 for every i);
//     a feasible point exists iff that cone is non-empty, so this is not a restriction on truth;
//   * along such a ray, feasibility of t = s*d requires s >= e_i / (-n_i . d) for every i,
//     therefore the first feasible point on the ray is s = max_i e_i / (-n_i . d);
//   * that point is feasible by construction and is an UPPER bound on the true minimum,
//     so it can only ever falsify the exact solver by beating it;
//   * the best sampled point is then locally refined with shrinking random perturbations.
// Feasibility tolerance is relative to the candidate itself, never copied from the exact solver.
export function oracleMinLinfShift(normals, excesses, samples = 20000, refine = 400) {
  const m = normals.length;
  if (m === 0) return { t: [0, 0, 0], linf: 0, feasibleSamples: 1, sampled: 0 };
  const linf = (t) => Math.max(Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2]));
  const rayPoint = (d) => {
    let step = 0;
    for (let k = 0; k < m; k++) {
      const nd = normals[k][0] * d[0] + normals[k][1] * d[1] + normals[k][2] * d[2];
      if (!(nd < 0)) return null; // this direction never reaches the feasible set
      const s = excesses[k] / -nd;
      if (s > step) step = s;
    }
    return [step * d[0], step * d[1], step * d[2]];
  };
  const feasible = (t) => {
    const norm = Math.max(linf(t), 1e-300);
    for (let k = 0; k < m; k++) {
      const c = normals[k][0] * t[0] + normals[k][1] * t[1] + normals[k][2] * t[2] + excesses[k];
      if (c > 1e-9 * norm + 1e-12) return false;
    }
    return true;
  };
  let best = null;
  let bestDir = null;
  let feasibleSamples = 0;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < samples; i++) {
    const y = 1 - (2 * i) / (samples - 1);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    const d = [Math.cos(th) * r, y, Math.sin(th) * r];
    const t = rayPoint(d);
    if (!t || !feasible(t)) continue;
    feasibleSamples++;
    const l = linf(t);
    if (!best || l < best.linf) {
      best = { t, linf: l };
      bestDir = d;
    }
  }
  if (best && bestDir) {
    let sigma = 0.25;
    let cur = best;
    let curDir = bestDir;
    const fract = (x) => x - Math.floor(x);
    for (let it = 0; it < refine; it++) {
      const h1 = fract(Math.sin((it + 1) * 12.9898) * 43758.5453) - 0.5;
      const h2 = fract(Math.sin((it + 1) * 78.233) * 12345.6789) - 0.5;
      const h3 = fract(Math.sin((it + 1) * 39.425) * 24634.6345) - 0.5;
      const d = [curDir[0] + sigma * h1, curDir[1] + sigma * h2, curDir[2] + sigma * h3];
      const L = Math.hypot(d[0], d[1], d[2]);
      if (!(L > 0)) continue;
      const dn = [d[0] / L, d[1] / L, d[2] / L];
      const t = rayPoint(dn);
      if (t && feasible(t)) {
        const l = linf(t);
        if (l < cur.linf) {
          cur = { t, linf: l };
          curDir = dn;
        }
      }
      sigma *= 0.99;
    }
    best = cur;
  }
  return best ? { ...best, feasibleSamples, sampled: samples } : { t: null, linf: null, feasibleSamples: 0, sampled: samples };
}
