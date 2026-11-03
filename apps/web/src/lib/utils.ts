import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 按 Number 的既有接受面解析正整数参数；不限制十进制写法或安全整数，非法值返回 null。 */
export function positiveIntParam(raw: string | null | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
