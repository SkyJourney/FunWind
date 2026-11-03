import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const LAYOUT_AUDIT_ONLY = process.env.LAYOUT_AUDIT_ONLY === "1";
const SCREENSHOTS = process.env.RUN_LAYOUT_SCREENSHOTS === "1";

type Region = { name: string; selector: string };
type CaptureOptions = {
  roots?: string;
  regions?: Region[];
  buttons?: string;
  required?: string[];
};
type Finding = { kind: string; target: string; message: string; actual?: unknown };
type Snapshot = {
  label: string;
  url: string;
  findings: Finding[];
  geometry?: unknown;
  screenshots: string[];
};

/** 布局与权限逐项收集：默认在全部检查后严格失败，审查模式只导出 JSON，便于一次采全基线。 */
export class LayoutAudit {
  private readonly snapshots: Snapshot[] = [];
  private readonly checks: { label: string; passed: boolean; error?: string }[] = [];
  private readonly pageErrors: { url: string; message: string }[] = [];
  private sequence = 0;

  constructor(
    private readonly page: Page,
    private readonly info: TestInfo,
  ) {
    page.on("pageerror", (error) =>
      this.pageErrors.push({ url: page.url(), message: error.message }),
    );
  }

  /** 单个场景失败不阻断后续页面；严格模式在 finish 汇总失败，避免只留下第一处溢出。 */
  async step(label: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.checks.push({ label, passed: true });
    } catch (error) {
      this.checks.push({ label, passed: false, error: String(error) });
      await this.capture(`${label}-异常现场`).catch((captureError: unknown) => {
        this.checks.push({
          label: `${label}-采集异常现场`,
          passed: false,
          error: String(captureError),
        });
      });
    }
    await this.persist();
  }

  /** 不注入布局样式、不改 DOM；只读取实际几何、原生文件控件和文字 Range。 */
  async capture(label: string, options: CaptureOptions = {}): Promise<void> {
    await this.page.evaluate(async () => {
      await document.fonts.ready;
      const animations = document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      window.scrollTo(0, 0);
    });
    const geometry = await this.page.evaluate(
      ({ roots, regions, buttons, required }) => {
        const tolerance = 1;
        const findings: Finding[] = [];
        const rectOf = (element: Element) => {
          const r = element.getBoundingClientRect();
          return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const paintedRect = (element: Element) => {
          const rect = element.getBoundingClientRect();
          let { left, right, top, bottom } = rect;
          // 导航和工具栏是明确允许的局部滚动区；只测其实际绘制部分，不能把被裁在滚动区外的链接误算为覆盖。
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const style = getComputedStyle(parent);
            const boundary = parent.getBoundingClientRect();
            if (parent.matches("nav") && /auto|scroll/.test(style.overflowY)) {
              top = Math.max(top, boundary.top);
              bottom = Math.min(bottom, boundary.bottom);
            }
            if (parent.matches('[role="toolbar"]') && /auto|scroll/.test(style.overflowX)) {
              left = Math.max(left, boundary.left);
              right = Math.min(right, boundary.right);
            }
          }
          return {
            left,
            right,
            top,
            bottom,
            width: Math.max(0, right - left),
            height: Math.max(0, bottom - top),
          };
        };
        const visible = (element: Element) => {
          const style = getComputedStyle(element);
          const rect = paintedRect(element);
          return (
            !element.closest(".sr-only") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            element.getClientRects().length > 0
          );
        };
        const nameOf = (element: Element) => {
          const id = element.id ? `#${element.id}` : "";
          const slot = element.getAttribute("data-slot");
          const name =
            element.getAttribute("aria-label") ??
            element.getAttribute("name") ??
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 100) ??
            "";
          return `${element.tagName.toLowerCase()}${id}${slot ? `[${slot}]` : ""} ${name}`;
        };
        // 只豁免表格、代码块自己的局部横向滚动；页面、动作行和普通上传表单不能借此被豁免。
        const localScroller = (element: Element): Element | null => {
          let parent = element.parentElement;
          while (parent && parent !== document.body) {
            const overflow = getComputedStyle(parent).overflowX;
            const onlyChild = parent.children.length === 1 ? parent.firstElementChild : null;
            if (
              (overflow === "auto" || overflow === "scroll") &&
              (parent.matches('pre, .cm-scroller, [role="toolbar"]') ||
                onlyChild?.matches("table, pre"))
            )
              return parent;
            parent = parent.parentElement;
          }
          return null;
        };
        const clippedTextAncestor = (element: Element): Element | null => {
          let parent: Element | null = element;
          while (parent && parent !== document.body) {
            const style = getComputedStyle(parent);
            const controls = parent.querySelector("button, input, select, textarea");
            if (
              !controls &&
              (style.overflowX === "hidden" || style.overflowX === "clip") &&
              (style.textOverflow === "ellipsis" || Number.parseInt(style.webkitLineClamp) > 0)
            )
              return parent;
            parent = parent.parentElement;
          }
          return null;
        };
        const viewportWidth = document.documentElement.clientWidth;
        const widths = {
          viewport: viewportWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        };
        if (
          widths.document > viewportWidth + tolerance ||
          widths.body > viewportWidth + tolerance
        ) {
          findings.push({
            kind: "page-overflow",
            target: "document/body",
            message: "页面出现横向滚动，局部表格/代码滚动不应扩大页面宽度",
            actual: widths,
          });
        }
        const rootElements = Array.from(document.querySelectorAll(roots)).filter(visible);
        if (rootElements.length === 0)
          findings.push({
            kind: "missing-root",
            target: roots,
            message: "没有找到可见的审查区域，不能把空采集视为通过",
          });
        const nodes = new Set<Element>();
        for (const root of rootElements) {
          nodes.add(root);
          for (const node of root.querySelectorAll(
            "[data-slot='card'], [data-slot='card-content'], .content-md, li, section, [class~='overflow-x-auto'], pre, table, p, label, form, fieldset, summary, input:not([type='hidden']), select, textarea, button, a, span, code, img, details, [role='alert'], [role='status']",
          )) {
            if (visible(node)) nodes.add(node);
          }
        }
        const overflowing: {
          target: string;
          rect: ReturnType<typeof rectOf>;
          boundary?: unknown;
        }[] = [];
        const localScrolls = new Map<
          Element,
          { target: string; rect: ReturnType<typeof rectOf>; scrollWidth: number }
        >();
        const controlMetrics: {
          target: string;
          rect: ReturnType<typeof rectOf>;
          files?: string[];
        }[] = [];
        for (const node of nodes) {
          const rect = rectOf(node);
          const scroll = localScroller(node);
          if (scroll) {
            localScrolls.set(scroll, {
              target: nameOf(scroll),
              rect: rectOf(scroll),
              scrollWidth: scroll.scrollWidth,
            });
            continue;
          }
          const textClip =
            node.matches("p, a, span, code") && !node.closest("button")
              ? clippedTextAncestor(node)
              : null;
          const clipRect = textClip ? rectOf(textClip) : null;
          // 摘要省略/两行裁切是允许的展示；只裁切其文字后代，不豁免同卡片的真实按钮或输入。
          const painted = clipRect
            ? {
                left: Math.max(rect.left, clipRect.left),
                right: Math.min(rect.right, clipRect.right),
              }
            : rect;
          let outside = painted.left < -tolerance || painted.right > viewportWidth + tolerance;
          const container = node.parentElement?.closest(
            "[data-slot='card-content'], [data-slot='card'], li[class~='border'][class~='rounded-xl'], section[class~='border'][class~='rounded-xl'], details, [role='dialog']",
          );
          let boundary: ReturnType<typeof rectOf> | undefined;
          if (container && visible(container)) {
            boundary = rectOf(container);
            const style = getComputedStyle(container);
            const paddingLeft = container.matches("[data-slot='card-content']")
              ? parseFloat(style.paddingLeft)
              : 0;
            const paddingRight = container.matches("[data-slot='card-content']")
              ? parseFloat(style.paddingRight)
              : 0;
            outside ||=
              painted.left < boundary.left + paddingLeft - tolerance ||
              painted.right > boundary.right - paddingRight + tolerance;
          }
          if (outside) {
            overflowing.push({ target: nameOf(node), rect, boundary });
            findings.push({
              kind: "element-boundary",
              target: nameOf(node),
              message: "内容或控件越出视口/卡片内容边界",
              actual: { rect, boundary },
            });
          }
          // 原生输入内部可水平裁切值，不能把它的 scrollWidth 当页面溢出；但控件本身必须在边界内。
          if (node.matches("input, select, textarea")) {
            controlMetrics.push({
              target: nameOf(node),
              rect,
              ...(node instanceof HTMLInputElement && node.type === "file"
                ? { files: Array.from(node.files ?? [], (file) => file.name) }
                : {}),
            });
          }
          // 长连续 ASCII 的文字即使不扩大元素盒子，仍可能绘制出卡片；用 Range 检查真实文字片段。
          if (
            !node.matches("p, a, span, code, label") ||
            node.closest("button, svg") ||
            node.querySelector("p, a, span, code, label")
          )
            continue;
          if (
            textClip ||
            getComputedStyle(node).overflowX === "hidden" ||
            getComputedStyle(node).overflowX === "clip"
          )
            continue;
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text: Node | null;
          while ((text = walker.nextNode())) {
            if (!text.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(text);
            for (const r of range.getClientRects()) {
              if (r.width === 0 || r.height === 0) continue;
              const left = Math.max(0, boundary?.left ?? rect.left);
              const right = Math.min(viewportWidth, boundary?.right ?? rect.right);
              if (r.left < left - tolerance || r.right > right + tolerance) {
                findings.push({
                  kind: "text-boundary",
                  target: nameOf(node),
                  message: "正文/文件名的实际文字越出容器（并非允许的局部滚动）",
                  actual: {
                    text: text.textContent.slice(0, 120),
                    left: r.left,
                    right: r.right,
                    boundaryLeft: left,
                    boundaryRight: right,
                  },
                });
                break;
              }
            }
          }
        }
        const buttonMetrics = Array.from(document.querySelectorAll(buttons))
          .filter(visible)
          .map((button) => {
            const rect = paintedRect(button);
            const style = getComputedStyle(button);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
            const textRects: { left: number; right: number; top: number; bottom: number }[] = [];
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            let text: Node | null;
            while ((text = walker.nextNode())) {
              if (
                !text.textContent?.trim() ||
                text.parentElement?.closest("svg, [aria-hidden='true'], .sr-only")
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              for (const r of range.getClientRects()) {
                if (r.width && r.height)
                  textRects.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
              }
            }
            const centers: number[] = [];
            for (const r of textRects) {
              const center = (r.top + r.bottom) / 2;
              if (!centers.some((other) => Math.abs(other - center) < lineHeight * 0.55))
                centers.push(center);
            }
            const icons = Array.from(button.querySelectorAll("svg, img")).map((icon) => ({
              target: nameOf(icon),
              rect: rectOf(icon),
            }));
            const metric = {
              target: nameOf(button),
              rect,
              lineHeight,
              lines: centers.length,
              textRects,
              icons,
              localScroll: Boolean(localScroller(button)),
            };
            if (
              icons.some(
                ({ rect: icon }) =>
                  icon.width <= 0 ||
                  icon.height <= 0 ||
                  icon.left < rect.left - tolerance ||
                  icon.right > rect.right + tolerance ||
                  icon.top < rect.top - tolerance ||
                  icon.bottom > rect.bottom + tolerance,
              )
            ) {
              findings.push({
                kind: "button-icon-clipped",
                target: metric.target,
                message: "图标按钮的真实图标被压缩或越出按钮边界",
                actual: metric,
              });
            }
            if (metric.lines > 1)
              findings.push({
                kind: "button-multiline",
                target: metric.target,
                message: "动作按钮文字不是单行（按文字 Range 与计算行高判断）",
                actual: metric,
              });
            if (
              textRects.some(
                (r) =>
                  r.left < rect.left - tolerance ||
                  r.right > rect.right + tolerance ||
                  r.top < rect.top - tolerance ||
                  r.bottom > rect.bottom + tolerance,
              )
            ) {
              findings.push({
                kind: "button-text-clipped",
                target: metric.target,
                message: "按钮文字越出按钮自身边界",
                actual: metric,
              });
            }
            return metric;
          });
        for (let i = 0; i < buttonMetrics.length; i++) {
          for (let j = i + 1; j < buttonMetrics.length; j++) {
            const a = buttonMetrics[i]!;
            const b = buttonMetrics[j]!;
            if (a.localScroll || b.localScroll) continue;
            const overlapX =
              Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const overlapY =
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (overlapX > tolerance && overlapY > tolerance)
              findings.push({
                kind: "button-overlap",
                target: `${a.target} / ${b.target}`,
                message: "操作控件互相覆盖",
                actual: { a: a.rect, b: b.rect },
              });
          }
        }
        const regionMetrics = regions.map((region) => ({
          name: region.name,
          elements: Array.from(document.querySelectorAll(region.selector))
            .filter(visible)
            .map((element) => ({ target: nameOf(element), rect: rectOf(element) })),
        }));
        for (const selector of required) {
          if (!Array.from(document.querySelectorAll(selector)).some(visible))
            findings.push({
              kind: "missing-required",
              target: selector,
              message: "必要场景元素未渲染，不能作为布局通过",
            });
        }
        return {
          widths,
          findings,
          overflowing,
          buttons: buttonMetrics,
          controls: controlMetrics,
          regions: regionMetrics,
          allowedLocalScrolls: [...localScrolls.values()],
        };
      },
      {
        roots: options.roots ?? "main, .lg\\:pl-56 > div, [role='dialog']",
        regions: options.regions ?? [],
        buttons: options.buttons ?? "main button, main a[role='button']",
        required: options.required ?? [],
      },
    );
    const entry: Snapshot = {
      label,
      url: this.page.url(),
      findings: geometry.findings,
      geometry,
      screenshots: [],
    };
    this.snapshots.push(entry);
    const artifactId = `${String(++this.sequence).padStart(2, "0")}-${label.replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, "-").slice(0, 90)}`;
    if (SCREENSHOTS) {
      const screenshot = this.info.outputPath("responsive", `${artifactId}.png`);
      await mkdir(path.dirname(screenshot), { recursive: true });
      await this.page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
      entry.screenshots.push(screenshot);
      for (const region of options.regions ?? []) {
        const locator = this.page.locator(region.selector).first();
        if (!(await locator.isVisible())) continue;
        const regionPath = this.info.outputPath("responsive", `${artifactId}-${region.name}.png`);
        await locator.screenshot({ path: regionPath, animations: "disabled" });
        entry.screenshots.push(regionPath);
      }
    }
    await this.persist();
  }

  /** JSON 始终保存，截图只由显式开关导出；默认断言包含语义失败、几何失败和未捕获异常。 */
  async finish(): Promise<void> {
    await this.persist();
    await this.info.attach("layout-audit", {
      path: this.info.outputPath("layout-audit.json"),
      contentType: "application/json",
    });
    if (LAYOUT_AUDIT_ONLY) return;
    const failures = [
      ...this.checks
        .filter((check) => !check.passed)
        .map((check) => ({ kind: "scenario", ...check })),
      ...this.snapshots.flatMap((snapshot) =>
        snapshot.findings.map((finding) => ({ page: snapshot.label, ...finding })),
      ),
      ...this.pageErrors.map((error) => ({ kind: "pageerror", ...error })),
    ];
    expect(failures, "跨尺寸布局回归失败，完整几何与场景诊断见 layout-audit.json").toEqual([]);
  }

  private async persist(): Promise<void> {
    const destination = this.info.outputPath("layout-audit.json");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      JSON.stringify(
        {
          project: this.info.project.name,
          test: this.info.title,
          auditOnly: LAYOUT_AUDIT_ONLY,
          screenshotsEnabled: SCREENSHOTS,
          viewport: this.page.viewportSize(),
          checks: this.checks,
          pageErrors: this.pageErrors,
          snapshots: this.snapshots,
        },
        null,
        2,
      ),
    );
  }
}
