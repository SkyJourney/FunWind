import { join } from "node:path";
import { loadRootEnv, repoRoot } from "@funwind/db";

const env = loadRootEnv();

export const config = {
  oldDb: {
    host: env.OLD_DB_HOST ?? "127.0.0.1",
    port: Number(env.OLD_DB_PORT ?? 33620),
    user: env.OLD_DB_USER ?? "root",
    password: env.OLD_DB_PASSWORD ?? "",
    database: env.OLD_DB_NAME ?? "qingyisub",
  },
  newDb: {
    host: env.NEW_DB_HOST ?? "127.0.0.1",
    port: Number(env.NEW_DB_PORT ?? 33621),
    user: env.NEW_DB_USER ?? "root",
    password: env.NEW_DB_PASSWORD ?? "",
    database: env.NEW_DB_NAME ?? "qysub_next",
  },
  attachmentDir:
    env.ATTACHMENT_DIR ?? "/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment",
  emotionDir:
    env.EMOTION_DIR ??
    "/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/res/images/emotion",
  /** 对账报告输出目录（入库，便于评审与留档） */
  reportDir: join(repoRoot, "docs/reports"),
  /** 含个人信息（完整邮箱等）的待办清单：写入已被 .gitignore 的目录，绝不入库 */
  privateReportDir: join(repoRoot, "migration/reports"),
  /** 勋章图所在目录（medal_info.image 的相对路径基准） */
  medalDir:
    env.MEDAL_DIR ?? "/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/res/images/medal",
  /** 新存储根目录：文件按内容哈希寻址写入此处（`ab/cd/<sha256>.<ext>`），可整体平移到对象存储 */
  storageDir: env.STORAGE_DIR ?? join(repoRoot, "storage"),
  /** 表情静态资源落点（随应用发布） */
  emojiOutDir: join(repoRoot, "apps/web/public/emoji"),
  batchSize: Number(env.BATCH_SIZE ?? 2000),
};

/**
 * 迁移基准时间：「现在」的固定值。
 * 过期判断（封禁/附加组到期）与默认时间戳都用它，保证重跑结果完全一致（幂等），
 * 而不是随运行时刻漂移。
 */
export const AS_OF = env.MIGRATION_AS_OF ?? "2026-10-23 00:00:00";

/** unix 秒 → 北京时间墙面 DATETIME（与旧站 FROM_UNIXTIME 显示一致） */
export function toDatetime(unix: number | null | undefined): string | null {
  if (!unix || unix <= 0) return null;
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  // 固定 +8（历史数据无夏令时语义）
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
  );
}
