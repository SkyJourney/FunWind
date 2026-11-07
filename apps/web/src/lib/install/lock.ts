import "server-only";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageDir } from "@/lib/storage";

/**
 * 安装锁（M12 D1）：`STORAGE_DIR/install.lock` 文件。
 *  · 读取异常（权限等）一律按「已安装」处理——fail-closed 保护已装站点，绝不因 IO 故障重开安装入口；
 *  · 锁随 STORAGE_DIR 走：部署平移数据目录即平移安装状态；E2E 每轮清空专用 STORAGE_DIR，天然获得「未安装」起点；
 *  · 删除锁仅限 CLI 的 `--unlock`（交互确认后调用 removeInstallLock），向导永远不删。
 */

export const INSTALL_LOCK_FILE = "install.lock";

/** 锁文件内容版本：管线演进时据此识别旧锁；当前只用于人工诊断，读取逻辑不解析 */
const LOCK_CONTENT_VERSION = 1;

function lockPath(env: Record<string, string | undefined>): string {
  return path.join(getStorageDir(env), INSTALL_LOCK_FILE);
}

/** 站点是否已完成安装。ENOENT = 未安装；其余读取异常按已安装（fail-closed，D1） */
export async function isInstalled(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  try {
    await readFile(lockPath(env), "utf8");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // 读到的是目录、权限被拒、磁盘故障……都按「已安装」处理：宁可让站长走 CLI，也不重开安装入口
    console.error(`[install] 读取安装锁失败，按已安装处理（fail-closed）:`, e);
    return true;
  }
}

/** 写入安装锁（父目录不存在自动创建）。内容是给人看的诊断信息，读取逻辑只判存在性 */
export async function writeInstallLock(
  meta: { installedAt: string },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const dir = getStorageDir(env);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, INSTALL_LOCK_FILE),
    `${JSON.stringify({ version: LOCK_CONTENT_VERSION, ...meta }, null, 2)}\n`,
    "utf8",
  );
}

/** 删除安装锁——仅限 CLI 的 `--unlock`（交互确认后）调用。返回此前是否存在锁 */
export async function removeInstallLock(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const existed = await isInstalled(env);
  if (!existed) return false;
  await rm(lockPath(env));
  return true;
}
