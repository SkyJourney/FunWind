"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * 统一就地反馈（M10.6d）：只消费**语义化 notice 码**（成功反馈），toast 呈现并清掉查询参数。
 * `error` 参数一律不动——各页把 error 经 postingNoticeText 等映射为内联横幅渲染（页面语义各异，
 * 也是无 JS 回退路径），这里剥参数会把横幅吞掉（edit/badges E2E 曾因此失败）。
 * 未来新动作要弹错误 toast 时，带独立参数（如 ?failed=码）再扩展本组件。
 */
const NOTICE_TEXT: Record<string, string> = {
  "verify-email-sent": "注册成功——请查收邮箱完成验证（验证前可浏览，暂不能发帖）。",
  "password-reset": "新密码已生效，你已登录。",
  claimed: "账号认领成功，欢迎回来！",
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
      toast.success(NOTICE_TEXT[noticeCode] ?? noticeCode);
      const next = new URLSearchParams(sp.toString());
      next.delete("notice");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [sp, router, pathname]);

  return null;
}
