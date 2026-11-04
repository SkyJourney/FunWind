#!/usr/bin/env node
/**
 * 布局审计汇总（目视验收配套，规程见 docs/VISUAL-VERIFICATION.md）。
 *
 * 为什么需要它：LAYOUT_AUDIT_ONLY=1 下用例永远「通过」，场景失败与几何 findings 只写进
 * layout-audit.json；只看 Playwright 的 ✓ 会漏掉全部问题（2026-11-04 目视验收中就踩过）。
 * 有任何场景失败 / 几何 finding / 页面异常时以非零码退出，可直接当门禁用。
 *
 * 用法：node scripts/layout-audit-summary.mjs [产物目录，默认 apps/web/test-results]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集目录下所有 layout-audit.json，按路径排序使输出稳定 */
export function collectAuditFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "layout-audit.json") found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * 汇总单份审计 JSON。checks / snapshots 不是数组时抛错：
 * 结构不对就无法判定，宁可失败也不静默放行。
 */
export function summarizeAudit(audit) {
  if (!Array.isArray(audit?.checks) || !Array.isArray(audit?.snapshots)) {
    throw new Error("layout-audit.json 缺少 checks / snapshots，无法汇总");
  }
  const failedChecks = audit.checks.filter((check) => !check.passed);
  const findings = audit.snapshots.flatMap((snapshot) =>
    (snapshot.findings ?? []).map((finding) => ({ label: snapshot.label, ...finding })),
  );
  const pageErrors = audit.pageErrors ?? [];
  const tiles = audit.snapshots.reduce((sum, snapshot) => sum + (snapshot.tiles?.length ?? 0), 0);
  return {
    width: audit.viewport?.width ?? null,
    test: audit.test ?? "",
    checks: audit.checks.length,
    failedChecks,
    findings,
    pageErrors,
    tiles,
    ok: failedChecks.length === 0 && findings.length === 0 && pageErrors.length === 0,
  };
}

/** 把一份汇总排成可读文本行；问题明细缩进列在其后 */
export function formatSummary(summary) {
  const head =
    `${String(summary.width ?? "?").padStart(5)}px  检查 ${summary.checks} ` +
    `失败 ${summary.failedChecks.length}  findings ${summary.findings.length}  ` +
    `pageerror ${summary.pageErrors.length}  切块 ${summary.tiles}`;
  const lines = [head];
  for (const check of summary.failedChecks) {
    lines.push(`        ✗ 场景 ${check.label}: ${String(check.error ?? "").split("\n")[0]}`);
  }
  for (const finding of summary.findings) {
    lines.push(`        ! [${finding.label}] ${finding.kind}: ${finding.target}`);
  }
  for (const error of summary.pageErrors) {
    lines.push(`        ⚠ pageerror ${error.url}: ${error.message}`);
  }
  return lines;
}

function main() {
  const dir = path.resolve(process.argv[2] ?? path.join(ROOT, "apps/web/test-results"));
  if (!existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exit(2);
  }
  const files = collectAuditFiles(dir);
  if (files.length === 0) {
    console.error(`没有找到 layout-audit.json：${dir}（空产物不能视为通过）`);
    process.exit(2);
  }
  const summaries = files
    .map((file) => summarizeAudit(JSON.parse(readFileSync(file, "utf8"))))
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  for (const summary of summaries) for (const line of formatSummary(summary)) console.log(line);
  const bad = summaries.filter((summary) => !summary.ok).length;
  console.log(`\n共 ${summaries.length} 份审计，${bad} 份有问题`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
