// Small, dependency-free statistics for the A/B analysis.

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (xs) => quantile(xs, 0.5);

// Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7)
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Wilson score interval for a proportion
export function wilson(x, n, z = 1.96) {
  if (!n) return [NaN, NaN];
  const p = x / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [c - h, c + h];
}

// Two-proportion comparison: difference (b - a), Newcombe 95% CI, two-sided pooled z-test p-value
export function twoProportions(xa, na, xb, nb) {
  const pa = xa / na, pb = xb / nb, diff = pb - pa;
  const [la, ua] = wilson(xa, na), [lb, ub] = wilson(xb, nb);
  const lo = diff - Math.sqrt((pb - lb) ** 2 + (ua - pa) ** 2);
  const hi = diff + Math.sqrt((ub - pb) ** 2 + (pa - la) ** 2);
  const pool = (xa + xb) / (na + nb);
  const se = Math.sqrt(pool * (1 - pool) * (1 / na + 1 / nb));
  const z = se > 0 ? diff / se : 0;
  return { pa, pb, diff, ci: [lo, hi], z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

// Seeded PRNG so reports are reproducible run to run
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function gammaSample(k, rand) { // Marsaglia–Tsang, k >= 1 (we only use shape >= 1)
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { const u1 = rand(), u2 = rand(); x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = rand();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaSample = (a, b, rand) => { const x = gammaSample(a, rand), y = gammaSample(b, rand); return x / (x + y); };

// Bayesian: P(rate_b > rate_a) with uniform Beta(1,1) priors
export function probBBeatsA(xa, na, xb, nb, draws = 20000, seed = 7) {
  const rand = rng(seed); let wins = 0;
  for (let i = 0; i < draws; i++) if (betaSample(1 + xb, 1 + nb - xb, rand) > betaSample(1 + xa, 1 + na - xa, rand)) wins++;
  return wins / draws;
}

// Mann–Whitney U (normal approximation with tie correction): two-sided p for "b tends to differ from a"
export function mannWhitney(a, b) {
  const all = a.map((v) => [v, 0]).concat(b.map((v) => [v, 1])).sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length); let tieTerm = 0;
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j) / 2 + 1, t = j - i + 1; tieTerm += t ** 3 - t;
    for (let k = i; k <= j; k++) ranks[k] = r; i = j + 1;
  }
  const n1 = a.length, n2 = b.length, N = n1 + n2;
  let r2 = 0; all.forEach((x, i) => { if (x[1] === 1) r2 += ranks[i]; });
  const u2 = r2 - n2 * (n2 + 1) / 2, mu = n1 * n2 / 2;
  const sigma = Math.sqrt(n1 * n2 / 12 * ((N + 1) - tieTerm / (N * (N - 1))));
  const z = sigma > 0 ? (u2 - mu) / sigma : 0;
  return { u: u2, z, p: 2 * (1 - normCdf(Math.abs(z))), probBGreater: n1 && n2 ? u2 / (n1 * n2) : NaN };
}

// Bootstrap CI for median(b) - median(a)
export function bootstrapMedianDiff(a, b, iters = 2000, seed = 11) {
  if (!a.length || !b.length) return { diff: NaN, ci: [NaN, NaN] };
  const rand = rng(seed), out = [];
  const resample = (xs) => Array.from(xs, () => xs[Math.floor(rand() * xs.length)]);
  for (let i = 0; i < iters; i++) out.push(median(resample(b)) - median(resample(a)));
  return { diff: median(b) - median(a), ci: [quantile(out, 0.025), quantile(out, 0.975)] };
}

// Sample ratio mismatch: chi-square goodness of fit against the configured weights (1 df for 2 arms)
export function srm(counts, weights) {
  const n = counts.reduce((a, b) => a + b, 0), wsum = weights.reduce((a, b) => a + b, 0);
  let chi = 0; counts.forEach((c, i) => { const e = n * weights[i] / wsum; chi += e > 0 ? (c - e) ** 2 / e : 0; });
  const df = counts.length - 1;
  // chi-square survival for df=1 via normal; for df>1 Wilson–Hilferty approximation
  const p = df === 1 ? 2 * (1 - normCdf(Math.sqrt(chi)))
    : 1 - normCdf(((chi / df) ** (1 / 3) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df)));
  return { chi, p };
}

// Visitors per arm needed to detect p1 -> p2 (two-sided alpha 0.05, power 0.8)
export function sampleSize(p1, p2, zA = 1.96, zB = 0.8416) {
  const pbar = (p1 + p2) / 2;
  return Math.ceil((zA * Math.sqrt(2 * pbar * (1 - pbar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2);
}
