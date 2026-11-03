import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baselineMismatch,
  checkFileLengths,
  compareWithBaseline,
  extractMetrics,
} from "./check-duplication.mjs";

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

test("checkFileLengths：超软限旧文件只能持平或下降，新超限文件直接拒绝", () => {
  const limits = { lib: 600, components: 800, pages: 400 };
  const baseline = { "apps/web/src/lib/old.ts": 700 };
  assert.deepEqual(
    checkFileLengths(
      {
        "apps/web/src/lib/old.ts": 690,
        "apps/web/src/lib/new.ts": 600,
        "apps/web/src/app/example/page.tsx": 400,
      },
      baseline,
      limits,
    ),
    [],
  );
  assert.deepEqual(
    checkFileLengths(
      {
        "apps/web/src/lib/old.ts": 701,
        "apps/web/src/lib/new.ts": 601,
        "apps/web/src/components/new.tsx": 801,
        "apps/web/src/app/new/page.tsx": 401,
      },
      baseline,
      limits,
    ),
    [
      "apps/web/src/lib/old.ts: 701 行 > 既有基线 700（已超软限，只准缩小）",
      "apps/web/src/lib/new.ts: 601 行 > 新文件软限 600，新增超限文件需先拆分",
      "apps/web/src/components/new.tsx: 801 行 > 新文件软限 800，新增超限文件需先拆分",
      "apps/web/src/app/new/page.tsx: 401 行 > 新文件软限 400，新增超限文件需先拆分",
    ],
  );
  assert.deepEqual(
    checkFileLengths({ "apps/web/src/app/actions/large.ts": 900 }, baseline, limits),
    ["apps/web/src/lib/old.ts: 已从源码树消失，请从行数基线移除该白名单项"],
  );
});
