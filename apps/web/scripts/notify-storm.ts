/**
 * notify-storm —— 通知压力脚本（M8 验收门禁 1）：1,000 个互动事件 → 抽样断言不丢单。
 *
 * 用法：NEW_DB_NAME=qysub_next_e2e pnpm --filter @funwind/web notify:storm
 * 只允许 E2E 库（与 perf-posting 同守卫）；直接驱动 notify() 管线（聚合/偏好/写库），
 * 每类事件抽样核对 notifications 行（聚合类型核对 count 与行数）。
 */
import { and, eq, sql } from "drizzle-orm";
import { getWebDb, notifications } from "@funwind/db";
import { notify } from "../src/lib/notifications/notify";
import "../src/modules"; // 模块注册表求值（notificationTypes 声明）

const ACTOR = 90006; // team
const VICTIM = 90005; // member（收件人）

async function main() {
  if (process.env.NEW_DB_NAME !== "qysub_next_e2e") {
    console.error("只允许在 qysub_next_e2e 上运行（NEW_DB_NAME 守卫）");
    process.exit(2);
  }
  const db = getWebDb();

  // 清场：受影响类型的旧通知
  await db.delete(notifications).where(eq(notifications.userId, VICTIM));

  const N = 1000;
  const t0 = Date.now();

  // 混合事件：400 聚合（post.liked 同键）+ 400 聚合（post.replied 同键）+ 200 非聚合（post.mentioned）
  for (let i = 0; i < N; i++) {
    if (i < 400) {
      await notify({
        type: "post.liked",
        recipients: [VICTIM],
        actorId: ACTOR,
        targetType: "post",
        targetId: 800001,
        groupKey: "post:800001:liked",
        data: {},
      });
    } else if (i < 800) {
      await notify({
        type: "post.replied",
        recipients: [VICTIM],
        actorId: ACTOR,
        targetType: "thread",
        targetId: 800002,
        groupKey: "thread:800002:replied",
        data: { title: "风暴主题" },
      });
    } else {
      await notify({
        type: "post.mentioned",
        recipients: [VICTIM],
        actorId: ACTOR,
        targetType: "post",
        targetId: 800003,
        data: {},
      });
    }
  }
  const elapsed = Date.now() - t0;

  // 抽样断言：不丢单 = 聚合行 count 正确 + 非聚合行数正确
  const [liked] = await db
    .select({ data: notifications.data })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, VICTIM),
        eq(notifications.type, "post.liked"),
        sql`read_at IS NULL`,
      ),
    );
  const [replied] = await db
    .select({ data: notifications.data })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, VICTIM),
        eq(notifications.type, "post.replied"),
        sql`read_at IS NULL`,
      ),
    );
  const mentionedRows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, VICTIM), eq(notifications.type, "post.mentioned")));

  const likedCount = ((liked?.data ?? {}) as { count?: number }).count ?? 0;
  const repliedCount = ((replied?.data ?? {}) as { count?: number }).count ?? 0;

  const fails: string[] = [];
  if (likedCount !== 400) fails.push(`post.liked 聚合 count=${likedCount}（期望 400）`);
  if (repliedCount !== 400) fails.push(`post.replied 聚合 count=${repliedCount}（期望 400）`);
  if (mentionedRows.length !== 200)
    fails.push(`post.mentioned 行数=${mentionedRows.length}（期望 200）`);

  console.log(`事件 ${N} 个，耗时 ${elapsed}ms（均值 ${(elapsed / N).toFixed(1)}ms/事件）`);
  if (fails.length > 0) {
    console.error("抽样断言失败：", fails);
    process.exit(1);
  }
  console.log("通过：聚合 count 与非聚合行数全部对账（不丢单）");
  process.exit(0);
}

void main();
