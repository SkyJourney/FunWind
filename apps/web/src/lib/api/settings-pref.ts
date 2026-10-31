/**
 * 设置中心开关类偏好的 PATCH 公共封装（/api/settings/preferences）：
 * 通知偏好 / 私信策略 / 主题包偏好共用同一 API 形状（kind 判别），客户端乐观更新后调用。
 */
export async function patchPreference(payload: Record<string, unknown>): Promise<Response> {
  return fetch("/api/settings/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
