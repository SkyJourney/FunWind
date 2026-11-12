// @vitest-environment node
/**
 * 动效裸写守卫（M15 Step 3，docs/motion-spec.md §7）：
 * 业务代码（app/**、components/**）与非令牌 CSS 不得裸写动画时长/缓动曲线——
 * 错落进场一律经 <MotionList>，时长/曲线/位移/步长一律引令牌层。
 * 白名单：令牌文件（styles/tokens/**）、引擎模块（lib/motion/engine）、globals.css 预设区已全量令牌化。
 * 守卫按文本精确匹配（须带冒号的属性赋值 / cubic-bezier / animation 简写），文档散文提及不触发。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MOTION_DEFAULTS, MOTION_ELEMENT_PRESETS } from "@/lib/motion";
import { loadSources, type Sources } from "./source-graph";

const SRC = join(import.meta.dirname, "..");

/** 裸时间字面量：数字或模板插值收尾后紧跟 ms/s（"100ms"、"${i*50}ms"、"2s"）；令牌 calc(var()*3) 不含此模式 */
const TIME_LITERAL = /[0-9}]\s*(?:ms|s)\b/;
const CUBIC = /cubic-bezier\s*\(/;

function isBusinessSource(path: string): boolean {
  return (path.startsWith("app/") || path.startsWith("components/")) && /\.tsx?$/.test(path);
}

/** 业务 TS/TSX 内联动效裸写检测（纯函数，可在 fixture 上自检） */
export function inlineMotionViolations(sources: Sources): string[] {
  const violations: string[] = [];
  for (const [path, text] of Object.entries(sources)) {
    if (!isBusinessSource(path)) continue;
    text.split("\n").forEach((line, i) => {
      const at = `${path}:${i + 1}`;
      if (CUBIC.test(line))
        violations.push(`${at} → 业务代码裸写 cubic-bezier 曲线（须用 --fw-ease-* 令牌）`);
      // 覆盖驼峰/引号键/kebab-case（style 字符串属性）三种写法，堵住文本匹配缝隙（Step 4.5 审查 P2）
      if (
        /["']?(?:animation(?:Delay|Duration)|animation-delay|animation-duration)["']?\s*:/.test(
          line,
        )
      ) {
        const tokenOnly = /var\(--fw-/.test(line) && !TIME_LITERAL.test(line) && !/\$\{/.test(line);
        if (!tokenOnly)
          violations.push(
            `${at} → 业务代码裸写 animationDelay/Duration（错落须用 <MotionList>，时长须用令牌）`,
          );
      }
      const shorthand = /animation\s*:\s*([^;}\n]+)/.exec(line);
      if (shorthand && (TIME_LITERAL.test(shorthand[1]!) || /\$\{/.test(shorthand[1]!)))
        violations.push(`${at} → 业务代码 animation 简写裸写时长（须用令牌）`);
    });
  }
  return violations.sort();
}

/** 非令牌 CSS 裸写时长/曲线检测（globals.css 预设区已全量令牌化，故全文件扫描应零命中） */
export function cssMotionViolations(css: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, text] of Object.entries(css)) {
    if (path.startsWith("styles/tokens/")) continue;
    text.split("\n").forEach((line, i) => {
      const at = `${path}:${i + 1}`;
      if (CUBIC.test(line))
        violations.push(`${at} → CSS 裸写 cubic-bezier（须用 --fw-ease-* 令牌）`);
      const decl = /(?:animation|transition)(?:-duration|-delay)?\s*:\s*([^;{}]+)/.exec(line);
      if (decl && TIME_LITERAL.test(decl[1]!))
        violations.push(`${at} → CSS 裸写动画/过渡时长（须用 --fw-dur-* 令牌）`);
    });
  }
  return violations.sort();
}

function loadCss(root: string): Record<string, string> {
  const css: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".css"))
        css[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return css;
}

const sources = loadSources(SRC);
const css = loadCss(SRC);
const primitives = css["styles/tokens/primitives.css"] ?? "";
const globals = css["app/globals.css"] ?? "";

describe("M15 Step 3 动效裸写守卫 · 真实源码零裸写", () => {
  it("真实扫描非空，业务 TS/TSX 无内联时长/曲线/错落裸写", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    expect(inlineMotionViolations(sources)).toEqual([]);
  });

  it("非令牌 CSS 无裸写时长/曲线（globals.css 预设区已全量令牌化）", () => {
    expect(Object.keys(css).length).toBeGreaterThan(0);
    expect(cssMotionViolations(css)).toEqual([]);
  });
});

