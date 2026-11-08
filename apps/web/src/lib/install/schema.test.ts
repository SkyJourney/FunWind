import { BUILTIN_THEME_PACK_SEEDS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { INSTALL_THEME_PACKS, installConfigFromEnv, validateInstallConfig } from "./schema";

/** 一份结构合法的基础配置（db 五项来自运行环境，必然与环境一致） */
const validRaw = () => ({
  db: installConfigFromEnv().db,
  site: { name: "青翼字幕组", tagline: "日语·ACG 情怀社区", url: "https://qingyisub.top" },
  themePack: "default" as const,
  registration: { mode: "open", verifyEmail: true },
  admin: { username: "inst_admin", email: "admin@example.com", password: "install-pass-123" },
});

describe("安装配置校验（M12）", () => {
  it("合法配置通过，值原样保留", () => {
    const r = validateInstallConfig(validRaw());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.themePack).toBe("default");
      expect(r.value.registration).toEqual({ mode: "open", verifyEmail: true });
      expect(r.value.db).toEqual(installConfigFromEnv().db);
    }
  });

  it("INSTALL_THEME_PACKS 与内置主题包种子同步（哨兵）", () => {
    expect([...INSTALL_THEME_PACKS].sort()).toEqual(
      BUILTIN_THEME_PACK_SEEDS.map((seed) => seed.id).sort(),
    );
  });

  it("库名白名单：字母数字下划线之外拒绝（CREATE DATABASE 拼接安全）", () => {
    for (const bad of ["a-b", "a.b", "a b", "", "`drop`"]) {
      const r = validateInstallConfig({
        ...validRaw(),
        db: { ...installConfigFromEnv().db, name: bad },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues["db.name"]).toBeTruthy();
    }
  });

  it("管理员语义校验：用户名规则（checkUsername）/ 邮箱格式 / 密码长度", () => {
    const r = validateInstallConfig({
      ...validRaw(),
      admin: { username: "", email: "not-an-email", password: "短" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues["admin.username"]).toBeTruthy();
      expect(r.issues["admin.email"]).toBe("邮箱格式不正确");
      expect(r.issues["admin.password"]).toBe("密码至少 8 位");
    }
  });

  it("db 连接信息与运行环境不一致 → 单独的 db 问题（运行中的实例不能换库）", () => {
    const raw = { ...validRaw(), db: { ...installConfigFromEnv().db, host: "10.9.9.9" } };
    const r = validateInstallConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues["db"]).toContain("环境变量不一致");
  });

  it("registration 只认三种模式（discriminated union，多余字段拒绝）", () => {
    for (const bad of [{ mode: "read-only" }, { mode: "open", verifyEmail: true, extra: 1 }, {}]) {
      const r = validateInstallConfig({ ...validRaw(), registration: bad });
      expect(r.ok).toBe(false);
    }
  });

  it("strict：未知顶层字段拒绝", () => {
    const r = validateInstallConfig({ ...validRaw(), extra: true });
    expect(r.ok).toBe(false);
  });

  it("installConfigFromEnv：db 来自运行环境，站点身份/注册模式有默认值", () => {
    const config = installConfigFromEnv();
    expect(config.db.name).toBeTruthy();
    expect(config.db.port).toBeGreaterThan(0);
    expect(config.site.name.length).toBeGreaterThan(0);
    expect(config.registration).toEqual({ mode: "invite" });
    // db 部分与运行环境一致即整体通过（默认 admin 留空由表单/CLI 填写，不参与本断言）
    const r = validateInstallConfig({
      ...config,
      admin: { username: "inst_admin", email: "i@example.com", password: "install-pass-123" },
    });
    expect(r.ok).toBe(true);
  });
});
