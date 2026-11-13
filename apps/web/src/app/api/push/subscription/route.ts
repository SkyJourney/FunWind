import { NextResponse } from "next/server";
import { z } from "zod";
import { preferenceGuard } from "@/lib/net/preference-guard";
import { subscribePush, unsubscribePush } from "@/lib/push/subscriptions";

/**
 * Web Push 订阅凭据 API（M18 Step 3）：POST 订阅 / DELETE 退订。
 * 门口链复用 preferenceGuard（同源 → 会话鉴权 → zod 结构校验 → 共享偏好频控）。
 * 只调 lib/push 服务层，不直 import @funwind/db（免触 architecture-guard）。
 * 订阅凭据（endpoint/p256dh/auth）是设备资源，独立于「渠道×类型×布尔」偏好，故走专用路由。
 */

const subscribeSchema = z.object({
  endpoint: z.string().url().max(500),
  p256dh: z.string().min(1).max(255),
  auth: z.string().min(1).max(255),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url().max(500),
});

export async function POST(request: Request): Promise<Response> {
  return preferenceGuard(request, subscribeSchema, async (user, body) => {
    await subscribePush(user.id, body);
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(request: Request): Promise<Response> {
  return preferenceGuard(request, unsubscribeSchema, async (user, body) => {
    await unsubscribePush(user.id, body.endpoint);
    return NextResponse.json({ ok: true });
  });
}
