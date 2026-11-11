import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeVersionOk, storageWritable, stepOfProgress, REQUIRED_NODE_MAJOR } from "./progress";

describe("环境自检与进度推导（M12 Step 3）", () => {
  it("nodeVersionOk：主版本 ≥ 24 通过，低于拒绝，畸形输入拒绝", () => {
    expect(nodeVersionOk("v24.15.0")).toBe(true);
    expect(nodeVersionOk("v25.1.2")).toBe(true);
    expect(nodeVersionOk("v22.11.0")).toBe(false);
    expect(nodeVersionOk("v18.0.0")).toBe(false);
    expect(nodeVersionOk("诡")).toBe(false);
  });

  it("stepOfProgress：按最远完成段推导当前步", () => {
    const p = (dbReady: boolean, siteConfigured: boolean, adminCreated: boolean) => ({
      dbReady,
      siteConfigured,
      adminCreated,
    });
    expect(stepOfProgress(p(false, false, false))).toBe(1);
    expect(stepOfProgress(p(true, false, false))).toBe(2);
    expect(stepOfProgress(p(true, true, false))).toBe(3);
    expect(stepOfProgress(p(true, true, true))).toBe(4);
  });

  describe("storageWritable", () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = "";
    });

    it("已存在的目录可写 → true（探针写入 .tmp/ 并清理，不触碰顶层）", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "funwind-storage-ok-"));
      expect(await storageWritable({ STORAGE_DIR: dir })).toBe(true);
      // 顶层 mtime 必须保持原样：容器 HEALTHCHECK 每 30s 调一次本函数，
      // 若探针写顶层会与运维管线 tar 归档竞争（M14 教训，管线对 .tmp/ 已排除）
      const before = statSync(dir).mtimeMs;
      await storageWritable({ STORAGE_DIR: dir });
      expect(statSync(dir).mtimeMs).toBe(before);
      expect(readdirSync(dir)).toEqual([".tmp"]);
    });

    it("父目录不存在（ENOENT）→ false；权限与磁盘故障同口径 fail-false", async () => {
      // /proc 这类只读伪文件系统下建目录/写文件必然失败，跨平台稳定
      const env = { STORAGE_DIR: "/proc/funwind-denied/install-storage" };
      expect(await storageWritable(env)).toBe(false);
    });
  });

  it("REQUIRED_NODE_MAJOR 与 engines 对齐（24）", () => {
    expect(REQUIRED_NODE_MAJOR).toBe(24);
  });
});