describe("M15 Step 3 令牌收敛（魔法数升格，防回归）", () => {
  // 去空白比较：令牌定义可能被 Prettier 拆行（如 calc 多行），断言只钉语义不钉排版
  const flat = (s: string) => s.replace(/\s+/g, "");
  it("primitives.css 定义全部升格令牌", () => {
    for (const token of [
      "--fw-dur-progress: 12s",
      "--fw-dur-float-up: calc(var(--fw-dur-slow) * 1.75)",
      "--fw-stagger-step: 50ms",
      "--fw-stagger-max: 10",
      "--fw-page-shift: 28px",
      "--fw-tab-shift: min(24vw, 96px)",
    ])
      expect(flat(primitives), token).toContain(flat(token));
    // 桌面断点覆写也在令牌层
    expect(flat(primitives)).toContain(flat("--fw-page-shift: 14px"));
    expect(flat(primitives)).toContain(flat("--fw-tab-shift: 56px"));
  });

  it("引擎错落上限与 CSS 令牌一致（钉住单一事实，防漂移）", () => {
    expect(MOTION_DEFAULTS.maxStaggerItems).toBe(10);
    expect(primitives).toMatch(/--fw-stagger-max:\s*10\b/);
  });

  it("globals.css 不再残留已升格的魔法数与演示遗留死代码", () => {
    expect(globals).not.toContain("fw-nav-grow 12s");
    expect(globals).not.toContain("* 1.75");
    expect(globals).not.toContain("--fw-page-shift: 28px");
    expect(globals).not.toContain("--fw-tab-shift: min(24vw, 96px)");
    expect(globals).not.toContain("vt-push-in");
    expect(globals).not.toContain("vt-pop-in");
    expect(globals).not.toContain('[style*="vt-push-in"]');
    // 位移/时长改引令牌
    expect(globals).toContain("var(--fw-dur-progress)");
    expect(globals).toContain("var(--fw-dur-float-up)");
  });
});

describe("动效裸写守卫自身：检测器有效性（变异自检）", () => {
  it.each([
    ['export const A = () => <div style={{ animationDelay: "120ms" }} />;', "animationDelay"],
    ["export const A = () => <div style={{ animationDelay: `${i * 50}ms` }} />;", "animationDelay"],
    ['export const A = () => <div style={{ animationDuration: "2s" }} />;', "animationDuration"],
    ['export const A = () => <div style={{ animation: "x 200ms ease" }} />;', "animation"],
    ['export const ease = "cubic-bezier(0.1, 0.2, 0.3, 0.4)";', "cubic-bezier"],
    ['export const A = () => <div style={{ "animationDelay": "120ms" }} />;', "引号键"],
    ['export const A = () => <div style="animation-delay: 120ms" />;', "kebab-case 字符串属性"],
  ])("业务裸写必被拦截：%s", (body) => {
    expect(inlineMotionViolations({ "components/evil.tsx": body })).toHaveLength(1);
  });

  it.each([
    [
      'export const A = () => <div style={{ animationDelay: "var(--fw-dur-base)" }} />;',
      "令牌引用",
    ],
    ['export const A = () => <div style={{ animation: "none" }} />;', "animation:none"],
    ['export const A = () => <div style={{ animation: anim || "none" }} />;', "变量驱动"],
    ["// 说明：错落进场用 animationDelay 令牌步长，不裸写", "散文注释（无冒号赋值）"],
    ['export const rows = [["--fw-dur-fast", "150ms", "微交互"]];', "令牌展示表（非动效赋值）"],
  ])("合法写法不误伤：%s", (body) => {
    expect(inlineMotionViolations({ "components/good.tsx": body })).toEqual([]);
  });

  it("引擎模块与 lib 不在业务扫描范围（错落实现归引擎）", () => {
    expect(
      inlineMotionViolations({
        "lib/motion/engine/list.tsx": "style.animationDelay = `calc(${t} * ${i})`;",
        "lib/motion/nav-guard.ts": 'const x = "animationDelay: 99ms";',
      }),
    ).toEqual([]);
  });

  it.each([
    [".x { animation: foo 200ms ease; }", "裸时长"],
    [".x { transition: opacity 150ms; }", "裸过渡时长"],
    [".x { animation-timing-function: cubic-bezier(0.1, 0.2, 0.3, 0.4); }", "裸曲线"],
    [".x { animation-delay: 200ms; }", "裸 delay"],
  ])("非令牌 CSS 裸写必被拦截：%s", (body) => {
    expect(cssMotionViolations({ "app/evil.css": body })).toHaveLength(1);
  });

  it.each([
    [".x { animation: foo var(--fw-dur-base) var(--fw-ease-out) both; }", "令牌时长"],
    [".x { transition: opacity var(--fw-dur-fast); }", "令牌过渡"],
    [".x { animation: none; }", "none"],
    ["@media (min-width: 768px) { .x { color: red; } }", "断点 px 非动效"],
  ])("令牌 CSS 不误伤：%s", (body) => {
    expect(cssMotionViolations({ "app/good.css": body })).toEqual([]);
  });

  it("令牌文件白名单：primitives 定义裸值不被判违规", () => {
    expect(
      cssMotionViolations({
        "styles/tokens/primitives.css":
          "--fw-dur-fast: 150ms; --fw-ease-out: cubic-bezier(0.22,1,0.36,1);",
      }),
    ).toEqual([]);
  });
});

