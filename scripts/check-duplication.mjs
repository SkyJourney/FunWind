#!/usr/bin/env node
/**
 * 重复代码门禁（棘轮基线）：jscpd 扫描仓库源码后与 scripts/duplication-baseline.json 比对，
 * 重复行数（duplicatedLines）与克隆数（clones）只能持平或下降，升高即失败。
 *
 * 设计要点：
 *   - 存量重复不清零：基线锚定当前状态，清理由代码审查驱动，基线随之逐步下压；
 *   - 刻意接受新增重复时运行 `pnpm duplication:baseline` 重新锚定——基线文件的 diff 会出现在
 *     提交里，不会被静默忽略；
 *   - 门禁判定不用 percentage：删除干净文件会让百分比机械上升但 duplicatedLines 不变，
 *     按行数/克隆数判定才不会误伤正常重构；percentage 仅在输出里展示；
 *   - 扫描范围与参数集中在根目录 .jscpd.json（仅 ts/tsx、排除测试），基线里记录 minTokens，
 *     参数变更会使旧基线失效，必须显式重建。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSCPD_BIN = path.join(ROOT, "node_modules", ".bin", "jscpd");
const REPORT_PATH = path.join(ROOT, "node_modules", ".cache", "jscpd", "jscpd-report.json");
const BASELINE_PATH = path.join(ROOT, "scripts", "duplication-baseline.json");
const SCAN_PATHS = ["apps/web/src", "packages/db/src", "packages/content/src", "migration/src"];

/** 从 jscpd 报告提取门禁指标；报告缺失或结构不对时抛错（宁可失败不可静默放行） */
export function extractMetrics(report) {
  const total = report?.statistics?.total;
  if (!total || typeof total.duplicatedLines !== "number" || typeof total.clones !== "number") {
    throw new Error("jscpd 报告缺少 statistics.total.duplicatedLines / clones，无法判定");
  }
  return {
    duplicatedLines: Math.round(total.duplicatedLines),
    clones: Math.round(total.clones),
    percentage: Math.round(total.percentage * 100) / 100,
    sources: Math.round(total.sources ?? 0),
  };
}

/** 棘轮比对：duplicatedLines / clones 必须都 ≤ 基线；基线字段缺失视为失败 */
export function compareWithBaseline(metrics, baseline) {
  if (!baseline || typeof baseline !== "object") {
    return {
      ok: false,
      reasons: ["基线文件缺失或不是对象，先运行 pnpm duplication:baseline 重建"],
    };
  }
  const reasons = [];
  for (const key of ["duplicatedLines", "clones"]) {
    if (typeof baseline[key] !== "number") {
      reasons.push(`基线缺少数值字段 ${key}`);
    } else if (metrics[key] > baseline[key]) {
      reasons.push(`${key} ${metrics[key]} > 基线 ${baseline[key]}（棘轮门禁只允许持平或下降）`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 基线与扫描参数的一致性：minTokens 变了旧基线就不再可比 */
export function baselineMismatch(baseline, config) {
  if (!baseline || typeof baseline !== "object") return ["基线缺失"];
  if (baseline.minTokens !== config.minTokens) {
    return [
      `基线 minTokens=${baseline.minTokens} 与当前配置 ${config.minTokens} 不一致，请重建基线`,
    ];
  }
  return [];
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function runJscpd() {
  if (!existsSync(JSCPD_BIN)) {
    console.error("✘ 未找到 node_modules/.bin/jscpd，先 pnpm install");
    process.exit(1);
  }
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  // jscpd 自身找到重复也会正常退出（阈值门禁由本脚本对照基线负责），这里只关心能产出报告
  execFileSync(JSCPD_BIN, [...SCAN_PATHS, "--silent"], { cwd: ROOT, stdio: "inherit" });
  if (!existsSync(REPORT_PATH)) {
    console.error("✘ jscpd 未产出报告文件，扫描可能失败");
    process.exit(1);
  }
}

function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  runJscpd();
  const metrics = extractMetrics(readJson(REPORT_PATH));
  const config = readJson(path.join(ROOT, ".jscpd.json"));

  if (updateBaseline) {
    const baseline = {
      updatedAt: new Date().toISOString().slice(0, 10),
      jscpdVersion: process.env.JSCPD_VERSION ?? "pinned-in-package.json",
      minTokens: config.minTokens,
      duplicatedLines: metrics.duplicatedLines,
      clones: metrics.clones,
      // 仅展示用途，不参与棘轮判定，见文件头说明
      percentageForReference: metrics.percentage,
      sources: metrics.sources,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `✔ 基线已重建：duplicatedLines=${baseline.duplicatedLines} clones=${baseline.clones}（percentage ${baseline.percentageForReference}%，仅展示）`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("✘ 缺少 scripts/duplication-baseline.json，先运行 pnpm duplication:baseline");
    process.exit(1);
  }
  const baseline = readJson(BASELINE_PATH);
  const mismatch = baselineMismatch(baseline, config);
  const { ok, reasons } = compareWithBaseline(metrics, baseline);

  console.log(
    `重复门禁：${metrics.sources} 个源文件，duplicatedLines=${metrics.duplicatedLines}（基线 ${baseline.duplicatedLines}），clones=${metrics.clones}（基线 ${baseline.clones}），percentage=${metrics.percentage}%（仅展示）`,
  );

  if (!ok || mismatch.length > 0) {
    for (const line of [...mismatch, ...reasons]) console.error(`✘ ${line}`);
    console.error(
      "处理：优先提取/复用消除新增重复；确需接受时运行 pnpm duplication:baseline 重新锚定并在提交说明里写明原因。",
    );
    process.exit(1);
  }
  console.log("✔ 重复度未超过棘轮基线");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
