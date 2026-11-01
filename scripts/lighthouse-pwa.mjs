#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 本地 Lighthouse PWA 验收（M11 Step 7）；要求先启动 production server 并传入 URL。
 * Lighthouse 12 移除了 PWA 类别，固定用保留该类别的 11.7.1；不加项目依赖（pnpm dlx 临时获取）。
 * 用法：pnpm pwa:lighthouse http://127.0.0.1:3203
 */
const target = process.argv[2] ?? process.env.PWA_AUDIT_URL;
if (!target || !/^https?:\/\//.test(target)) {
  console.error("用法：pnpm pwa:lighthouse http://127.0.0.1:<生产端口>");
  process.exit(2);
}

const reportPath = join(tmpdir(), `funwind-pwa-lighthouse-${process.pid}.json`);
const result = spawnSync(
  "pnpm",
  [
    "dlx",
    "lighthouse@11.7.1",
    target,
    "--only-categories=pwa",
    "--output=json",
    `--output-path=${reportPath}`,
    "--chrome-flags=--headless --no-sandbox --disable-dev-shm-usage",
    "--quiet",
  ],
  { encoding: "utf8", stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const { readFileSync, rmSync } = await import("node:fs");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
rmSync(reportPath, { force: true });
const pwa = report.categories?.pwa;
if (!pwa) {
  console.error("Lighthouse 报告没有 PWA 类别；请确认使用 lighthouse@11.7.1。");
  process.exit(1);
}
console.log(`Lighthouse PWA 分数：${Math.round((pwa.score ?? 0) * 100)}/100`);

// Lighthouse 11.7 的 PWA 类别没有独立 service-worker/offline-start-url 审计：
// installable-manifest 已同时核对 manifest + SW；实际离线 fallback 由 e2e/pwa.spec.ts 断网验证。
const required = ["installable-manifest", "themed-omnibox", "maskable-icon", "splash-screen"];
let failed = false;
for (const id of required) {
  const audit = report.audits?.[id];
  const score = audit?.score;
  const status = score === 1 ? "通过" : score === null ? "不适用" : "未通过";
  console.log(
    `${status} · ${audit?.title ?? id}${audit?.displayValue ? `：${audit.displayValue}` : ""}`,
  );
  if (score !== 1) {
    failed = true;
    if (audit?.failureSummary) console.log(audit.failureSummary);
  }
}
if (failed) process.exit(1);
