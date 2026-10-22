import 'dotenv/config';

export const config = {
  oldDb: {
    host: process.env.OLD_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.OLD_DB_PORT ?? 33620),
    user: process.env.OLD_DB_USER ?? 'root',
    password: process.env.OLD_DB_PASSWORD ?? '',
    database: process.env.OLD_DB_NAME ?? 'qingyisub',
  },
  newDb: {
    host: process.env.NEW_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.NEW_DB_PORT ?? 33621),
    user: process.env.NEW_DB_USER ?? 'root',
    password: process.env.NEW_DB_PASSWORD ?? '',
    database: process.env.NEW_DB_NAME ?? 'qysub_next',
  },
  attachmentDir: process.env.ATTACHMENT_DIR
    ?? '/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment',
  // 新系统静态路由约定：/attachment/** → 旧附件目录；/emotion/** → 旧站 res/images/emotion
  batchSize: Number(process.env.BATCH_SIZE ?? 2000),
};

/** unix 秒 → 北京时间墙面 DATETIME（与旧站 FROM_UNIXTIME 显示一致） */
export function toDatetime(unix: number | null | undefined): string | null {
  if (!unix || unix <= 0) return null;
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  // 固定 +8（历史数据无夏令时语义）
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
