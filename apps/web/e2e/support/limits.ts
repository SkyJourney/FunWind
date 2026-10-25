import { withE2eDb } from "./db";

/** 会员角色（member）可被用例临时覆盖的限额字段（与 lib/limits 的 roleLimitsSchema 同名） */
export type MemberLimitPatch = Partial<{
  postIntervalSec: number;
  threadsPerDay: number;
  uploadsPerDay: number;
}>;

/**
 * 临时覆盖会员角色的限额：读出当前 site_settings.limits，合并补丁后写回，返回还原函数。
 * 限制配置每次请求都从库里读取（不做进程内缓存），所以改库即刻生效。
 * 调用方必须在 finally（或 afterAll）里执行还原；用例串行执行（playwright workers: 1），改动不会泄露给并行用例。
 */
export async function patchMemberLimits(patch: MemberLimitPatch): Promise<() => Promise<void>> {
  const rows = await withE2eDb((q) =>
    q.query<{ value: unknown }>("SELECT value FROM site_settings WHERE `key` = 'limits'"),
  );
  const original = rows[0]?.value;
  const current = (typeof original === "string" ? JSON.parse(original) : original) as {
    roles: Record<string, Record<string, unknown>>;
  };
  const patched = {
    ...current,
    roles: {
      ...current.roles,
      member: { ...current.roles.member, ...patch },
    },
  };
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('limits', ?, NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()",
      [JSON.stringify(patched)],
    ),
  );
  return async () => {
    await withE2eDb((q) =>
      q.exec("UPDATE site_settings SET value = ?, updated_at = NOW() WHERE `key` = 'limits'", [
        JSON.stringify(current),
      ]),
    );
  };
}

/**
 * 临时关掉会员的发帖间隔（默认 5 秒）：流程类用例要在同一个作者身上连续发帖。
 * 返回的函数把 site_settings.limits 还原成调用前的值；调用方必须在 afterAll 里执行。
 */
export function relaxPostInterval(): Promise<() => Promise<void>> {
  return patchMemberLimits({ postIntervalSec: 0 });
}

/** 某用户今天（北京日，与服务端 CURDATE() 同口径）已发布的主题数 */
export async function todayThreadCount(userId: number): Promise<number> {
  const rows = await withE2eDb((q) =>
    q.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM threads WHERE author_id = ? AND created_at >= CURDATE()",
      [userId],
    ),
  );
  return Number(rows[0]?.n ?? 0);
}

/** 某用户今天（北京日）已上传的文件数（file_uploads 行数，去重命中也计入） */
export async function todayUploadCount(userId: number): Promise<number> {
  const rows = await withE2eDb((q) =>
    q.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM file_uploads WHERE user_id = ? AND created_at >= CURDATE()",
      [userId],
    ),
  );
  return Number(rows[0]?.n ?? 0);
}
