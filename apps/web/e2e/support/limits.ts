import { withE2eDb } from "./db";

/**
 * 临时关掉会员的发帖间隔（默认 5 秒）：流程类用例要在同一个作者身上连续发帖。
 * 返回的函数把 site_settings.limits 还原成调用前的值；调用方必须在 afterAll 里执行。
 * 限制配置每次请求都从库里读取（不做进程内缓存），所以改库即刻生效。
 */
export async function relaxPostInterval(): Promise<() => Promise<void>> {
  const rows = await withE2eDb((q) =>
    q.query<{ value: unknown }>("SELECT value FROM site_settings WHERE `key` = 'limits'"),
  );
  const original = rows[0]?.value;
  const current = (typeof original === "string" ? JSON.parse(original) : original) as {
    roles: Record<string, Record<string, unknown>>;
  };
  const relaxed = {
    ...current,
    roles: {
      ...current.roles,
      member: { ...current.roles.member, postIntervalSec: 0 },
    },
  };
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO site_settings (`key`, value, updated_at) VALUES ('limits', ?, NOW()) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()",
      [JSON.stringify(relaxed)],
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
