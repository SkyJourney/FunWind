/**
 * recount 纯函数单测（不连库）：报告格式与 db:recount --check 的退出码语义。
 * 真实重算的行为由 recount.int.test.ts 在临时库上验证。
 */
import { describe, expect, it } from "vitest";
import {
  formatRecountReport,
  recountDriftTotal,
  recountExitCode,
  type RecountReport,
} from "./recount.js";

const clean = (dryRun: boolean): RecountReport => ({
  dryRun,
  tables: [
    { table: "threads", rows: 0, created: 0, byColumn: { reply_count: 0, last_post_id: 0 } },
    { table: "user_stats", rows: 0, created: 0, byColumn: { thread_count: 0 } },
  ],
});

const drifted = (dryRun: boolean): RecountReport => ({
  dryRun,
  tables: [
    { table: "threads", rows: 2, created: 0, byColumn: { reply_count: 2, last_post_id: 0 } },
    { table: "user_stats", rows: 1, created: 1, byColumn: { thread_count: 1 } },
  ],
});

describe("recountDriftTotal", () => {
  it("合计各表修正行数与新建行数；无漂移为 0", () => {
    expect(recountDriftTotal(clean(true))).toBe(0);
    expect(recountDriftTotal(drifted(true))).toBe(4);
  });
});

describe("recountExitCode：--check 有漂移非零，其余为零", () => {
  it("干跑无漂移 → 0", () => {
    expect(recountExitCode(clean(true))).toBe(0);
  });
  it("干跑有漂移 → 1（供 CI / 巡检判定）", () => {
    expect(recountExitCode(drifted(true))).toBe(1);
  });
  it("真实执行即使修正了数据也返回 0：修正本身就是目的，下一次会得到 0", () => {
    expect(recountExitCode(drifted(false))).toBe(0);
    expect(recountExitCode(clean(false))).toBe(0);
  });
});

describe("formatRecountReport", () => {
  it("干跑用「将修正」措辞并注明已回滚；真实执行用「已修正」", () => {
    expect(formatRecountReport(drifted(true))[0]).toBe("计数检查（只读，已回滚）：漂移合计 4 行");
    expect(formatRecountReport(drifted(false))[0]).toBe("计数重算：已修正合计 4 行");
    expect(formatRecountReport(drifted(true))[1]).toContain("将修正 2 行");
    expect(formatRecountReport(drifted(false))[1]).toContain("已修正 2 行");
  });

  it("只列出有变化的列；新建行单独标注", () => {
    const lines = formatRecountReport(drifted(true));
    expect(lines[1]).toBe("  threads     将修正 2 行（reply_count 2）");
    expect(lines[2]).toBe("  user_stats  新建 1 行，将修正 1 行（thread_count 1）");
  });

  it("无漂移时各表都是 0 行、没有明细括号", () => {
    const lines = formatRecountReport(clean(true));
    expect(lines[0]).toBe("计数检查（只读，已回滚）：漂移合计 0 行");
    expect(lines.slice(1).every((l) => !l.includes("（"))).toBe(true);
  });
});
