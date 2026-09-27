import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, solveWithIsolation, validatePayload, ValidationError } from '../index.js';

// ---------------------------------------------------------------------------
// Independent reference implementations (dense bracket + golden-section on
// convex 1-D objectives). Deliberately shares no code with the solver.
// ---------------------------------------------------------------------------

function refSpread(x, P, d) {
  let m = 0;
  for (let a = 0; a < x.length; a++) {
    for (let b = a + 1; b < x.length; b++) {
      const v = Math.abs(x[b] - x[a] - d * (P[b] - P[a]));
      if (v > m) m = v;
    }
  }
  return m / 2;
}

function goldenMin(f, lo, hi, iters = 200) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - phi * (hi - lo);
      fc = f(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + phi * (hi - lo);
      fd = f(d);
    }
  }
  return { d: (lo + hi) / 2, v: f((lo + hi) / 2) };
}

function refMinimax(x, P) {
  const range = x[x.length - 1] - x[0];
  return goldenMin((d) => refSpread(x, P, d), 1e-12, 2 * range + 1).v;
}

function refSse(x, P, R) {
  const n = x.length;
  const sse = (d) => {
    const ys = x.map((xi, i) => xi - d * P[i]);
    const maxY = Math.max(...ys);
    const minY = Math.min(...ys);
    if (maxY - minY > 2 * R + 1e-9) return Infinity;
    const mean = ys.reduce((a, b) => a + b, 0) / n;
    const s = Math.min(Math.max(mean, maxY - R), minY + R);
    return ys.reduce((acc, y) => acc + (y - s) ** 2, 0);
  };
  const range = x[x.length - 1] - x[0];
  const dOpt = goldenMin((d) => refSpread(x, P, d), 1e-12, 2 * range + 1).d;
  // feasible interval { spread(d) <= R } is an interval; bisect its ends
  let lo = 1e-12;
  let hi = dOpt;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (refSpread(x, P, mid) <= R) hi = mid;
    else lo = mid;
  }
  const dLo = hi;
  lo = dOpt;
  hi = 2 * range + 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (refSpread(x, P, mid) <= R) lo = mid;
    else hi = mid;
  }
  const dHi = lo;
  return goldenMin(sse, dLo, dHi, 300).v;
}

function* enumerateSteps(maxGaps, prefix = []) {
  if (prefix.length === maxGaps.length) {
    yield prefix;
    return;
  }
  for (let g = 1; g <= maxGaps[prefix.length] + 1; g++) {
    yield* enumerateSteps(maxGaps, [...prefix, g]);
  }
}

function prefixSums(steps) {
  const P = [0];
  for (const g of steps) P.push(P[P.length - 1] + g);
  return P;
}

function refSolve(x, maxGaps) {
  let Rstar = Infinity;
  const rung = [];
  for (const steps of enumerateSteps(maxGaps)) {
    const r = refMinimax(x, prefixSums(steps));
    if (r < Rstar - 1e-9) {
      Rstar = r;
      rung.length = 0;
      rung.push(steps);
    } else if (r <= Rstar + 1e-9) {
      rung.push(steps);
    }
  }
  let best = null;
  for (const steps of rung) {
    const sse = refSse(x, prefixSums(steps), Rstar);
    if (!best || sse < best.sse - 1e-7) {
      best = { steps, sse };
    }
    // equal SSE -> keep first (lexicographically smallest steps)
  }
  return { Rstar, steps: best.steps, sse: best.sse };
}

// deterministic PRNG
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// Targeted cases
// ---------------------------------------------------------------------------

test('exact collinear traces with missing meridians recover the true grid', () => {
  const r = solve({ x: [10, 30, 50, 80, 100], maxGaps: [3, 3, 3, 3], tolerance: 0 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.spacing - 10) < 1e-9);
  assert.ok(Math.abs(r.start - 10) < 1e-9);
  assert.deepEqual(r.indices, [1, 3, 5, 8, 10]);
  assert.deepEqual(r.gapsFilled, [1, 1, 2, 1]);
  assert.ok(r.maxDeviation < 1e-9);
  assert.ok(r.squaredDeviations < 1e-9);
  assert.equal(r.items.length, 5);
  assert.deepEqual(r.items.map((it) => it.position), [1, 2, 3, 4, 5]);
});

