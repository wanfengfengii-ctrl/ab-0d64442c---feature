import { Fr, fr0, fr2 } from './fraction.js';

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('；'));
    this.code = 'VALIDATION';
    this.errors = errors;
  }
}

export class SearchBudgetError extends Error {
  constructor() {
    super('搜索空间过大，无法在预算内完成全局裁决');
    this.code = 'SEARCH_BUDGET';
  }
}

export const LIMITS = {
  minTraces: 5,
  maxTraces: 10,
  maxAbsX: 1_000_000,
  maxGap: 100,
  maxTolerance: 1_000_000,
};

const DFS_BUDGET = 5_000_000;
// Double-precision oracle boundary error is < 1e-8; distinct rational minimax
// levels are separated by >= 1/(2*M^2) > 5e-7 for M <= 909. 1e-7 sits safely
// between the two, so the near-optimal enumeration captures exactly the
// optimal rung of gap vectors.
const ORACLE_SLACK = 1e-7;
const RUNG_SLACK = 5e-8;

export function validatePayload(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['请求体必须是 JSON 对象'];
  }
  const { x, maxGaps, tolerance } = raw;
  const xIsArray = Array.isArray(x);
  if (!xIsArray || x.length < LIMITS.minTraces || x.length > LIMITS.maxTraces) {
    errors.push(`x 必须是 ${LIMITS.minTraces} 至 ${LIMITS.maxTraces} 条残迹横坐标组成的数组`);
  } else {
    x.forEach((v, i) => {
      if (!Number.isInteger(v)) errors.push(`x[${i}] 必须是整数`);
      else if (Math.abs(v) > LIMITS.maxAbsX) errors.push(`x[${i}] 超出允许范围 ±${LIMITS.maxAbsX}`);
    });
    for (let i = 1; i < x.length; i++) {
      if (Number.isInteger(x[i]) && Number.isInteger(x[i - 1]) && x[i] <= x[i - 1]) {
        errors.push('x 必须严格递增（残迹按从左到右录入）');
        break;
      }
    }
  }
  if (!Array.isArray(maxGaps) || (xIsArray && maxGaps.length !== x.length - 1)) {
    errors.push('maxGaps 必须是长度等于残迹数减一的数组');
  } else {
    maxGaps.forEach((v, i) => {
      if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxGap) {
        errors.push(`maxGaps[${i}] 必须是 0 至 ${LIMITS.maxGap} 的整数`);
      }
    });
  }
  if (
    typeof tolerance !== 'number' ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    tolerance > LIMITS.maxTolerance
  ) {
    errors.push(`tolerance 必须是 0 至 ${LIMITS.maxTolerance} 的数值`);
  }
  return errors;
}

function toFraction(t) {
  return new Fr(BigInt(Math.round(t * 1e6)), 1_000_000n);
}

function prefixSums(steps) {
  const P = [0];
  for (const g of steps) P.push(P[P.length - 1] + g);
  return P;
}

// ---------------------------------------------------------------------------
// Feasibility / enumeration over integer step vectors g (g[j] = missing+1).
// A residual cap R is feasible iff all pairwise constraints
//   |(x_t - x_i) - d*(P_t - P_i)| <= 2R
// admit a common d > 0 (s is then the midpoint of the remaining intercept
// interval). DFS assigns steps left to right and maintains the intersection
// d-interval, which prunes the space to near-linear size in practice.
// ---------------------------------------------------------------------------

function dfsDouble(x, maxGaps, R, budget, onLeaf, stopAtFirst) {
  const n = x.length;
  const P = new Array(n).fill(0);
  const steps = new Array(n - 1).fill(0);
  const twoR = 2 * R;
  let leaves = 0;

  function rec(t, lo, hi) {
    if (++budget.count > budget.limit) throw new SearchBudgetError();
    const gMax = maxGaps[t - 1] + 1;
    for (let g = 1; g <= gMax; g++) {
      const Pt = P[t - 1] + g;
      P[t] = Pt;
      steps[t - 1] = g;
      let lo2 = lo;
      let hi2 = hi;
      const xt = x[t];
      for (let i = 0; i < t; i++) {
        const M = Pt - P[i];
        const dx = xt - x[i];
        const l = (dx - twoR) / M;
        const h = (dx + twoR) / M;
        if (l > lo2) lo2 = l;
        if (h < hi2) hi2 = h;
      }
      if (lo2 <= hi2 && hi2 > 0) {
        if (t === n - 1) {
          leaves++;
          const stop = onLeaf(steps, P);
          if (stop === true || stopAtFirst) return true;
        } else if (rec(t + 1, lo2, hi2)) {
          return true;
        }
      }
    }
    return false;
  }

  rec(1, -Infinity, Infinity);
  return leaves;
}

