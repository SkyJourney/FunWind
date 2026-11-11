import "server-only";

import { eq } from "drizzle-orm";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { getWebDb, siteSettings, users } from "@funwind/db";
import { getStorageDir } from "@/lib/storage";

/**
 * 安装进度与环境自检（M12 Step 3）：向导第一步的展示数据。
 * 进度从**数据库状态**推导（表可查 = 建库+bootstrap 完成；register.policy 存在 = 设置完成；
 * users 非空 = 管理员完成）——不另存状态机表，重启 / 换实例读到的是同一份事实，
 * 与管线的幂等重跑语义一致（中断后重跑收敛）。
 */

export const REQUIRED_NODE_MAJOR = 24;

export interface InstallProgress {
  /** 建库 + bootstrap 完成（users 表可查询） */
  dbReady: boolean;
  /** 站点设置完成（register.policy 键存在） */
  siteConfigured: boolean;
  /** 管理员已创建（users 非空） */
  adminCreated: boolean;
}

export async function installProgress(): Promise<InstallProgress> {
  const progress: InstallProgress = { dbReady: false, siteConfigured: false, adminCreated: false };
  try {
    const [row] = await getWebDb().select({ n: users.id }).from(users).limit(1);
    progress.dbReady = true;
    progress.adminCreated = row !== undefined;
  } catch {
    return progress; // 表不存在：dbReady=false，后续检查无从谈起
  }
  try {
    const [setting] = await getWebDb()
      .select({ key: siteSettings.key })
      .from(siteSettings)
      .where(eq(siteSettings.key, "register.policy"))
      .limit(1);
    progress.siteConfigured = setting !== undefined;
  } catch {
    progress.siteConfigured = false;
  }
  return progress;
}

/** 由进度推导向导应处的步骤（1 数据库 → 2 站点 → 3 管理员 → 4 完成） */
export function stepOfProgress(progress: InstallProgress): 1 | 2 | 3 | 4 {
  if (progress.adminCreated) return 4;
  if (progress.siteConfigured) return 3;
  if (progress.dbReady) return 2;
  return 1;
}

/** Node 主版本 ≥ REQUIRED_NODE_MAJOR（engines: node >=24） */
export function nodeVersionOk(userAgent = process.version): boolean {
  const major = Number(/^v(\d+)/.exec(userAgent)?.[1] ?? 0);
  return major >= REQUIRED_NODE_MAJOR;
}

/** STORAGE_DIR 可写探针：写入 → 删除一个随机临时文件（向导展示用，不作为门禁） */
export async function storageWritable(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  // 探针放 .tmp/ 子目录：容器 HEALTHCHECK 每 30s 调一次本函数，若写顶层会把顶层 mtime
  // 每 30s 重置一次，与运维管线的 tar 归档竞争（管线对源目录 --exclude=.tmp，M14 教训）
  const tmpDir = path.join(getStorageDir(env), ".tmp");
  const probe = path.join(tmpDir, `.install-probe-${randomBytes(4).toString("hex")}`);
  try {
    await mkdir(tmpDir, { recursive: true }); // .tmp 不存在则创建；只读/无权限在此失败
    await writeFile(probe, "probe"); // 目录不存在（ENOENT）或无权限都会失败
    // 写成功即判可写；清理失败（unlink）不影响结论，best-effort 删除（审查 F-7）
    await unlink(probe).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