test('lexicographic tie-break prefers fewer missing lines', () => {
  // Both spacing 10 (no missing) and spacing 5 (one missing per gap) fit exactly.
  const r = solve({ x: [0, 10, 20, 30, 40], maxGaps: [1, 1, 1, 1], tolerance: 0 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.spacing - 10) < 1e-9);
  assert.deepEqual(r.indices, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.gapsFilled, [0, 0, 0, 0]);
});

test('global adjudication beats per-segment nearest rounding', () => {
  // True grid: spacing 10, indices 1..5, deviations within 1; the joint
  // minimax optimum is spacing 31/3 with max deviation 5/6.
  const r = solve({ x: [0, 9, 21, 30, 40], maxGaps: [1, 1, 1, 1], tolerance: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.indices, [1, 2, 3, 4, 5]);
  assert.deepEqual(r.gapsFilled, [0, 0, 0, 0]);
  assert.ok(Math.abs(r.spacing - 31 / 3) < 1e-6, `spacing=${r.spacing}`);
  assert.ok(Math.abs(r.maxDeviation - 5 / 6) < 1e-6, `maxDev=${r.maxDeviation}`);
});

test('SSE tie-break picks the centered fit among minimax solutions', () => {
  const x = [0, 11, 20, 29, 40];
  const maxGaps = [0, 0, 0, 0];
  const r = solve({ x, maxGaps, tolerance: 100 });
  const P = [0, 1, 2, 3, 4];
  const R = refMinimax(x, P);
  assert.ok(Math.abs(r.maxDeviation - R) < 1e-6, `${r.maxDeviation} vs ${R}`);
  const sse = refSse(x, P, R);
  assert.ok(Math.abs(r.squaredDeviations - sse) < 1e-4, `${r.squaredDeviations} vs ${sse}`);
});

test('infeasible case reports first failing trace and index ranges', () => {
  const r = solve({ x: [0, 10, 11, 20, 30], maxGaps: [0, 0, 0, 0], tolerance: 0.4 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_COMMON_SPACING');
  assert.equal(r.firstFailingTrace, 3);
  assert.deepEqual(r.previousIndexRange, [2, 2]);
  assert.deepEqual(r.allowedIndexRange, [3, 3]);
  assert.ok(r.minAchievableMaxDeviation > 0.4);
});

test('infeasible diagnosis respects missing-line bounds', () => {
  // Prefix [0,10,20] fits spacing 10 (steps 1,1 -> last index 3) and spacing 5
  // (steps 2,2 -> last index 5); the 4th trace at 100 is unreachable either way.
  const r = solve({ x: [0, 10, 20, 100, 110], maxGaps: [1, 1, 1, 1], tolerance: 0.5 });
  assert.equal(r.ok, false);
  assert.equal(r.firstFailingTrace, 4);
  assert.deepEqual(r.previousIndexRange, [3, 5]);
  assert.deepEqual(r.allowedIndexRange, [4, 7]);
});

test('validation rejects malformed payloads', () => {
  assert.throws(() => solve({ x: [1, 2, 3], maxGaps: [0, 0], tolerance: 1 }), ValidationError);
  assert.throws(
    () => solve({ x: [1, 2.5, 3, 4, 5], maxGaps: [0, 0, 0, 0], tolerance: 1 }),
    ValidationError,
  );
  assert.throws(
    () => solve({ x: [1, 2, 3, 4, 5], maxGaps: [0, 0, 0], tolerance: 1 }),
    ValidationError,
  );
  assert.throws(
    () => solve({ x: [1, 2, 3, 4, 5], maxGaps: [0, 0, 0, 0], tolerance: -1 }),
    ValidationError,
  );
  assert.throws(
    () => solve({ x: [5, 4, 3, 2, 1], maxGaps: [0, 0, 0, 0], tolerance: 1 }),
    ValidationError,
  );
  const errors = validatePayload({ x: [1, 2, 3], maxGaps: [], tolerance: 1 });
  assert.ok(errors.length > 0);
});

// ---------------------------------------------------------------------------
// Cross-checks against the independent reference on randomized inputs
// ---------------------------------------------------------------------------

test('randomized cross-check against brute-force reference', () => {
  const rand = lcg(20260926);
  for (let iter = 0; iter < 120; iter++) {
    const n = 5 + Math.floor(rand() * 4); // 5..8 traces
    const maxGaps = Array.from({ length: n - 1 }, () => Math.floor(rand() * 4)); // 0..3
    let x = [Math.floor(rand() * 50)];
    const collinear = rand() < 0.25;
    if (collinear) {
      const s = x[0];
      const d = 3 + Math.floor(rand() * 20);
      const steps = maxGaps.map((g) => 1 + Math.floor(rand() * (g + 1)));
      const P = prefixSums(steps);
      x = P.map((p) => s + d * p);
    } else {
      for (let i = 1; i < n; i++) x.push(x[i - 1] + 3 + Math.floor(rand() * 40));
    }
    const got = solve({ x, maxGaps, tolerance: 1e6 });
    const want = refSolve(x, maxGaps);
    assert.ok(got.ok, `case ${iter}: expected feasible`);
    assert.ok(
      Math.abs(got.maxDeviation - want.Rstar) < 1e-6,
      `case ${iter}: maxDeviation ${got.maxDeviation} vs ${want.Rstar} (x=${x}, maxGaps=${maxGaps})`,
    );
    assert.ok(
      Math.abs(got.squaredDeviations - want.sse) < 1e-3,
      `case ${iter}: sse ${got.squaredDeviations} vs ${want.sse} (x=${x}, maxGaps=${maxGaps})`,
    );
    assert.deepEqual(
      got.gapsFilled,
      want.steps.map((g) => g - 1),
      `case ${iter}: missing-line sequence (x=${x}, maxGaps=${maxGaps})`,
    );
    // consistency of reported items
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(got.items[i].deviation) <= got.maxDeviation + 1e-9);
      assert.ok(Math.abs(got.items[i].fitted + got.items[i].deviation - x[i]) < 1e-9);
    }
    for (let j = 0; j < n - 1; j++) {
      assert.equal(got.indices[j + 1] - got.indices[j] - 1, got.gapsFilled[j]);
      assert.ok(got.gapsFilled[j] <= maxGaps[j]);
    }
  }
});

test('randomized infeasible cases agree with reference R*', () => {
  const rand = lcg(777);
  for (let iter = 0; iter < 40; iter++) {
    const n = 5 + Math.floor(rand() * 3);
    const maxGaps = Array.from({ length: n - 1 }, () => Math.floor(rand() * 3));
    const x = [Math.floor(rand() * 20)];
    for (let i = 1; i < n; i++) x.push(x[i - 1] + 3 + Math.floor(rand() * 40));
    const want = refSolve(x, maxGaps);
    const tol = want.Rstar * (0.3 + rand() * 0.5); // below R*
    const got = solve({ x, maxGaps, tolerance: tol });
    assert.equal(got.ok, false, `case ${iter}: x=${x} maxGaps=${maxGaps} tol=${tol} R*=${want.Rstar}`);
    assert.ok(Math.abs(got.minAchievableMaxDeviation - want.Rstar) < 1e-6);
    assert.ok(got.firstFailingTrace >= 3 && got.firstFailingTrace <= n);
    assert.ok(got.previousIndexRange[0] <= got.previousIndexRange[1]);
    assert.ok(got.allowedIndexRange[0] <= got.allowedIndexRange[1]);
  }
});

test('large and negative coordinates stay exact', () => {
  const rand = lcg(13579);
  for (let iter = 0; iter < 40; iter++) {
    const n = 5 + Math.floor(rand() * 3);
    const maxGaps = Array.from({ length: n - 1 }, () => Math.floor(rand() * 3));
    const x = [Math.floor(rand() * 1_000_000) - 500_000]; // starts within ±5e5
    for (let i = 1; i < n; i++) x.push(x[i - 1] + 1000 + Math.floor(rand() * 50000));
    const got = solve({ x, maxGaps, tolerance: 1e6 });
    const want = refSolve(x, maxGaps);
    assert.ok(got.ok, `case ${iter}: expected feasible`);
    assert.ok(
      Math.abs(got.maxDeviation - want.Rstar) < 1e-6 * Math.max(1, want.Rstar),
      `case ${iter}: maxDeviation ${got.maxDeviation} vs ${want.Rstar} (x=${x}, maxGaps=${maxGaps})`,
    );
    assert.deepEqual(got.gapsFilled, want.steps.map((g) => g - 1), `case ${iter}: gaps`);
  }
});

test('wide search space (10 traces, up to 100 missing per gap) stays fast', () => {
  const steps = [3, 1, 4, 1, 5, 9, 2, 6, 5];
  const P = prefixSums(steps);
  const rand = lcg(42);
  const x = P.map((p) => 7 + 13 * p + (Math.floor(rand() * 3) - 1)); // noise in {-1,0,1}
  const maxGaps = Array(9).fill(100);
  const t0 = performance.now();
  const r = solve({ x, maxGaps, tolerance: 2 });
  const ms = performance.now() - t0;
  assert.ok(r.ok);
  // The optimum must be at least as good as the underlying noisy grid (R <= 1).
  assert.ok(r.maxDeviation <= 1, `maxDev=${r.maxDeviation}`);
  assert.ok(r.spacing > 0);
  assert.ok(ms < 5000, `took ${ms}ms`);
});

// ---------------------------------------------------------------------------
// Isolation review (隔离复核)
// ---------------------------------------------------------------------------

test('isolation review isolates the single moisture-deformed trace', () => {
  // Grid spacing 10 with trace 3 shifted from 30 to 35 (tolerance 1).
  const r = solveWithIsolation({
    x: [10, 20, 35, 40, 50],
    maxGaps: [0, 0, 0, 0],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.isolation.position, 3);
  assert.equal(r.isolation.x, 35);
  assert.deepEqual(r.isolation.reachableIndexRange, [3, 3]);
  assert.equal(r.isolation.nearestIndex, 3);
  assert.ok(Math.abs(r.isolation.nearestFitted - 30) < 1e-9);
  assert.ok(Math.abs(r.isolation.minDeviation - 5) < 1e-9);
  assert.ok(r.isolation.minDeviation > 1, 'evidence must exceed the tolerance');
  assert.ok(r.isolation.exceedsToleranceBy > 0);
  assert.ok(Math.abs(r.spacing - 10) < 1e-9);
  assert.ok(Math.abs(r.start - 10) < 1e-9);
  assert.deepEqual(r.indices, [1, 2, 4, 5]);
  assert.deepEqual(r.gapsFilled, [0, 1, 0]);
  assert.deepEqual(
    r.items.map((it) => it.position),
    [1, 2, 4, 5],
  );
  assert.equal(r.items.length, 4);
});

test('missing-line limit holds continuously across the isolated position', () => {
  // True indices 1,2,6,7 (gaps 0,3,0) with trace 3 contaminated: the straddle
  // needs the merged limit maxGaps[1]+maxGaps[2]+1 = 3, not either side alone.
  const r = solveWithIsolation({
    x: [10, 20, 47, 60, 70],
    maxGaps: [1, 1, 1, 1],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.isolation.position, 3);
  assert.deepEqual(r.indices, [1, 2, 6, 7]);
  assert.deepEqual(r.gapsFilled, [0, 3, 0]);
  assert.deepEqual(r.isolation.reachableIndexRange, [4, 4]);
  assert.ok(Math.abs(r.isolation.nearestFitted - 40) < 1e-9);
  assert.ok(Math.abs(r.isolation.minDeviation - 7) < 1e-9);
});

test('isolation review reaches indices below 1 and above the last kept index', () => {
  const first = solveWithIsolation({
    x: [16, 20, 30, 40, 50],
    maxGaps: [0, 0, 0, 0],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.isolation.position, 1);
  assert.deepEqual(first.isolation.reachableIndexRange, [0, 0]);
  assert.ok(Math.abs(first.isolation.nearestFitted - 10) < 1e-9);
  assert.ok(Math.abs(first.isolation.minDeviation - 6) < 1e-9);

  const last = solveWithIsolation({
    x: [10, 20, 30, 40, 56],
    maxGaps: [0, 0, 0, 0],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(last.ok, true);
  assert.equal(last.isolation.position, 5);
  assert.deepEqual(last.isolation.reachableIndexRange, [5, 5]);
  assert.ok(Math.abs(last.isolation.nearestFitted - 50) < 1e-9);
  assert.ok(Math.abs(last.isolation.minDeviation - 6) < 1e-9);
});

test('empty reachable interval is the strongest contamination evidence', () => {
  // Traces 2 and 4 land on consecutive meridians once trace 3 is isolated,
  // leaving it no grid slot at all.
  const r = solveWithIsolation({
    x: [0, 10, 15, 20, 30],
    maxGaps: [0, 0, 0, 0],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.isolation.position, 3);
  assert.equal(r.isolation.reachableIndexRange, null);
  assert.equal(r.isolation.nearestIndex, null);
  assert.equal(r.isolation.nearestFitted, null);
  assert.equal(r.isolation.minDeviation, null);
  assert.deepEqual(r.indices, [1, 2, 3, 4]);
});

test('tie among kept-trace criteria prefers the larger isolated-trace deviation', () => {
  // Isolating trace 6 (empty reachable interval) or trace 7 (min deviation
  // 12.5) yields identical max deviation, SSE and missing-line sequence; the
  // empty interval — infinite deviation — must win.
  const r = solveWithIsolation({
    x: [4, 18, 35, 53, 78, 93, 98],
    maxGaps: [1, 0, 0, 2, 2, 0],
    tolerance: 2.5,
    isolationReview: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.isolation.position, 6);
  assert.equal(r.isolation.reachableIndexRange, null);
  assert.ok(Math.abs(r.maxDeviation - 2.5) < 1e-9);
  assert.deepEqual(r.gapsFilled, [0, 0, 0, 1, 0]);
});

test('isolation impossible returns the first basis instead of a fake success', () => {
  // Two traces are contaminated, so no single exclusion restores a grid.
  const r = solveWithIsolation({
    x: [10, 25, 35, 40, 50],
    maxGaps: [0, 0, 0, 0],
    tolerance: 1,
    isolationReview: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ISOLATION_IMPOSSIBLE');
  assert.equal(r.firstBasis.position, 1);
  assert.equal(r.firstBasis.reason, 'REMAINDER_INFEASIBLE');
  assert.ok(r.firstBasis.diagnosis.firstFailingTrace >= 3);
  assert.ok(r.firstBasis.diagnosis.minAchievableMaxDeviation > 1);
  assert.ok(!('items' in r) && !('isolation' in r), 'must not look like a restoration');
});

test('without the flag the legacy verdicts are bit-identical', () => {
  const payloads = [
    { x: [10, 20, 35, 40, 50], maxGaps: [0, 0, 0, 0], tolerance: 1 },
    { x: [10, 30, 50, 80, 100], maxGaps: [3, 3, 3, 3], tolerance: 0 },
    { x: [0, 9, 21, 30, 40], maxGaps: [1, 1, 1, 1], tolerance: 1 },
    { x: [0, 10, 11, 20, 30], maxGaps: [0, 0, 0, 0], tolerance: 0.4 },
  ];
  for (const p of payloads) {
    assert.deepEqual(solveWithIsolation({ ...p, isolationReview: false }), solve(p));
  }
  // Flag on but the full set already fits: plain verdict, nothing isolated.
  const r = solveWithIsolation({ ...payloads[1], isolationReview: true });
  assert.equal(r.ok, true);
  assert.equal(r.isolation, undefined);
  assert.deepEqual(r.indices, [1, 3, 5, 8, 10]);
  // No exact-arithmetic internals leak into either result.
  assert.ok(!('_exact' in r));
  assert.ok(!('_exact' in solve(payloads[1])));
});

test('isolationReview flag is validated when present', () => {
  assert.throws(
    () =>
      solveWithIsolation({
        x: [1, 2, 3, 4, 5],
        maxGaps: [0, 0, 0, 0],
        tolerance: 1,
        isolationReview: 'yes',
      }),
    ValidationError,
  );
  // Payload validation still applies with the flag on.
  assert.throws(
    () => solveWithIsolation({ x: [1, 2, 3], maxGaps: [0, 0], tolerance: 1, isolationReview: true }),
    ValidationError,
  );
});

// ---------------------------------------------------------------------------
// Isolation review cross-checks against an independent brute-force reference
// ---------------------------------------------------------------------------

function refKeptGaps(maxGaps, k) {
  const n = maxGaps.length + 1;
  const g = [];
  for (let j = 0; j < n - 1; j++) {
    if (j === k) continue;
    if (j === k - 1) {
      if (k + 1 <= n - 1) g.push(maxGaps[k - 1] + maxGaps[k] + 1);
      continue;
    }
    g.push(maxGaps[j]);
  }
  return g;
}

function refReachable(k, n, maxGaps, I) {
  if (k === 0) return [I[0] - maxGaps[0] - 1, I[0] - 1];
  if (k === n - 1) {
    const last = I[I.length - 1];
    return [last + 1, last + maxGaps[n - 2] + 1];
  }
  const L = I[k - 1];
  const R = I[k];
  return [Math.max(L + 1, R - maxGaps[k] - 1), Math.min(R - 1, L + maxGaps[k - 1] + 1)];
}

// SSE-optimal (d, s) for a fixed step vector at residual cap R (golden
// section, deliberately independent of the solver's exact candidates).
function refGrid(x, P, R) {
  const n = x.length;
  const sse = (d) => {
    const ys = x.map((xi, i) => xi - d * P[i]);
    const maxY = Math.max(...ys);
    const minY = Math.min(...ys);
    if (maxY - minY > 2 * R + 1e-9) return Infinity;
    const mean = ys.reduce((a, b) => a + b, 0) / n;
    const s = Math.min(Math.max(mean, maxY - R), minY + R);
    return ys.reduce((acc, y) => acc + (y - s) ** 2, 0);
  };
  const range = x[x.length - 1] - x[0];
  const dOpt = goldenMin((d) => refSpread(x, P, d), 1e-12, 2 * range + 1).d;
  let lo = 1e-12;
  let hi = dOpt;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (refSpread(x, P, mid) <= R) hi = mid;
    else lo = mid;
  }
  const dLo = hi;
  lo = dOpt;
  hi = 2 * range + 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (refSpread(x, P, mid) <= R) lo = mid;
    else hi = mid;
  }
  const d = goldenMin(sse, dLo, lo, 300).d;
  const ys = x.map((xi, i) => xi - d * P[i]);
  const maxY = Math.max(...ys);
  const minY = Math.min(...ys);
  const mean = ys.reduce((a, b) => a + b, 0) / n;
  const s = Math.min(Math.max(mean, maxY - R), minY + R);
  return { d, s, sse: sse(d) };
}

function refIsolation(x, maxGaps, tol) {
  const cands = [];
  let nearBoundary = Math.abs(refSolve(x, maxGaps).Rstar - tol) < 2e-6;
  for (let k = 0; k < x.length; k++) {
    const kx = x.filter((_, i) => i !== k);
    const kg = refKeptGaps(maxGaps, k);
    const r = refSolve(kx, kg);
    if (Math.abs(r.Rstar - tol) < 2e-6) nearBoundary = true;
    if (r.Rstar > tol + 1e-9) continue;
    const P = prefixSums(r.steps);
    const grid = refGrid(kx, P, r.Rstar);
    const I = P.map((p) => p + 1);
    const [lo, hi] = refReachable(k, x.length, maxGaps, I);
    let minDev = null;
    if (lo <= hi) {
      minDev = Infinity;
      for (let idx = lo; idx <= hi; idx++) {
        const dev = Math.abs(x[k] - (grid.s + grid.d * (idx - 1)));
        if (dev < minDev) minDev = dev;
      }
      if (Math.abs(minDev - tol) < 2e-6) nearBoundary = true;
    }
    if (minDev !== null && minDev <= tol + 1e-9) continue; // not provably foreign
    cands.push({ k, R: r.Rstar, sse: r.sse, gaps: r.steps.map((g) => g - 1), minDev });
  }
  return { cands, nearBoundary };
}

function refCandidateCmp(a, b) {
  if (Math.abs(a.R - b.R) > 1e-7) return a.R - b.R;
  if (Math.abs(a.sse - b.sse) > 1e-7) return a.sse - b.sse;
  for (let i = 0; i < a.gaps.length; i++) {
    if (a.gaps[i] !== b.gaps[i]) return a.gaps[i] - b.gaps[i];
  }
  const am = a.minDev === null ? Infinity : a.minDev;
  const bm = b.minDev === null ? Infinity : b.minDev;
  if (Math.abs(am - bm) > 1e-7) return bm - am; // larger deviation wins
  return a.k - b.k;
}

test('isolation review cross-check against brute-force reference', () => {
  const rand = lcg(20260927);
  let checked = 0;
  for (let iter = 0; iter < 400 && checked < 40; iter++) {
    const n = 5 + Math.floor(rand() * 2); // 5..6 traces
    const maxGaps = Array.from({ length: n - 1 }, () => Math.floor(rand() * 3)); // 0..2
    const x = [Math.floor(rand() * 20)];
    for (let i = 1; i < n; i++) x.push(x[i - 1] + 3 + Math.floor(rand() * 30));
    const fullR = refSolve(x, maxGaps).Rstar;
    if (fullR < 1e-6) continue;
    const tol = fullR * (0.2 + rand() * 0.6); // below the full-set optimum
    const ref = refIsolation(x, maxGaps, tol);
    if (ref.nearBoundary) continue; // 避开浮点参考解与精确裁决的边界情形
    const got = solveWithIsolation({ x, maxGaps, tolerance: tol, isolationReview: true });
    if (ref.cands.length === 0) {
      assert.equal(got.ok, false, `case ${iter}: x=${x} maxGaps=${maxGaps} tol=${tol}`);
      assert.equal(got.code, 'ISOLATION_IMPOSSIBLE');
      assert.ok(got.firstBasis.position >= 1 && got.firstBasis.position <= n);
      checked++;
      continue;
    }
    const want = ref.cands.reduce((a, b) => (refCandidateCmp(b, a) < 0 ? b : a));
    assert.equal(got.ok, true, `case ${iter}: x=${x} maxGaps=${maxGaps} tol=${tol}`);
    assert.equal(
      got.isolation.position,
      want.k + 1,
      `case ${iter}: isolated position (x=${x} maxGaps=${maxGaps} tol=${tol})`,
    );
    assert.equal(got.isolation.x, x[want.k]);
    assert.ok(Math.abs(got.maxDeviation - want.R) < 1e-6, `case ${iter}: maxDev`);
    assert.ok(Math.abs(got.squaredDeviations - want.sse) < 1e-3, `case ${iter}: sse`);
    assert.deepEqual(got.gapsFilled, want.gaps, `case ${iter}: gaps`);
    if (want.minDev === null) {
      assert.equal(got.isolation.reachableIndexRange, null);
    } else {
      assert.ok(Math.abs(got.isolation.minDeviation - want.minDev) < 1e-4, `case ${iter}: minDev`);
      assert.ok(got.isolation.minDeviation > tol, `case ${iter}: evidence exceeds tolerance`);
      const [lo, hi] = got.isolation.reachableIndexRange;
      assert.ok(got.isolation.nearestIndex >= lo && got.isolation.nearestIndex <= hi);
    }
    // Structural invariants of the reported restoration.
    assert.deepEqual(
      got.items.map((it) => it.position),
      Array.from({ length: n }, (_, i) => i + 1).filter((p) => p !== want.k + 1),
    );
    for (let j = 0; j < got.indices.length - 1; j++) {
      assert.ok(got.indices[j] < got.indices[j + 1], 'indices strictly increase');
      assert.equal(got.indices[j + 1] - got.indices[j] - 1, got.gapsFilled[j]);
    }
    assert.ok(got.maxDeviation <= tol + 1e-9, 'kept traces honour the tolerance');
    checked++;
  }
  assert.ok(checked >= 20, `only ${checked} cases checked`);
});
