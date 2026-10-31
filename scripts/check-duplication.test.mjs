import assert from "node:assert/strict";
import { test } from "node:test";
import { baselineMismatch, compareWithBaseline, extractMetrics } from "./check-duplication.mjs";

const REPORT = {
  statistics: {
    total: {
      clones: 214.0,
      duplicatedLines: 2005.0,
      percentage: 3.3000589,
      sources: 449,
      lines: 60721,
    },
  },
};

test("extractMetrics：取整数字指标并四舍五入 percentage 到两位小数", () => {
  const got = extractMetrics(REPORT);
  assert.deepEqual(got, { duplicatedLines: 2005, clones: 214, percentage: 3.3, sources: 449 });
});

test("extractMetrics：报告结构缺失时抛错（宁可失败不可静默放行）", () => {
  assert.throws(() => extractMetrics({}));
  assert.throws(() => extractMetrics({ statistics: { total: { percentage: 1 } } }));
  assert.throws(() => extractMetrics(null));
});

test("compareWithBaseline：持平与下降都放行", () => {
  const baseline = { duplicatedLines: 2005, clones: 215 };
  assert.deepEqual(compareWithBaseline({ duplicatedLines: 2005, clones: 214 }, baseline), {
    ok: true,
    reasons: [],
  });
  assert.deepEqual(compareWithBaseline({ duplicatedLines: 1000, clones: 10 }, baseline), {
    ok: true,
    reasons: [],
  });
});

test("compareWithBaseline：任一指标升高即失败，且给出可读原因", () => {
  const baseline = { duplicatedLines: 2005, clones: 214 };
  const got = compareWithBaseline({ duplicatedLines: 2006, clones: 214 }, baseline);
  assert.equal(got.ok, false);
  assert.match(got.reasons[0], /duplicatedLines 2006 > 基线 2005/);

  const got2 = compareWithBaseline({ duplicatedLines: 100, clones: 300 }, baseline);
  assert.equal(got2.ok, false);
  assert.match(got2.reasons[0], /clones 300 > 基线 214/);
});

test("compareWithBaseline：基线缺字段或缺失整体失败", () => {
  const got = compareWithBaseline({ duplicatedLines: 0, clones: 0 }, { duplicatedLines: 5 });
  assert.equal(got.ok, false);
  assert.match(got.reasons[0], /缺少数值字段 clones/);
  assert.equal(compareWithBaseline({ duplicatedLines: 0, clones: 0 }, null).ok, false);
});

test("baselineMismatch：minTokens 变更使旧基线失效", () => {
  assert.deepEqual(baselineMismatch({ minTokens: 40 }, { minTokens: 40 }), []);
  assert.match(baselineMismatch({ minTokens: 40 }, { minTokens: 60 })[0], /不一致/);
  assert.match(baselineMismatch(null, { minTokens: 40 })[0], /基线缺失/);
});
