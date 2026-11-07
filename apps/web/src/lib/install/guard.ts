import "server-only";

import { notFound } from "next/navigation";
import { isInstalled } from "./lock";

/**
 * /install 页面与 Server Action 的入口守卫（M12 D2）：站点已完成安装即 404——
 * 与「越权一律 404 不暴露存在性」的项目哲学一致，已装站点不向公网暴露安装机制的存在。
 * 运行时行为由 install E2E 覆盖；**静态守卫** `install-entry-guard.test.ts` 扫描
 * `/install/**` 的全部页面与 Action，保证每个入口都调用了本函数（漏一环就是重装漏洞）。
 */
export async function requireNotInstalled(): Promise<void> {
  if (await isInstalled()) notFound();
}
