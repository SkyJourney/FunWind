import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INSTALL_LOCK_FILE, isInstalled, removeInstallLock, writeInstallLock } from "./lock";

/** 每个用例独立的临时 STORAGE_DIR（lock 函数接受显式 env，不碰进程全局） */
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const freshEnv = () => {
  dir = mkdtempSync(path.join(tmpdir(), "funwind-install-lock-"));
  return { STORAGE_DIR: dir };
};

describe("安装锁（M12 D1：STORAGE_DIR/install.lock）", () => {
  it("未安装：STORAGE_DIR 存在但无锁文件 → false", async () => {
    expect(await isInstalled(freshEnv())).toBe(false);
  });

  it("STORAGE_DIR 不存在也算未安装（ENOENT）", async () => {
    const env = { STORAGE_DIR: path.join(dir ?? tmpdir(), "不存在的父目录", "install-dir") };
    dir = "";
    expect(await isInstalled(env)).toBe(false);
  });

  it("writeInstallLock 自动创建父目录、写入 JSON（version + installedAt），读回为已安装", async () => {
    const env = freshEnv();
    const nested = path.join(env.STORAGE_DIR, "data", "storage");
    const nestedEnv = { STORAGE_DIR: nested };
    await writeInstallLock({ installedAt: "2026-11-07T12:00:00.000Z" }, nestedEnv);
    const raw = readFileSync(path.join(nested, INSTALL_LOCK_FILE), "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1, installedAt: "2026-11-07T12:00:00.000Z" });
    expect(await isInstalled(nestedEnv)).toBe(true);
  });

  it("fail-closed：install.lock 被目录占位（读取异常）→ 按已安装处理", async () => {
    const env = freshEnv();
    mkdirSync(path.join(env.STORAGE_DIR, INSTALL_LOCK_FILE));
    expect(await isInstalled(env)).toBe(true);
  });

  it("removeInstallLock：存在则删除并返回 true；不存在返回 false", async () => {
    const env = freshEnv();
    expect(await removeInstallLock(env)).toBe(false);
    await writeInstallLock({ installedAt: "x" }, env);
    expect(await removeInstallLock(env)).toBe(true);
    expect(await isInstalled(env)).toBe(false);
  });
});
