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
  if ('isolation' in raw && typeof raw.isolation !== 'boolean') {
    errors.push('isolation 必须是布尔值（true / false）');
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
// Every position carries its own inclusive [loB[j], hiB[j]] step bounds — the
// ordinary solver uses [1, maxGaps[j]+1], while isolation review widens the
// single step spanning the withheld trace. A residual cap R is feasible iff
// all pairwise constraints
//   |(x_t - x_i) - d*(P_t - P_i)| <= 2R
// admit a common d > 0 (s is then the midpoint of the remaining intercept
// interval). DFS assigns steps left to right and maintains the intersection
// d-interval, which prunes the space to near-linear size in practice.
// ---------------------------------------------------------------------------

function dfsDouble(x, loB, hiB, R, budget, onLeaf, stopAtFirst) {
  const n = x.length;
  const P = new Array(n).fill(0);
  const steps = new Array(n - 1).fill(0);
  const twoR = 2 * R;
  let leaves = 0;

  function rec(t, lo, hi) {
    if (++budget.count > budget.limit) throw new SearchBudgetError();
    for (let g = loB[t - 1]; g <= hiB[t - 1]; g++) {
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

function dfsExact(x, loB, hiB, R, budget, onLeaf, stopAtFirst) {
  const n = x.length;
  const P = new Array(n).fill(0);
  const steps = new Array(n - 1).fill(0);
  const twoR = R.mul(fr2);
  let leaves = 0;

  function rec(t, lo, hi) {
    if (++budget.count > budget.limit) throw new SearchBudgetError();
    for (let g = loB[t - 1]; g <= hiB[t - 1]; g++) {
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

function boundsFromGaps(maxGaps) {
  return {
    loB: new Array(maxGaps.length).fill(1),
    hiB: maxGaps.map((m) => m + 1),
  };
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
// Full three-level adjudication (minimax R*, then SSE, then lexicographic gap
// sequence) for one trace set with explicit per-position step bounds.
// ---------------------------------------------------------------------------

// fitCap: when given, phase 3 is skipped unless R* <= fitCap (the only regime
// where a tolerance-feasible fit can exist).
function adjudicateCore(x, loB, hiB, budget, fitCap) {
  const n = x.length;

  // Phase 1 — binary-search the minimax level with the double oracle.
  let lo = 0;
  let hi = Math.max(1, (x[n - 1] - x[0]) / 2);
  for (let it = 0; it < 70; it++) {
    const mid = (lo + hi) / 2;
    if (dfsDouble(x, loB, hiB, mid, budget, () => {}, true) > 0) hi = mid;
    else lo = mid;
  }

  // Phase 2 — enumerate the optimal rung (double) and pin R* exactly.
  const near = [];
  let minR = Infinity;
  dfsDouble(x, loB, hiB, hi + ORACLE_SLACK, budget, (steps) => {
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
  if (Rstar === null) return null;
  if (fitCap !== undefined && Rstar.gt(fitCap)) return { Rstar };

  // Phase 3 — exact enumeration at R*: SSE tie-break, then lexicographic
  // missing-line sequence (DFS visits step vectors in lexicographic order).
  let best = null;
  dfsExact(x, loB, hiB, Rstar, budget, (steps) => {
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
    Rstar,
    steps: best.steps,
    P,
    d,
    s,
    sse,
    result: {
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
    },
  };
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
    const { loB, hiB } = boundsFromGaps(maxGaps.slice(0, e));
    const feasible = dfsExact(subX, loB, hiB, tolFr, budget, () => {}, true) > 0;
    if (feasible) continue;
    const prevX = x.slice(0, e);
    const prev = boundsFromGaps(maxGaps.slice(0, e - 1));
    let minP = Infinity;
    let maxP = -Infinity;
    dfsExact(prevX, prev.loB, prev.hiB, tolFr, budget, (steps, P) => {
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
// 隔离复核 (isolation review)
//
// When the ordinary restoration cannot make every trace share one meridian
// web, the conservator may withhold exactly one trace suspected of damp
// deformation. The per-gap missing-line limits still apply continuously
// across the withheld position: for an interior trace k the retained step
// spanning its gap equals a + b where the two original gaps contribute
// a in [1, maxGaps[k-1]+1], b in [1, maxGaps[k]+1], hence the spanning step
// lies in [2, maxGaps[k-1] + maxGaps[k] + 2] and always admits a split that
// assigns the withheld trace one meridian index. This is a *joint* decision
// over the withheld trace, the retained indices, spacing and start — never a
// reuse of the ordinary verdict after deleting the local outlier.
//
// Contamination proof: the full set is tolerance-infeasible. If the retained
// set admits a tolerance-feasible grid, then no extension of ANY such grid to
// the withheld trace (at any gap-compliant reachable index) can fit — such an
// extension would be a fully feasible restoration. The withheld trace's
// nearest reachable deviation on the adjudicated grid is concrete evidence of
// that and is mathematically guaranteed to exceed tolerance.
// ---------------------------------------------------------------------------

// Per-position step bounds for the retained traces after withholding k. The
// step spanning the withheld position ranges over every split of the two
// original adjacent gaps: the retained neighbours may be adjacent meridians
// (spanning step 1 — the withheld trace is an extra mark with no slot of its
// own) or enclose up to maxGaps[k-1] + maxGaps[k] missing meridians.
function isolationBounds(maxGaps, k) {
  const n = maxGaps.length + 1;
  const loB = new Array(n - 2).fill(1);
  const hiB = new Array(n - 2);
  for (let j = 0; j < n - 2; j++) {
    if (k > 0 && k < n - 1 && j === k - 1) {
      hiB[j] = maxGaps[k - 1] + maxGaps[k] + 2;
    } else if (j < k) {
      hiB[j] = maxGaps[j] + 1;
    } else {
      hiB[j] = maxGaps[j + 1] + 1;
    }
  }
  return { loB, hiB };
}

// Index interval the withheld trace may occupy strictly between its retained
// neighbours for a retained assignment P, honouring the two adjacent per-gap
// missing-line limits. The interval is empty (lo > hi) when the neighbours are
// adjacent meridians: the withheld trace is an extra mark with no slot of its
// own, and the only grid positions it can be measured against are the two
// bracketing meridians.
function withheldInteriorInterval(P, k, maxGaps) {
  const left = P[k - 1] + 1;
  const right = P[k] + 1;
  return {
    left,
    right,
    lo: Math.max(left + 1, right - maxGaps[k] - 1),
    hi: Math.min(right - 1, left + maxGaps[k - 1] + 1),
  };
}

// Union, over all tolerance-feasible retained assignments, of the withheld
// trace's reachable (strictly-between) index interval. With the first record
// withheld it is relabelled index 1 (the free anchor). Interior assignments
// in which the neighbours are adjacent contribute no slot. Returns null when
// no feasible assignment leaves the withheld trace a meridian slot of its own.
function reachableRange(retainedX, loB, hiB, k, maxGaps, tolFr, budget) {
  if (k === 0) return [1, 1];
  const n = maxGaps.length + 1;
  let lo = Infinity;
  let hi = -Infinity;
  dfsExact(retainedX, loB, hiB, tolFr, budget, (steps, P) => {
    if (k === n - 1) {
      const left = P[P.length - 1] + 1;
      const a = left + 1;
      const b = left + maxGaps[n - 2] + 1;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
      return;
    }
    const iv = withheldInteriorInterval(P, k, maxGaps);
    if (iv.lo <= iv.hi) {
      if (iv.lo < lo) lo = iv.lo;
      if (iv.hi > hi) hi = iv.hi;
    }
  }, false);
  return lo === Infinity ? null : [lo, hi];
}

// Nearest reachable fitted position for the withheld trace under the
// adjudicated retained grid (d, s):
//  - k = 0: the withheld record takes the free index-1 anchor; anchorShift is
//    the offset to add to every retained index label;
//  - interior/right: nearest meridian index in its reachable slot interval,
//    or, when no slot exists, the nearer of the two bracketing meridians.
function nearestReachableFit(xk, d, s, k, P, maxGaps) {
  const xkFr = new Fr(BigInt(xk));
  const devAt = (q) => xkFr.sub(s.add(d.mul(new Fr(BigInt(q - 1))))).abs();
  const n = maxGaps.length + 1;

  if (k === 0) {
    let anchorShift = 1;
    let nearestDev = xkFr.sub(s.sub(d)).abs(); // grid point one step left
    for (let a = 2; a <= maxGaps[0] + 1; a++) {
      const dev = xkFr.sub(s.sub(d.mul(new Fr(BigInt(a))))).abs();
      if (dev.lt(nearestDev)) {
        nearestDev = dev;
        anchorShift = a;
      }
    }
    return { nearestIndex: 1, nearestDev, anchorShift, hasSlot: true };
  }

  let qLo;
  let qHi;
  let hasSlot = true;
  if (k === n - 1) {
    const left = P[P.length - 1] + 1;
    qLo = left + 1;
    qHi = left + maxGaps[n - 2] + 1;
  } else {
    const iv = withheldInteriorInterval(P, k, maxGaps);
    if (iv.lo <= iv.hi) {
      qLo = iv.lo;
      qHi = iv.hi;
    } else {
      hasSlot = false;
      qLo = iv.left;
      qHi = iv.right;
    }
  }

  let nearestIndex = qLo;
  let nearestDev = devAt(qLo);
  for (let q = qLo + 1; q <= qHi; q++) {
    const dev = devAt(q);
    if (dev.lt(nearestDev)) {
      nearestDev = dev;
      nearestIndex = q;
    }
  }
  return { nearestIndex, nearestDev, anchorShift: 0, hasSlot };
}

function trimNum(v) {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
}

function solveIsolation(raw, tolFr) {
  const x = raw.x;
  const maxGaps = raw.maxGaps;
  const n = x.length;
  const candidates = [];

  for (let k = 0; k < n; k++) {
    const retainedX = x.filter((_, i) => i !== k);
    const { loB, hiB } = isolationBounds(maxGaps, k);
    // Each candidate is an independent joint search with its own budget.
    const budget = { count: 0, limit: DFS_BUDGET };
    const core = adjudicateCore(retainedX, loB, hiB, budget, tolFr);
    if (core === null || core.Rstar.gt(tolFr) || !core.result) {
      candidates.push({ position: k + 1, x: x[k], feasible: false, retainedR: core?.Rstar ?? null });
      continue;
    }

    const { nearestIndex, nearestDev, anchorShift, hasSlot } = nearestReachableFit(
      x[k],
      core.d,
      core.s,
      k,
      core.P,
      maxGaps,
    );
    const range = reachableRange(retainedX, loB, hiB, k, maxGaps, tolFr, budget);

    candidates.push({
      position: k + 1,
      x: x[k],
      feasible: true,
      core,
      range,
      nearestIndex,
      nearestDev,
      anchorShift,
      hasSlot,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------

export function solve(raw) {
  const errors = validatePayload(raw);
  if (errors.length > 0) throw new ValidationError(errors);

  const x = raw.x;
  const tolFr = toFraction(raw.tolerance);
  const budget = { count: 0, limit: DFS_BUDGET };
  const { loB, hiB } = boundsFromGaps(raw.maxGaps);

  const core = adjudicateCore(x, loB, hiB, budget);
  if (core === null || core.Rstar.gt(tolFr)) {
    const diag = core === null
      ? { firstFailingTrace: x.length, previousIndexRange: null, allowedIndexRange: null }
      : diagnose(x, raw.maxGaps, tolFr, budget);
    return {
      ok: false,
      code: 'NO_COMMON_SPACING',
      message: `不存在满足误差约束的共同网距：第 ${diag.firstFailingTrace} 条残迹无法纳入同一经线网`,
      minAchievableMaxDeviation: core === null ? null : core.Rstar.toNumber(),
      ...diag,
    };
  }

  return { ok: true, ...core.result };
}

// Isolation review is strictly opt-in: without `isolation: true` the ordinary
// inputs, API contract and verdict are returned unchanged. On success exactly
// one trace is withheld; otherwise the first blocking reason is reported
// explicitly rather than presenting a seemingly successful restoration.
export function solveWithIsolation(raw) {
  const errors = validatePayload(raw);
  if (errors.length > 0) throw new ValidationError(errors);

  const x = raw.x;
  const maxGaps = raw.maxGaps;
  const n = x.length;
  const tolFr = toFraction(raw.tolerance);
  const fullBudget = { count: 0, limit: DFS_BUDGET };
  const fullBounds = boundsFromGaps(maxGaps);
  // Only R* is needed to decide whether isolation applies; skip the phase-3
  // fit whenever the full set cannot be tolerance-feasible anyway.
  const full = adjudicateCore(x, fullBounds.loB, fullBounds.hiB, fullBudget, tolFr);

  if (full !== null && full.Rstar.le(tolFr)) {
    return {
      ok: false,
      code: 'ISOLATION_NOT_NEEDED',
      message: '常规复原已使全部残迹共享同一经线网，无需启用隔离复核',
    };
  }

  const candidates = solveIsolation(raw, tolFr);
  const feasible = candidates.filter((c) => c.feasible);

  if (feasible.length === 0) {
    // First blocking basis in input order: the earliest trace whose
    // withholding still leaves the retained web tolerance-infeasible.
    const c = candidates[0];
    return {
      ok: false,
      code: 'NO_ISOLATABLE_TRACE',
      reason: 'RETAINED_SET_INFEASIBLE',
      message:
        '隔离复核无法成立：无论暂不采信哪一条残迹，其余残迹仍不存在满足误差约束的共同网距' +
        `（首项依据：即使隔离第 ${c.position} 条残迹，保留残迹的最小最大偏差` +
        `为 ${c.retainedR === null ? '不存在可行解' : trimNum(c.retainedR.toNumber())}，仍超过容差 ${raw.tolerance}）`,
      firstBlockingTrace: c.position,
      firstBlockingRetainedMaxDeviation: c.retainedR === null ? null : c.retainedR.toNumber(),
    };
  }

  // Defensive proof filter (mathematically automatic when the full set is
  // tolerance-infeasible — see contamination-proof note above): the withheld
  // trace's nearest reachable fitted position must itself exceed tolerance.
  const proven = feasible.filter((c) => c.nearestDev.gt(tolFr));
  if (proven.length === 0) {
    const c = feasible.sort((a, b) => a.position - b.position)[0];
    return {
      ok: false,
      code: 'NO_ISOLATABLE_TRACE',
      reason: 'WITHHELD_TRACE_NOT_PROVEN_OUTSIDE',
      message:
        `隔离复核无法成立：第 ${c.position} 条残迹仍能在容差内落入其余残迹的可达经线位置` +
        `（最近偏差仅 ${trimNum(c.nearestDev.toNumber())}，未超过容差 ${raw.tolerance}），` +
        '不存在可被证明确实不属于该网格的单条污染残迹',
      firstBlockingTrace: c.position,
    };
  }

  // Joint adjudication over isolation candidates:
  //  1. retained-set max deviation (exact R*);
  //  2. retained-set SSE;
  //  3. retained missing-line sequence lexicographically smallest;
  //  4. withheld trace's deviation from its nearest reachable position larger;
  //  5. stable input order.
  proven.sort((a, b) => {
    const cR = a.core.Rstar.cmp(b.core.Rstar);
    if (cR !== 0) return cR;
    const cS = a.core.sse.cmp(b.core.sse);
    if (cS !== 0) return cS;
    for (let j = 0; j < a.core.steps.length; j++) {
      if (a.core.steps[j] !== b.core.steps[j]) return a.core.steps[j] - b.core.steps[j];
    }
    const cN = b.nearestDev.cmp(a.nearestDev); // larger nearest deviation first
    if (cN !== 0) return cN;
    return a.position - b.position;
  });
  const win = proven[0];
  const k = win.position - 1;
  const shift = win.anchorShift;

  // Map retained results back to original input positions; when the first
  // record is withheld, relabel retained indices past the withheld anchor.
  const retainedPositions = [];
  for (let i = 0; i < n; i++) if (i !== k) retainedPositions.push(i + 1);
  const items = win.core.result.items.map((it, j) => ({
    ...it,
    position: retainedPositions[j],
    index: it.index + shift,
  }));

  // Per-gap missing-line counts; the original gap(s) touching the withheld
  // trace are not jointly observable, so they are reported as null. Map the
  // retained gaps back explicitly (the spanning retained gap, present only in
  // the interior case, maps to no single original gap either).
  const retainedGapFills = win.core.result.gapsFilled; // length n-2
  const gapsFilled = new Array(n - 1).fill(null);
  for (let h = 0; h < n - 2; h++) {
    if (k === 0) {
      gapsFilled[h + 1] = retainedGapFills[h]; // original gap 0 touches trace 1
    } else if (k === n - 1) {
      gapsFilled[h] = retainedGapFills[h]; // original gap n-2 touches trace n
    } else if (h < k - 1) {
      gapsFilled[h] = retainedGapFills[h];
    } else if (h > k - 1) {
      gapsFilled[h + 1] = retainedGapFills[h];
    }
    // h === k-1 is the spanning gap -> leave the two touching gaps null
  }

  // Fitted position of the withheld nearest label; with a left-endpoint
  // re-anchor this is also the new start (fitted position of index 1).
  const nearestFittedPosition = win.core.s
    .add(win.core.d.mul(new Fr(BigInt(win.nearestIndex - 1 - shift))))
    .toNumber();
  const start = k === 0
    ? nearestFittedPosition
    : win.core.result.start;

  return {
    ok: true,
    isolated: true,
    spacing: win.core.result.spacing,
    start,
    maxDeviation: win.core.result.maxDeviation,
    squaredDeviations: win.core.result.squaredDeviations,
    retainedIndices: items.map((it) => it.index),
    items,
    gapsFilled,
    isolatedTrace: {
      position: win.position,
      x: win.x,
      reachableIndexRange: win.range,
      hasOwnMeridianSlot: win.hasSlot,
      nearestFittedIndex: win.nearestIndex,
      nearestFittedPosition,
      nearestDeviation: win.nearestDev.toNumber(),
      tolerance: raw.tolerance,
      evidence: win.hasSlot
        ? `第 ${win.position} 条残迹（x=${win.x}）在其可达序号区间 ${win.range[0]}–${win.range[1]} 内，` +
          `距最近的可达经线位置（序号 ${win.nearestIndex}，拟合横坐标 ${trimNum(nearestFittedPosition)}）` +
          `偏差为 ${trimNum(win.nearestDev.toNumber())}，超过容差 ${raw.tolerance}，` +
          '故可证明其不属于该经线网；且相邻缺线数上限跨越该位置连续成立'
        : `第 ${win.position} 条残迹（x=${win.x}）两侧保留残迹为相邻经线（无属于该残迹的序号槽位），` +
          `其距最近经线位置（序号 ${win.nearestIndex}，拟合横坐标 ${trimNum(nearestFittedPosition)}）` +
          `偏差为 ${trimNum(win.nearestDev.toNumber())}，超过容差 ${raw.tolerance}，` +
          '故可证明其是不属于该经线网的多余标记；且相邻缺线数上限跨越该位置连续成立',
    },
    alternativesConsidered: proven.length,
  };
}
