// Exact rational arithmetic — every tie-break (max deviation, SSE, lexicographic
// missing-line sequence) is decided with bigint fractions, never floating point.

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export class Fr {
  constructor(num, den = 1n) {
    if (den === 0n) throw new Error('zero denominator');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    if (num === 0n) den = 1n;
    else {
      const g = gcd(num, den);
      num /= g;
      den /= g;
    }
    this.n = num;
    this.d = den;
  }

  static from(n) {
    if (n instanceof Fr) return n;
    return new Fr(BigInt(n));
  }

  add(o) {
    return new Fr(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    return new Fr(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o) {
    return new Fr(this.n * o.n, this.d * o.d);
  }
  div(o) {
    return new Fr(this.n * o.d, this.d * o.n);
  }
  neg() {
    return new Fr(-this.n, this.d);
  }
  abs() {
    return this.n < 0n ? this.neg() : this;
  }
  cmp(o) {
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  lt(o) {
    return this.cmp(o) < 0;
  }
  le(o) {
    return this.cmp(o) <= 0;
  }
  gt(o) {
    return this.cmp(o) > 0;
  }
  ge(o) {
    return this.cmp(o) >= 0;
  }
  toNumber() {
    return Number(this.n) / Number(this.d);
  }
}

export const fr0 = new Fr(0n);
export const fr1 = new Fr(1n);
export const fr2 = new Fr(2n);

export function frMax(a, b) {
  return a.cmp(b) >= 0 ? a : b;
}
export function frMin(a, b) {
  return a.cmp(b) <= 0 ? a : b;
}
