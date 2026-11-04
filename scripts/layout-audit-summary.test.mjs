import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectAuditFiles, formatSummary, summarizeAudit } from "./layout-audit-summary.mjs";

const clean = () => ({
  viewport: { width: 375, height: 900 },
  test: "t",
  checks: [{ label: "a", passed: true }],
  pageErrors: [],
  snapshots: [{ label: "a", findings: [], tiles: ["x.png", "y.png"] }],
});

test("summarizeAudit：全部干净时 ok，并统计检查数与切块数", () => {
  const got = summarizeAudit(clean());
  assert.equal(got.ok, true);
  assert.equal(got.checks, 1);
  assert.equal(got.tiles, 2);
  assert.equal(got.width, 375);
});

test("summarizeAudit：场景失败、几何 finding、页面异常任何一项都使 ok 为 false", () => {
  const failed = clean();
  failed.checks.push({ label: "b", passed: false, error: "boom" });
  assert.equal(summarizeAudit(failed).ok, false);
  assert.equal(summarizeAudit(failed).failedChecks.length, 1);

  const found = clean();
  found.snapshots[0].findings = [{ kind: "page-overflow", target: "document/body" }];
  const s = summarizeAudit(found);
  assert.equal(s.ok, false);
  assert.deepEqual(s.findings[0], {
    label: "a",
    kind: "page-overflow",
    target: "document/body",
  });

  const errored = clean();
  errored.pageErrors = [{ url: "/x", message: "e" }];
  assert.equal(summarizeAudit(errored).ok, false);
});

test("summarizeAudit：结构不对时抛错而不是当作通过", () => {
  assert.throws(() => summarizeAudit({}), /无法汇总/);
  assert.throws(() => summarizeAudit({ checks: [], snapshots: "x" }), /无法汇总/);
  assert.throws(() => summarizeAudit(null), /无法汇总/);
});

test("formatSummary：首行带各项计数，问题明细逐条缩进列出", () => {
  const audit = clean();
  audit.checks.push({ label: "b", passed: false, error: "第一行\n第二行" });
  audit.snapshots[0].findings = [{ kind: "page-overflow", target: "document/body" }];
  audit.pageErrors = [{ url: "/x", message: "e" }];
  const lines = formatSummary(summarizeAudit(audit));
  assert.match(lines[0], /375px.*检查 2 失败 1.*findings 1.*pageerror 1.*切块 2/);
  assert.ok(lines.some((l) => l.includes("✗ 场景 b: 第一行") && !l.includes("第二行")));
  assert.ok(lines.some((l) => l.includes("[a] page-overflow: document/body")));
  assert.ok(lines.some((l) => l.includes("pageerror /x: e")));
});

test("collectAuditFiles：递归找到全部 layout-audit.json 且忽略其他文件", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "audit-"));
  try {
    mkdirSync(path.join(dir, "b", "deep"), { recursive: true });
    mkdirSync(path.join(dir, "a"));
    writeFileSync(path.join(dir, "b", "deep", "layout-audit.json"), "{}");
    writeFileSync(path.join(dir, "a", "layout-audit.json"), "{}");
    writeFileSync(path.join(dir, "a", "other.json"), "{}");
    const got = collectAuditFiles(dir).map((f) => path.relative(dir, f));
    assert.deepEqual(got, [
      path.join("a", "layout-audit.json"),
      path.join("b", "deep", "layout-audit.json"),
    ]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
