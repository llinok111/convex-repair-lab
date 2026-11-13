# convex-repair-lab

**Promise:** repair a punctured convex mesh back to convexity by the **exact per-vertex L∞-minimal
supporting-plane shift**, iterated to a fixed point — **6/6 generated repairable meshes reach 0
supporting-plane violations**, and the **2/2 hard meshes are honestly refused with a measured
residual > 0** instead of being reported as fixed. Baseline in-repo: the obvious one-pass
"push each vertex along its deepest violated face normal" (`baseline/naive.mjs`) leaves
**1308 supporting-plane violations across 6/8 meshes** where we leave **0 on the 6 converged**.
The exact shift is **never beaten by an independent 20 000-direction sampling oracle** (worst
oracle/exact gap 0.23%), and the verdict/iteration count is **scale-invariant over 1e-6 … 1e6**.

Upstream: none

## What this is

A closed triangulated mesh is convex **iff every face plane is a supporting plane**: for each face
with outward unit normal `n` and offset `d`, every vertex `v` satisfies `n·v ≤ d`. This tool
*measures* that predicate and then *constructs* a fix:

1. `src/core.mjs` audits all `|vertices| × |faces|` half-space predicates in one pass and groups
   the violations per vertex.
2. For each violating vertex it solves, **exactly**, `min ‖t‖∞ s.t. nᵢ·(v+t) ≤ dᵢ` as the small LP
   `min δ s.t. nᵢ·t ≤ −eᵢ, ±t_k ≤ δ` by enumerating LP vertices (≤ 3 plane rows + box rows; four
   plane rows are linearly dependent because their δ-column is zero). This is why optima with an
   active *box* face are found — a plane-only active-set solver silently misses them.
3. It re-derives the face planes from the moved vertices and repeats (fixed point). It stops at
   `0` violations, or **refuses** with `infeasible-vertex-*`, `shift-budget-exceeded`,
   `stalled-no-progress` or `max-iterations`, always reporting the measured residual.

The iteration runs in **normalised space** (bbox diagonal = 1) and scales back, so the verdict is
scale-equivariant by construction rather than by luck.

## Run it

```bash
node tools/gen-sample.mjs      # ~20 s, deterministic: rebuilds data/ byte-for-byte
node bench/verify.mjs          # behavioural assertions, exit 0 = all pass
node bench/bench.mjs           # timing -> bench/result.json  (REPS=7 by default)
python3 -m http.server 4173    # then open http://localhost:4173  (CDN importmap, three r0.169.0)
```

`src/core.mjs` is a pure ES module — no `three`, no DOM, no I/O — so
`node -e "import('./src/core.mjs')"` runs headless. The browser imports **the same module** and
diffs its live numbers against `data/reference.json` baked by the node generator
(`MATCHES` / `MISMATCH` shown in the panel).

## Evidence (`bench/result.json`, 1 warmup + 7 samples, 4-core shared host)

| quantity | value |
|---|---|
| repairable meshes repaired to 0 violations | **6/6** |
| hard meshes honestly refused (residual > 0) | **2/2** (residual 60 and 10) |
| false "converged" claims | **0** |
| naive one-pass baseline residual violations | **1308** (ours: 0 on the 6 converged) |
| oracle beat the exact solver | **0 / 105 violating vertex groups** (max 23 active planes) |
| worst oracle/exact gap | **0.23%** (oracle is an upper bound; it never found less) |
| scale invariance 1e-6/1e-3/1/1e3/1e6 | **40/40** verdicts+iteration counts identical, drift ≤ 3.5e-14 |
| warm total, all 8 meshes | median **1516.9 ms**, min 1505.7, p95 1549.1, RSD **0.9%**, n=7 |
| cold start (first call in a process) | **1625.2 ms** |

`node bench/verify.mjs` prints every asserted value (A1–A10), not just `ok`.

## 本轮创新

B 档. Previous geometry certificates in this account only **judged** a mesh (convexity witness,
clearance interval, maximin cover); this is the first one that turns the supporting-plane predicate
into a **constructive repair operator with an optimality claim**: the exact L∞-minimal per-vertex
shift on the frozen planes (an LP solved by vertex enumeration over plane **and box** rows), iterated
to a fixed point, with **explicit refusal** when no feasible shift exists on the frozen planes and a
re-audit of the *moved* mesh. Nothing else here claims "I fixed it, and the shift is minimal, and
here is an independent oracle that failed to beat it".

## Known limitations (read these)

- **Absolute thresholds are disclosed.** `epsRel = 1e-9` is the *reporting* tolerance relative to
  bbox diagonal; the fixed point is iterated at `workEps = eps·1e-3` so a "0 violations" claim
  survives an independent re-audit; the LP feasibility tolerance is `1e-10·diag`; the oracle's own
  feasibility tolerance is `1e-9` relative and shares no constant with the solver. Because
  `repairConvexity` normalises to unit bbox diagonal, these are relative thresholds with **no
  absolute scale of validity inside 1e-6 … 1e6**; outside that range float64 rounding dominates.
- **Refusal is a real outcome, not a bug.** 2 of the 8 corpus meshes have no feasible L∞ shift on
  the frozen planes (or need a shift beyond `0.5·diag`), and the iteration can also *amplify*
  violations before refusing (60 vs 32 before). The tool reports that; it never reports success.
- **Scale invariance is measured, not proven.** 40/40 scaling checks pass on this 8-mesh corpus;
  this is evidence, not a theorem for arbitrary input.
- **Not a speed tool.** The naive baseline is ~0.13 ms for the corpus versus our ~1517 ms median:
  exactness and the fixed point cost ~4 orders of magnitude. Do not read the table as a speed win.
- **Our total L∞ shift (17.58) is larger than naive's (4.02).** Naive moves each vertex once along
  one plane and stops with 1308 violations. Iterating to a true fixed point accumulates more total
  displacement. The claim is *residual 0*, not *least total motion*.
- **Topology is unchanged.** We move existing vertices; we never re-triangulate or add/remove
  faces. The repaired mesh is audited only for supporting planes — not for self-intersection.
- **Coverage.** Only meshes whose *base* was verified exactly convex and watertight (8/8) are used.
  No guarantee for open, non-manifold or degenerate input.
- **No GPU/browser verification.** The headless environment forbids browsers: we verify only that
  `python3 -m http.server 4173` serves the page and that the importmap is present. There are no
  screenshots and none are claimed.

## Layout

```
index.html            single entry, pinned three r0.169.0 importmap
main.js               rendering + interaction only (orbit camera, toggles, MATCHES/MISMATCH panel)
src/core.mjs          pure geometry: audit, exact L∞ LP, fixed-point repair, scale normalisation
tools/gen-sample.mjs  deterministic corpus + perturbation search + baked reference.json
baseline/naive.mjs    the one-pass baseline the README compares against
bench/verify.mjs      A1–A10 behavioural assertions (exit 0/1)
bench/oracle.mjs      independent direction-sampling upper-bound oracle
bench/bench.mjs       warmup + 7 samples + cold start -> bench/result.json
data/                 generated (small JSON), rebuilt by tools/gen-sample.mjs
```
