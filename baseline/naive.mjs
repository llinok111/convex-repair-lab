// baseline/naive.mjs — the BASELINE the README compares against.
// Naive repair: one pass, each violating vertex is pushed along the *single deepest* violated
// plane normal by exactly its own excess (L1 allocation on that one plane). It ignores the other
// violated planes and never re-audits, so it is the "obvious" thing to write.
import { facePlanes, bboxDiagonal } from '../src/core.mjs';

export function repairNaive(mesh, options = {}) {
  const diag = bboxDiagonal(mesh);
  const epsRel = options.epsRel ?? 1e-9;
  const eps = options.eps ?? epsRel * diag;
  const { planes } = facePlanes(mesh, eps);
  const V = mesh.vertices.map((v) => [v[0], v[1], v[2]]);
  const deepest = new Map();
  for (let vi = 0; vi < V.length; vi++) {
    for (let fi = 0; fi < planes.length; fi++) {
      const pl = planes[fi];
      if (!pl) continue;
      const e = pl.normal[0] * V[vi][0] + pl.normal[1] * V[vi][1] + pl.normal[2] * V[vi][2] - pl.offset;
      if (e <= eps) continue;
      const cur = deepest.get(vi);
      if (!cur || e > cur.excess) deepest.set(vi, { excess: e, normal: pl.normal });
    }
  }
  let maxShift = 0;
  for (const [vi, { excess, normal }] of deepest) {
    const l1 = Math.abs(normal[0]) + Math.abs(normal[1]) + Math.abs(normal[2]);
    if (!(l1 > 0)) continue;
    const d = excess / l1;
    const t = [-d * Math.sign(normal[0]), -d * Math.sign(normal[1]), -d * Math.sign(normal[2])];
    V[vi] = [V[vi][0] + t[0], V[vi][1] + t[1], V[vi][2] + t[2]];
    maxShift = Math.max(maxShift, Math.max(Math.abs(t[0]), Math.abs(t[1]), Math.abs(t[2])));
  }
  return { vertices: V, faces: mesh.faces, touchedVertices: deepest.size, maxShift };
}