function dfsExact(x, maxGaps, R, budget, onLeaf, stopAtFirst) {
  const n = x.length;
  const P = new Array(n).fill(0);
  const steps = new Array(n - 1).fill(0);
  const twoR = R.mul(fr2);
  let leaves = 0;

  function rec(t, lo, hi) {
    if (++budget.count > budget.limit) throw new SearchBudgetError();
    const gMax = maxGaps[t - 1] + 1;
    for (let g = 1; g <= gMax; g++) {
      const Pt = P[t - 1] + g;
      P[t] = Pt;
      steps[t - 1] = g;
      let lo2 = lo;
      let hi2 = hi;
      const xt = new Fr(BigInt(x[t]));
      for (let i = 0; i < t; i++) {
        const M = Pt - P[i];
        const dx = xt.sub(new Fr(BigInt(x[i])));
        const Mfr = new Fr(BigInt(M));
        const l = dx.sub(twoR).div(Mfr);
        const h = dx.add(twoR).div(Mfr);
        if (lo2 === null || l.gt(lo2)) lo2 = l;
        if (hi2 === null || h.lt(hi2)) hi2 = h;
      }
      if (lo2 === null || (lo2.le(hi2) && hi2.gt(fr0))) {
        if (t === n - 1) {
          leaves++;
          const stop = onLeaf(steps, P);
          if (stop === true || stopAtFirst) return true;
        } else if (rec(t + 1, lo2, hi2)) {
          return true;
        }
      }
    }
    return false;
  }

  rec(1, null, null);
  return leaves;
}

// ---------------------------------------------------------------------------
// Exact minimax deviation R(g) for a fixed step vector: the spread
//   f(d) = max_{a<b} |(x_b - x_a) - d*(P_b - P_a)| / 2
// is the max of the affine lines +/-((x_b-x_a) - d*(P_b-P_a)), hence convex
// piecewise-linear in d. Its kinks — and therefore its minimum over d > 0 —
// are attained where two such lines intersect: same-sign crossings
// d = (dx1 - dx2)/(M1 - M2) or opposite-sign (equioscillation) crossings
// d = (dx1 + dx2)/(M1 + M2); the latter with identical pairs also covers the
// V-vertices d = dx/M.
// ---------------------------------------------------------------------------

function spreadExact(x, P, d) {
  let m = fr0;
  const n = x.length;
  for (let a = 0; a < n; a++) {
    const xa = new Fr(BigInt(x[a]));
    for (let b = a + 1; b < n; b++) {
      const dx = new Fr(BigInt(x[b])).sub(xa);
      const M = new Fr(BigInt(P[b] - P[a]));
      const v = dx.sub(d.mul(M)).abs();
      if (v.gt(m)) m = v;
    }
  }
  return m.div(fr2);
}

function minimaxCandidates(x, P) {
  const n = x.length;
  const cands = [];
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const dx1 = x[b] - x[a];
      const M1 = P[b] - P[a];
      for (let c = 0; c < n; c++) {
        for (let e = c + 1; e < n; e++) {
          const dx2 = x[e] - x[c];
          const M2 = P[e] - P[c];
          if (M2 !== M1) cands.push([dx1 - dx2, M1 - M2]); // same-sign crossing
          cands.push([dx1 + dx2, M1 + M2]); // opposite-sign crossing (+V-vertices)
        }
      }
    }
  }
  return cands;
}

function minimaxRExact(x, P) {
  let best = null;
  for (const [num, den] of minimaxCandidates(x, P)) {
    if (den === 0) continue;
    const d = new Fr(BigInt(num), BigInt(den));
    if (d.le(fr0)) continue;
    const v = spreadExact(x, P, d);
    if (best === null || v.lt(best)) best = v;
  }
  return best;
}

function minimaxRDouble(x, P) {
  let best = Infinity;
  const n = x.length;
  for (const [num, den] of minimaxCandidates(x, P)) {
    if (den === 0) continue;
    const d = num / den;
    if (d <= 0) continue;
    // Evaluate |dx - d*M| as |dx*den - num*M| / |den|: the integer numerators
    // stay below 2^53 (exact), leaving a single rounding at ~1e-9 — far below
    // the rational rung separation, unlike a naive d*M product.
    const aden = Math.abs(den);
    let m = 0;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const v = Math.abs((x[b] - x[a]) * den - num * (P[b] - P[a])) / aden;
        if (v > m) m = v;
      }
    }
    if (m / 2 < best) best = m / 2;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Exact SSE-optimal (d, s) for a fixed step vector at residual cap R.
