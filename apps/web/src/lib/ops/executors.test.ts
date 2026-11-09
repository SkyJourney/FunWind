import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findOpsExecutor,
  OPS_EXECUTORS,
  validateCron,
  validateOnce,
  validateOpsParams,
  validateTaskKey,
  validateTrigger,
} from "./executors";

/**
 * 双端契约（M14 Step 2）：web 侧判定必须与共享夹具一致——管线 tests/test_contract_fixture.py 读同一份，
 * 两端都对上夹具，即两端彼此一致。另解析管线注册表源码，执行器清单漂移直接变红。
 */
const SERVICE = join(import.meta.dirname, "../../../../../services/backup");
const fixture = JSON.parse(
  readFileSync(join(SERVICE, "tests/fixtures/ops-contract.json"), "utf8"),
) as {
  executors: string[];
  params: { executor: string; params: unknown; valid: boolean }[];
  cron: { expr: string; valid: boolean }[];
  once: { expr: string; valid: boolean }[];
};

describe("双端契约夹具", () => {
  it("执行器清单与夹具、管线注册表源码三方一致", () => {
    const pipelineSource = readFileSync(join(SERVICE, "app/executors.py"), "utf8");
    const pipelineKeys = [...pipelineSource.matchAll(/ExecutorSpec\("([^"]+)"/g)].map((m) => m[1]);
    const webKeys = OPS_EXECUTORS.map((executor) => executor.key);
    expect(webKeys.sort()).toEqual([...fixture.executors].sort());
    expect(pipelineKeys.sort()).toEqual([...fixture.executors].sort());
  });

  it.each(fixture.params)("参数 $executor $params → $valid", ({ executor, params, valid }) => {
    expect(validateOpsParams(executor, params).ok).toBe(valid);
  });

  it.each(fixture.cron)("cron %j", ({ expr, valid }) => {
    expect(validateCron(expr).ok).toBe(valid);
  });

  it.each(fixture.once)("单次时刻 %j", ({ expr, valid }) => {
    expect(validateOnce(expr).ok).toBe(valid);
  });

  it("夹具本身覆盖了正反两面（防止夹具被误删成一边倒而假绿）", () => {
    for (const group of [fixture.params, fixture.cron, fixture.once]) {
      expect(group.some((c) => c.valid)).toBe(true);
      expect(group.some((c) => !c.valid)).toBe(true);
    }
  });
});

describe("规范化与提示", () => {
  it("cron 折叠空白并转小写；星期写数字给出错位说明", () => {
    expect(validateCron("  0  2 * *   FRI ")).toEqual({ ok: true, value: "0 2 * * fri" });
    const numeric = validateCron("0 2 * * 5");
    expect(numeric.ok).toBe(false);
    expect(!numeric.ok && numeric.message).toContain("会错位一天");
    const badHour = validateCron("0 24 * * *");
    expect(!badHour.ok && badHour.message).toContain("时字段");
  });

  it("参数规范化：null 的可选项去掉；未知执行器与非法值给出说明", () => {
    expect(validateOpsParams("backup.db", { keep: null })).toEqual({ ok: true, value: {} });
    expect(validateOpsParams("backup.db", { keep: 5 })).toEqual({ ok: true, value: { keep: 5 } });
    const unknown = validateOpsParams("rm.rf", {});
    expect(!unknown.ok && unknown.message).toContain("未注册的执行器");
    const tooMany = validateOpsParams("backup.db", { keep: 91 });
    expect(!tooMany.ok && tooMany.message).toContain("keep");
  });

  it("触发器：manual 的表达式恒为 null；未知类型拒绝；once 去掉首尾空白", () => {
    expect(validateTrigger("manual", "whatever")).toEqual({
      ok: true,
      value: { kind: "manual", expr: null },
    });
    expect(validateTrigger("hourly", "0 * * * *").ok).toBe(false);
    expect(validateTrigger("once", " 2027-02-16 00:00:00 ")).toEqual({
      ok: true,
      value: { kind: "once", expr: "2027-02-16 00:00:00" },
    });
    expect(validateTrigger("cron", null).ok).toBe(false);
  });

  it.each([
    ["backup.db", true],
    ["campaign.holiday", true],
    ["a", false],
    ["Backup.db", false],
    ["-x", false],
    ["x".repeat(65), false],
    ["back up", false],
  ])("任务键 %s → %s", (key, valid) => {
    expect(validateTaskKey(key).ok).toBe(valid);
  });

  it("按键查执行器", () => {
    expect(findOpsExecutor("backup.storage")?.label).toBe("存储备份");
    expect(findOpsExecutor("nope")).toBeNull();
  });
});
