import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, wilson, twoProportions, probBBeatsA, mannWhitney, bootstrapMedianDiff, srm, sampleSize, median, quantile } from '../scripts/lib/stats.mjs';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('normal CDF', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(-1.645), 0.05, 1e-4);
});

test('quantiles', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([0, 10], 0.25), 2.5);
});

test('Wilson interval matches reference (30/100)', () => {
  const [lo, hi] = wilson(30, 100);
  close(lo, 0.2189, 1e-3); close(hi, 0.3958, 1e-3);
});

test('two proportions: 30/100 vs 45/100', () => {
  const r = twoProportions(30, 100, 45, 100);
  close(r.diff, 0.15, 1e-9);
  close(r.z, 2.191, 2e-3);
  close(r.p, 0.0284, 1e-3);
  assert.ok(r.ci[0] > 0 && r.ci[1] < 0.3);
});

test('Bayesian probability is sensible', () => {
  close(probBBeatsA(30, 100, 45, 100), 0.986, 0.01);
  close(probBBeatsA(30, 100, 30, 100), 0.5, 0.02);
});

test('Mann–Whitney detects a clear shift and not a null', () => {
  const a = Array.from({ length: 60 }, (_, i) => i);
  assert.ok(mannWhitney(a, a.map((x) => x + 30)).p < 0.001);
  assert.ok(mannWhitney(a, a).p > 0.9);
});

test('bootstrap median difference', () => {
  const a = Array.from({ length: 200 }, (_, i) => i % 50), b = a.map((x) => x + 10);
  const r = bootstrapMedianDiff(a, b);
  assert.equal(r.diff, 10);
  assert.ok(r.ci[0] > 0 && r.ci[1] < 20);
});

test('sample ratio mismatch', () => {
  assert.ok(srm([500, 500], [1, 1]).p > 0.9);
  assert.ok(srm([600, 400], [1, 1]).p < 0.001);
  assert.ok(srm([250, 750], [1, 3]).p > 0.9);
});

test('sample size for 30% -> 40%', () => {
  close(sampleSize(0.3, 0.4), 356, 2);
});
