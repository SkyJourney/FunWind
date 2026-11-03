import { redirect } from "next/navigation";

/**
 * 错误提示值必须编码：Next 把跳转地址原样写入响应头，中文与换行会导致请求失败。
 * path 由调用方提供站内路径；此处只编码提示值，不负责校验跳转目标。
 */

/** 构造 `path?error=<编码后的文案>`（已有 query 时追加 &error=）；只造地址不跳转 */
export const errorHop = (path: string, message: string): string =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;

/** 以错误提示跳转（等价 redirect(errorHop(...))，少一层括号） */
export function redirectWithError(path: string, message: string): never {
  redirect(errorHop(path, message));
}
