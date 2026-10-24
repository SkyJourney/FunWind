// @vitest-environment node
/** 配置类管理动作（模块启停、站点设置）的审计：真实 MySQL 集成测试（临时库）。 */
import { eq } from "drizzle-orm";
import { auditLog, getWebDb } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRegisterMode, setSetting } from "@/lib/auth/settings";
import { registerModule } from "@/modules/kernel/registry";
import { getEnabledModuleIds, setModuleEnabled } from "@/modules/kernel/state";
import { defineModule } from "@/modules/kernel/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

let tdb: TempDb;
registerModule(defineModule({ id: "audit-probe", description: "测试：用于审计断言" }));

const audits = async (action: string) =>
  (await getWebDb().select().from(auditLog).where(eq(auditLog.action, action))).sort(
    (a, b) => a.id - b.id,
  );

describe.skipIf(skipDb)("配置类管理动作的审计", () => {
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  describe("setModuleEnabled", () => {
    it("停用 → 启用各写一条审计：前后状态、来源、行为人", async () => {
      await setModuleEnabled("audit-probe", false, { userId: 7, via: "admin", ip: "203.0.113.5" });
      await setModuleEnabled("audit-probe", true);
      expect((await getEnabledModuleIds()).has("audit-probe")).toBe(true);

      const [off] = await audits("module.disable");
      expect(off).toMatchObject({
        actorId: 7,
        targetType: "module",
        targetId: "audit-probe",
        ip: "203.0.113.5",
      });
      expect(off?.beforeJson).toEqual({ enabled: true });
      expect(off?.afterJson).toEqual({ enabled: false, via: "admin" });

      const [on] = await audits("module.enable");
      expect(on).toMatchObject({ actorId: null, targetId: "audit-probe" }); // 命令行：无登录用户
      expect(on?.beforeJson).toEqual({ enabled: false });
      expect(on?.afterJson).toEqual({ enabled: true, via: "cli" });
    });

    it("设为当前状态是幂等空操作：不写审计（含「没有记录=默认启用」时再次启用）", async () => {
      const before =
        (await audits("module.enable")).length + (await audits("module.disable")).length;
      await setModuleEnabled("audit-probe", true);
      await setModuleEnabled("never-touched-module", true);
      const after =
        (await audits("module.enable")).length + (await audits("module.disable")).length;
      expect(after).toBe(before);
    });

    it("停用后 getEnabledModuleIds 反映真实状态", async () => {
      await setModuleEnabled("audit-probe", false, { userId: null, via: "dev-api" });
      expect((await getEnabledModuleIds()).has("audit-probe")).toBe(false);
      const last = (await audits("module.disable")).at(-1);
      expect(last?.afterJson).toEqual({ enabled: false, via: "dev-api" });
      await setModuleEnabled("audit-probe", true);
    });
  });

  describe("setSetting", () => {
    it("首次写入 before 为空；修改写前后值；写相同值不审计", async () => {
      await setSetting("register.mode", { mode: "open" }, { userId: 9, via: "admin" });
      expect(await getRegisterMode()).toBe("open");
      await setSetting("register.mode", { mode: "invite" }, { userId: 9, via: "admin" });
      await setSetting("register.mode", { mode: "invite" }, { userId: 9, via: "admin" }); // 相同值

      const rows = (await audits("setting.update")).filter((r) => r.targetId === "register.mode");
      // 种子已写入默认 {mode:"invite"}，所以第一次是 invite→open，第二次是 open→invite，第三次空操作
      expect(rows).toHaveLength(2);
      expect(rows[0]?.beforeJson).toEqual({ value: { mode: "invite" } });
      expect(rows[0]?.afterJson).toEqual({ value: { mode: "open" }, via: "admin" });
      expect(rows[1]?.beforeJson).toEqual({ value: { mode: "open" } });
      expect(rows[1]?.actorId).toBe(9);
      expect(await getRegisterMode()).toBe("invite");
    });

    it("全新的键：before 为 null", async () => {
      await setSetting("points.gate_fee_rate_probe", { rate: 0.1 });
      const [r] = (await audits("setting.update")).filter(
        (x) => x.targetId === "points.gate_fee_rate_probe",
      );
      expect(r?.beforeJson).toBeNull();
      expect(r?.afterJson).toEqual({ value: { rate: 0.1 }, via: "cli" });
    });
  });
});
