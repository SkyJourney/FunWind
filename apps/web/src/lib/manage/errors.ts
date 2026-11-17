/**
 * 管理 REST API（/api/manage/**，M20）的统一信封与错误码注册表。
 *
 * 单一事实源（G-15 纪律：码 ↔ 状态码 ↔ 文案成对，漏配即测试红）：
 *  - 成功 `{ ok: true, data }`；失败 `{ error: { code, message } }` + 语义 HTTP 状态。
 *  - `unauthorized` 覆盖凭证缺失/格式错/查无/过期/吊销/持有人注销——存在性不泄露。
 *  - `not_found` 覆盖资源不存在与越权（两者同型，对齐全站「越权与不存在一律 404」惯例）。
 *  - `internal` 不透传内部细节，只在 route 层兜底 catch 时使用。
 *
 * 本文件刻意保持纯数据（不 import next/server）：单测直接覆盖；
 * Response 构造集中在 lib/manage/route.ts 的入口封装里。
 */

/** 错误码注册表：新增码必须成对补状态与文案，docs/MANAGE-API.md 同步 */
export const MANAGE_ERROR_CODES = {
  unauthorized: { status: 401, message: "凭证缺失、无效或已失效。" },
  forbidden: { status: 403, message: "凭证有效但权限不足。" },
  not_found: { status: 404, message: "资源不存在。" },
  bad_request: { status: 400, message: "请求参数不合法。" },
  rate_limited: { status: 429, message: "请求过于频繁，请稍后再试。" },
  internal: { status: 500, message: "服务内部错误。" },
} as const;

export type ManageErrorCode = keyof typeof MANAGE_ERROR_CODES;

/** 领域错误：入口封装捕获后转统一信封（handler 内抛出，route 层不重复 try/catch） */
export class ManageApiError extends Error {
  /** 429 时的 Retry-After 秒数 */
  readonly retryAfterSec?: number;

  constructor(
    readonly code: ManageErrorCode,
    retryAfterSec?: number,
  ) {
    super(MANAGE_ERROR_CODES[code].message);
    this.name = "ManageApiError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** 成功信封体 */
export function manageOkBody<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/** 失败信封体：码经注册表查文案，调用方不能自选文案（保证对外口径单一） */
export function manageErrorBody(code: ManageErrorCode): {
  error: { code: ManageErrorCode; message: string };
} {
  return { error: { code, message: MANAGE_ERROR_CODES[code].message } };
}
