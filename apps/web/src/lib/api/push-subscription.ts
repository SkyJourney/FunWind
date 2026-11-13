/**
 * Web Push 订阅 API 客户端封装（M18 Step 3，照 lib/api/settings-pref.ts）：
 * 订阅流程（PushManager.subscribe 成功后）POST 落库；退订 DELETE；取 VAPID 公钥。
 * 类型从 lib/push/types 零依赖导入（type-only，编译期擦除，不进客户端 bundle）。
 */
import type { PushSubscriptionKeys } from "@/lib/push/types";

export async function postPushSubscription(keys: PushSubscriptionKeys): Promise<Response> {
  return fetch("/api/push/subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keys),
  });
}

export async function deletePushSubscription(endpoint: string): Promise<Response> {
  return fetch("/api/push/subscription", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

/** 取 VAPID 公钥（未配置返回空串，客户端据此隐藏推送入口） */
export async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch("/api/push/vapid-public-key");
  if (!res.ok) return "";
  const data = (await res.json()) as { publicKey?: string };
  return data.publicKey ?? "";
}
