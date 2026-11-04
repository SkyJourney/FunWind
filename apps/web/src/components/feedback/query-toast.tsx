"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * 统一就地反馈（M10.6d）：消费语义化 notice 码，按反馈类型呈现 toast 并清掉查询参数。
 * `error` 参数一律不动——各页把 error 经 postingNoticeText 等映射为内联横幅渲染（页面语义各异，
 * 也是无 JS 回退路径），这里剥参数会把横幅吞掉（edit/badges E2E 曾因此失败）。
 * 错误 toast 仅消费明确登记的 notice 码，不改变各页 error 的语义。
 */
const NOTICE_TEXT: Record<string, string> = {
  "password-reset": "新密码已生效，你已登录。",
  "password-changed": "新密码已生效。",
  claimed: "账号认领成功，欢迎回来！",
  "pm-policy-saved": "私信权限已更新。",
};
const ERROR_NOTICE_TEXT: Record<string, string> = {
  "interact-rate": "操作过于频繁，请稍后再试。",
  "preferences-rate": "操作过于频繁，请稍后再试。",
};

/** 有内联横幅的页面（auth 六页、后台）连 notice 也不 toast，防双重提示 */
const SKIP_PREFIXES = ["/login", "/register", "/forgot", "/reset/", "/claim/", "/admin"];

export function QueryToast() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const noticeCode = sp.get("notice");
    if (!noticeCode) return;
    if (!SKIP_PREFIXES.some((p) => pathname.startsWith(p))) {
      const errorText = ERROR_NOTICE_TEXT[noticeCode];
      if (errorText) toast.error(errorText);
      else toast.success(NOTICE_TEXT[noticeCode] ?? noticeCode);
      const next = new URLSearchParams(sp.toString());
      next.delete("notice");
      const qs = next.toString();
      router.replace(`${qs ? `${pathname}?${qs}` : pathname}${window.location.hash}`, {
        scroll: false,
      });
    }
  }, [sp, router, pathname]);

  return null;
}
