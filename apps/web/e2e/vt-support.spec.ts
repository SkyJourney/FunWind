import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

/**
 * M15 Step 0-5 支持面探测（实验用）：VT API、startViewTransition types 参数、
 * view-transition-class CSS 在 WebKit / Firefox 上的支持面。结果写 /tmp/vt-support-<engine>.json
 * 供结论回写 M15 文档 §10；页面内容断言 = 引擎红线「不支持 VT 的浏览器同步可用」。
 */
test("VT API 支持面探测", async ({ page, browserName }) => {
  await page.goto("/design/motion/lab/one");
  const support = await page.evaluate(() => {
    const doc = document as Document & { startViewTransition?: (o: unknown) => unknown };
    let typesSupported = false;
    try {
      const vt = doc.startViewTransition?.({ update: () => {}, types: ["m15-probe"] });
      typesSupported = vt !== undefined;
      (vt as { finished?: Promise<void> })?.finished?.catch(() => {});
    } catch {
      typesSupported = false;
    }
    return {
      startViewTransition: typeof doc.startViewTransition === "function",
      typesSupported,
      viewTransitionClass: window.CSS.supports?.("view-transition-class", "fw-page-in") ?? false,
      ua: navigator.userAgent,
    };
  });
  mkdirSync("/tmp", { recursive: true });
  writeFileSync(`/tmp/vt-support-${browserName}.json`, JSON.stringify(support, null, 1));
  // 引擎红线：不论支持面如何，页面内容必须同步可用（不支持 VT 时直接切换）
  await expect(page.getByRole("heading", { name: "Lab One" })).toBeVisible();
});
