import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getWebDb, pushSubscriptions } from "@funwind/db";
import type { PushSubscriptionKeys } from "./types";

/**
 * Web Push 订阅凭据管理（M18 Step 3）：供 /api/push/subscription 路由调用，
 * 路由不直 import @funwind/db（免触 architecture-guard 的 DATABASE_ENTRIES）。
 */

/**
 * 订阅：按 endpoint upsert。endpoint 全局唯一（推送服务侧标识一个订阅）——
 * 同 endpoint 重订归到当前用户（换账号/换设备共用浏览器订阅时覆盖归属），密钥随之更新。
 */
export async function subscribePush(userId: number, keys: PushSubscriptionKeys): Promise<void> {
  await getWebDb()
    .insert(pushSubscriptions)
    .values({
      userId,
      endpoint: keys.endpoint.slice(0, 500),
      p256dh: keys.p256dh.slice(0, 255),
      auth: keys.auth.slice(0, 255),
      createdAt: sql`NOW()`,
    })
    .onDuplicateKeyUpdate({
      set: { userId, p256dh: keys.p256dh.slice(0, 255), auth: keys.auth.slice(0, 255) },
    });
}

/** 退订：按 endpoint + userId 删除（只能删自己的订阅，防越权删他人） */
export async function unsubscribePush(userId: number, endpoint: string): Promise<void> {
  await getWebDb()
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint.slice(0, 500)),
      ),
    );
}
