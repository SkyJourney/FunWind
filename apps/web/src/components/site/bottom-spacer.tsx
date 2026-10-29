"use client";

import { usePathname } from "next/navigation";

/** 移动端底部 Tab 的占位（内容不被固定栏遮挡）；后台无底部 Tab，不占位 */
export function BottomSpacer() {
  const pathname = usePathname();
  if (pathname.startsWith("/admin")) return null;
  return <div aria-hidden className="h-16 md:hidden" />;
}
