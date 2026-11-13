/**
 * Web Push 客户端订阅助手（M18 Step 4，浏览器侧）：能力探测、设备订阅/退订。
 * 只 import 客户端 API 封装与零依赖类型，**不 import lib/push 服务端出口**（避免把 server-only 拖进 bundle）。
 * 订阅流程：Notification.requestPermission → PushManager.subscribe(VAPID 公钥) → POST 落库；
 * 任一步失败即回滚（已 subscribe 则 unsubscribe），不留半截订阅。
 */
import {
  deletePushSubscription,
  fetchVapidPublicKey,
  postPushSubscription,
} from "@/lib/api/push-subscription";

/** 能力探测：需 SW + PushManager + Notification 三者齐备（iOS 需先装 PWA，此处只做能力检测） */
export function isPushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID 公钥（base64url）→ PushManager.subscribe 所需的 Uint8Array */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export type SubscribeResult =
  { ok: true } | { ok: false; reason: "unsupported" | "denied" | "no-key" | "failed" };

/** 取当前设备订阅（无则 null）；SW 未就绪/不支持时返回 null */
export async function getDeviceSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** 订阅本设备：权限 → subscribe → POST 落库；失败回滚，返回结果供 UI 反馈 */
export async function subscribeDevice(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: "unsupported" };
  let sub: PushSubscription | null = null;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };
    const publicKey = await fetchVapidPublicKey();
    if (!publicKey) return { ok: false, reason: "no-key" };
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const json = sub.toJSON();
    const res = await postPushSubscription({
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    });
    if (!res.ok) {
      await sub.unsubscribe();
      return { ok: false, reason: "failed" };
    }
    return { ok: true };
  } catch {
    if (sub) await sub.unsubscribe().catch(() => undefined);
    return { ok: false, reason: "failed" };
  }
}

/** 退订本设备：DELETE 服务端凭据 + 浏览器 unsubscribe（一步退订）。
 * 服务端删除失败则保留浏览器订阅并返回 false（供重试），不误报「已退订」。 */
export async function unsubscribeDevice(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const res = await deletePushSubscription(sub.endpoint);
      if (!res.ok) return false;
      await sub.unsubscribe();
    }
    return true;
  } catch {
    return false;
  }
}