describe("M15 Step 3 reduced-motion 收编核对", () => {
  it("元素预设类全部在 reduce 媒体查询内被归零（animation:none 或 display:none）", () => {
    const reduceBlocks = [
      ...globals.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1])
      .join("\n");
    expect(reduceBlocks.length).toBeGreaterThan(0);
    // 语义断言（Step 4.5 审查 P2-8）：类名所在规则体必须真的归零，而非仅「出现」在 reduce 块内
    for (const preset of Object.values(MOTION_ELEMENT_PRESETS)) {
      const at = reduceBlocks.indexOf(`.${preset.className}`);
      expect(at, `reduce 块须包含 ${preset.className}`).toBeGreaterThanOrEqual(0);
      const body = reduceBlocks
        .slice(reduceBlocks.indexOf("{", at) + 1, reduceBlocks.indexOf("}", at))
        .trim();
      expect(body, `reduce 须归零 ${preset.className}`).toMatch(
        /^(?:animation|display)\s*:\s*none;?$/,
      );
    }
    expect(reduceBlocks).toContain("animation: none");
    expect(reduceBlocks).toContain("display: none");
    // 页面过渡伪元素在 reduce 下全部归零
    expect(reduceBlocks).toContain("::view-transition-old(*)");
  });

  it("tw-animate 弹层在 reduce 块内归零（M16 Step 1 兜底，防回归）", () => {
    const blocks = [
      ...globals.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1])
      .join("\n");
    const at = blocks.indexOf('[class*="animate-in"]');
    expect(
      at,
      "reduce 块须包含 animate-in/out 兜底规则（子串匹配覆盖变体形态）",
    ).toBeGreaterThanOrEqual(0);
    expect(blocks.slice(at), "animate-out 与 animate-in 同规则").toContain(
      '[class*="animate-out"]',
    );
    const body = blocks.slice(blocks.indexOf("{", at) + 1, blocks.indexOf("}", at)).trim();
    expect(body, "弹层兜底须真归零（!important 压过 tw-animate）").toBe(
      "animation: none !important;",
    );
    // Skeleton 的 animate-pulse 无限脉冲不属弹层、兜底覆盖不到，单独归零（M16 Step 4.5 P1-5）
    const pulseAt = blocks.indexOf(".animate-pulse");
    expect(pulseAt, "reduce 块须包含 animate-pulse 归零").toBeGreaterThanOrEqual(0);
    const pulseBody = blocks
      .slice(blocks.indexOf("{", pulseAt) + 1, blocks.indexOf("}", pulseAt))
      .trim();
    expect(pulseBody, "animate-pulse 须真归零").toBe("animation: none !important;");
  });

  it("场景级高亮在 reduce 块内归零（楼层锚点 / 新插入锁定内容）", () => {
    const blocks = [
      ...globals.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1])
      .join("\n");
    // 两者都是场景级 keyframes（动着色不动几何），reduce 下必须静止呈现
    for (const selector of [".fw-floor.fw-floor-hl-on", ".fw-gate.fw-gate-hl-on"]) {
      const at = blocks.indexOf(selector);
      expect(at, `reduce 块须包含 ${selector}`).toBeGreaterThanOrEqual(0);
      const body = blocks.slice(blocks.indexOf("{", at) + 1, blocks.indexOf("}", at)).trim();
      expect(body, `${selector} 须真归零`).toBe("animation: none;");
    }
  });
});
