import assert from "node:assert/strict";
import { test } from "node:test";
import { habitHabitAssociation, habitMetricAssociation, metricMetricCorrelation } from "./correlations";

test("habitHabitAssociation: perfect co-occurrence shows a clean 100pp delta", () => {
  // B is logged on every day A is, and never otherwise.
  const a = [true, true, false, true, false, false];
  const b = [true, true, false, true, false, false];
  const result = habitHabitAssociation(a, b);
  assert.equal(result.rate_b_when_a, 1);
  assert.equal(result.rate_b_when_not_a, 0);
  assert.equal(result.n_a_days, 3);
  assert.equal(result.n_not_a_days, 3);
  assert.equal(result.delta_percentage_points, 100);
});

test("habitHabitAssociation: no relationship gives a near-zero delta", () => {
  const a = [true, false, true, false];
  const b = [true, false, false, true]; // 1/2 both cases
  const result = habitHabitAssociation(a, b);
  assert.equal(result.rate_b_when_a, 0.5);
  assert.equal(result.rate_b_when_not_a, 0.5);
  assert.equal(result.delta_percentage_points, 0);
});

test("habitHabitAssociation: A never logged leaves rate_b_when_a null, not zero", () => {
  const a = [false, false, false];
  const b = [true, false, true];
  const result = habitHabitAssociation(a, b);
  assert.equal(result.rate_b_when_a, null, "no days to compute a rate from — null, not a misleading 0");
  assert.equal(result.n_a_days, 0);
  assert.equal(result.delta_percentage_points, null, "can't compute a delta without both sides");
});

test("habitHabitAssociation: A logged every day leaves rate_b_when_not_a null", () => {
  const a = [true, true, true];
  const b = [true, false, true];
  const result = habitHabitAssociation(a, b);
  assert.equal(result.rate_b_when_not_a, null);
  assert.equal(result.n_not_a_days, 0);
});

test("habitMetricAssociation: higher metric on logged days is reflected in delta", () => {
  const habit = [true, false, true, false, true];
  const metric = [80, 60, 82, 58, 79]; // higher when logged
  const result = habitMetricAssociation(habit, metric);
  assert.equal(result.n_when_logged, 3);
  assert.equal(result.n_when_not_logged, 2);
  assert.ok(result.avg_when_logged! > result.avg_when_not_logged!);
  assert.ok(result.delta! > 0);
});

test("habitMetricAssociation: a gap day (null reading) is excluded, not treated as zero", () => {
  const habit = [true, true, false];
  const metric = [10, null, 5];
  const result = habitMetricAssociation(habit, metric);
  assert.equal(result.n_when_logged, 1, "the null reading on a logged day doesn't count");
  assert.equal(result.avg_when_logged, 10);
});

test("habitMetricAssociation: no data at all on either side is null, not zero", () => {
  const habit = [true, false];
  const metric: (number | null)[] = [null, null];
  const result = habitMetricAssociation(habit, metric);
  assert.equal(result.avg_when_logged, null);
  assert.equal(result.avg_when_not_logged, null);
  assert.equal(result.delta, null);
});

test("metricMetricCorrelation: perfectly correlated series give r close to 1", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [2, 4, 6, 8, 10];
  const result = metricMetricCorrelation(a, b);
  assert.equal(result.n_pairs, 5);
  assert.ok(result.r! > 0.999, `expected ~1, got ${result.r}`);
});

test("metricMetricCorrelation: perfectly inverse series give r close to -1", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [10, 8, 6, 4, 2];
  const result = metricMetricCorrelation(a, b);
  assert.ok(result.r! < -0.999, `expected ~-1, got ${result.r}`);
});

test("metricMetricCorrelation: only paired days count, and gaps on either side are excluded", () => {
  const a = [1, 2, null, 4, 5];
  const b = [1, 2, 3, null, 5];
  const result = metricMetricCorrelation(a, b);
  assert.equal(result.n_pairs, 3, "only days 0, 1, 4 have both readings");
});

test("metricMetricCorrelation: fewer than 2 paired days is undefined, not a fake number", () => {
  const result = metricMetricCorrelation([1, null], [null, 2]);
  assert.equal(result.r, null);
  assert.equal(result.n_pairs, 0);
});

test("metricMetricCorrelation: zero variation in one series avoids a divide-by-zero NaN", () => {
  const a = [5, 5, 5, 5];
  const b = [1, 2, 3, 4];
  const result = metricMetricCorrelation(a, b);
  assert.equal(result.r, null, "no variation in `a` makes the coefficient undefined, not NaN");
  assert.equal(result.n_pairs, 4);
});