// SSE(d) = min_{s in I(d)} sum (y_i - s)^2 with y_i = x_i - d*P_i and
// I(d) = [max y - R, min y + R]; it is convex piecewise-quadratic in d, so the
// optimum is among: OLS stationary point, per-boundary stationary points,
// y-crossing kinks, and the feasible-interval endpoints (spread(d) = R).
// ---------------------------------------------------------------------------

function bestSseExact(x, P, R) {
  const n = x.length;
  const xB = x.map(BigInt);
  const PB = P.map(BigInt);
  const nB = BigInt(n);
  const twoR = R.mul(fr2);

  function sseAt(d) {
    if (d.le(fr0)) return null;
    const ys = xB.map((xi, i) => new Fr(xi).sub(d.mul(new Fr(PB[i]))));
    let maxY = ys[0];
    let minY = ys[0];
    let sum = fr0;
    for (const y of ys) {
      if (y.gt(maxY)) maxY = y;
      if (y.lt(minY)) minY = y;
      sum = sum.add(y);
    }
    if (maxY.sub(minY).gt(twoR)) return null;
    const mean = sum.div(new Fr(nB));
    const loB = maxY.sub(R);
    const hiB = minY.add(R);
    let s;
    if (mean.lt(loB)) s = loB;
    else if (mean.gt(hiB)) s = hiB;
    else s = mean;
    let sse = fr0;
    for (const y of ys) {
      const r = y.sub(s);
      sse = sse.add(r.mul(r));
    }
    return { d, s, sse };
  }

  const cands = [];
  // OLS stationary point (2x2 normal equations).
  let S1 = 0n;
  let S2 = 0n;
  let Sx = 0n;
  let SxP = 0n;
  for (let i = 0; i < n; i++) {
    S1 += PB[i];
    S2 += PB[i] * PB[i];
    Sx += xB[i];
    SxP += xB[i] * PB[i];
  }
  const det = nB * S2 - S1 * S1;
  if (det !== 0n) cands.push(new Fr(nB * SxP - Sx * S1, det));
  // V-vertices, pairwise crossings, and residual-cap boundary points.
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const dx = new Fr(xB[b] - xB[a]);
      const M = new Fr(PB[b] - PB[a]);
      cands.push(dx.div(M));
      cands.push(dx.sub(twoR).div(M));
      cands.push(dx.add(twoR).div(M));
      for (let c = 0; c < n; c++) {
        for (let e = c + 1; e < n; e++) {
          const M2 = PB[e] - PB[c];
          const M1 = PB[b] - PB[a];
          if (M2 === M1) continue;
          cands.push(new Fr(xB[b] - xB[a] - (xB[e] - xB[c]), M1 - M2));
        }
      }
    }
  }
  // Stationary points of pieces where s is clamped to maxY - R or minY + R.
  for (let k = 0; k < n; k++) {
    let den = 0n;
    for (let i = 0; i < n; i++) den += (PB[i] - PB[k]) * (PB[i] - PB[k]);
    if (den === 0n) continue;
    let numPlus = new Fr(0n);
    let numMinus = new Fr(0n);
    for (let i = 0; i < n; i++) {
      const dp = new Fr(PB[i] - PB[k]);
      const base = new Fr(xB[i] - xB[k]);
      numPlus = numPlus.add(dp.mul(base.add(R)));
      numMinus = numMinus.add(dp.mul(base.sub(R)));
    }
    cands.push(numPlus.div(new Fr(den)));
    cands.push(numMinus.div(new Fr(den)));
  }

  let best = null;
  for (const d of cands) {
    const r = sseAt(d);
    if (!r) continue;
    if (
      !best ||
      r.sse.lt(best.sse) ||
      (r.sse.cmp(best.sse) === 0 && (r.d.lt(best.d) || (r.d.cmp(best.d) === 0 && r.s.lt(best.s))))
    ) {
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Failure diagnosis: first trace (left to right) that cannot be brought into
// any common grid within tolerance, plus the already-determined index range
// of its left neighbour and the index range it would be allowed to occupy.
// ---------------------------------------------------------------------------

function diagnose(x, maxGaps, tolFr, budget) {
  const n = x.length;
  for (let e = 2; e < n; e++) {
    const subX = x.slice(0, e + 1);
    const subG = maxGaps.slice(0, e);
    const feasible = dfsExact(subX, subG, tolFr, budget, () => {}, true) > 0;
    if (feasible) continue;
    const prevX = x.slice(0, e);
    const prevG = maxGaps.slice(0, e - 1);
    let minP = Infinity;
    let maxP = -Infinity;
    dfsExact(prevX, prevG, tolFr, budget, (steps, P) => {
      const last = P[e - 1];
      if (last < minP) minP = last;
      if (last > maxP) maxP = last;
    }, false);
    return {
      firstFailingTrace: e + 1, // 1-based position among recorded traces
      previousIndexRange: [minP + 1, maxP + 1], // 1-based meridian indices
      allowedIndexRange: [minP + 2, maxP + maxGaps[e - 1] + 2],
    };
  }
  // Unreachable: full set infeasible implies some prefix is infeasible.
  return { firstFailingTrace: n, previousIndexRange: null, allowedIndexRange: null };
}

// ---------------------------------------------------------------------------

export function solve(raw) {
  const errors = validatePayload(raw);
  if (errors.length > 0) throw new ValidationError(errors);

  const x = raw.x;
  const maxGaps = raw.maxGaps;
  const n = x.length;
  const tolFr = toFraction(raw.tolerance);
  const budget = { count: 0, limit: DFS_BUDGET };

  // Phase 1 — binary-search the minimax level with the double oracle.
  let lo = 0;
  let hi = Math.max(1, (x[n - 1] - x[0]) / 2);
  for (let it = 0; it < 70; it++) {
    const mid = (lo + hi) / 2;
    if (dfsDouble(x, maxGaps, mid, budget, () => {}, true) > 0) hi = mid;
    else lo = mid;
  }

  // Phase 2 — enumerate the optimal rung (double) and pin R* exactly.
  const near = [];
  let minR = Infinity;
  dfsDouble(x, maxGaps, hi + ORACLE_SLACK, budget, (steps) => {
    const r = minimaxRDouble(x, prefixSums(steps));
    if (r < minR - RUNG_SLACK) {
      minR = r;
      near.length = 0;
      near.push(steps.slice());
    } else if (r <= minR + RUNG_SLACK) {
      near.push(steps.slice());
    }
  }, false);
  let Rstar = null;
  for (const steps of near) {
    const r = minimaxRExact(x, prefixSums(steps));
    if (Rstar === null || r.lt(Rstar)) Rstar = r;
  }

  if (Rstar === null || Rstar.gt(tolFr)) {
    const diag = diagnose(x, maxGaps, tolFr, budget);
    return {
      ok: false,
      code: 'NO_COMMON_SPACING',
      message: `不存在满足误差约束的共同网距：第 ${diag.firstFailingTrace} 条残迹无法纳入同一经线网`,
      minAchievableMaxDeviation: Rstar === null ? null : Rstar.toNumber(),
      ...diag,
    };
  }

  // Phase 3 — exact enumeration at R*: SSE tie-break, then lexicographic
  // missing-line sequence (DFS visits step vectors in lexicographic order).
  let best = null;
  dfsExact(x, maxGaps, Rstar, budget, (steps) => {
    const P = prefixSums(steps);
    const r = bestSseExact(x, P, Rstar);
    if (r && (!best || r.sse.lt(best.sse))) {
      best = { steps: steps.slice(), P, d: r.d, s: r.s, sse: r.sse };
    }
  }, false);

  const { P, d, s, sse } = best;
  const indices = P.map((p) => p + 1); // 1-based meridian indices
  const fitted = P.map((p) => s.add(d.mul(new Fr(BigInt(p)))));
  const deviations = x.map((xi, i) => new Fr(BigInt(xi)).sub(fitted[i]));
  let maxDev = fr0;
  for (const r of deviations) {
    const a = r.abs();
    if (a.gt(maxDev)) maxDev = a;
  }

  return {
    ok: true,
    spacing: d.toNumber(),
    start: s.toNumber(),
    maxDeviation: maxDev.toNumber(),
    squaredDeviations: sse.toNumber(),
    indices,
    items: x.map((xi, i) => ({
      position: i + 1,
      x: xi,
      index: indices[i],
      fitted: fitted[i].toNumber(),
      deviation: deviations[i].toNumber(),
    })),
    gapsFilled: best.steps.map((g) => g - 1),
  };
}
