import { hexToRgb } from "./color";
import type { ColorKey } from "./token-schema";

/**
 * 对比度顾问（M11.6 Step 1）：纯函数，可在服务端与浏览器共享。
 *
 * 基于 WCAG 2.1 相对亮度与对比度比值（docs/milestones/M11.6-theme-semantic-tokens.md §3.3）。
 * 只警告不阻止保存（设计决策 D2）；前景 / 背景组合固定（不可配置）；阈值固定 4.5:1（WCAG AA 文字最低）。
 */

export type Rgb = [number, number, number];

export const TEXT_CONTRAST_MIN = 4.5;

/** 相对亮度（WCAG 2.1 公式） */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 对比度比值（WCAG 2.1 公式）：L1 与 L2 哪个更亮不重要，返回值 ≥ 1 */
export function contrastRatio(rgb1: Rgb, rgb2: Rgb): number {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** alpha 叠加：fg 颜色以指定透明度覆盖在 bg 上，返回合成后的 RGB（各通道四舍五入） */
export function compositeOver(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((fgC, i) => Math.round(fgC * alpha + bg[i] * (1 - alpha))) as Rgb;
}

export interface ContrastCheck {
  id: string;
  label: string;
  fg: ColorKey;
  bg: ColorKey;
  /** 可选：fg 以此透明度叠加在 bg 上形成淡底，文字仍用 fg 本色（Tailwind 的 bg-x/10 语义） */
  tintAlpha?: number;
  ratio: number;
  pass: boolean;
}

/**
 * 检查令牌色组合的对比度（18 个固定组合，设计 §3.3）。
 *
 * @param colors 已解析的 22 个语义色（调用方须合并 base + 包覆盖，缺失键用 base 补齐）
 * @returns 全部检查结果（通过与不通过都返回）；ratio 未四舍五入（显示时自己格式化）
 */
export function evaluateContrast(colors: Record<ColorKey, string>): ContrastCheck[] {
  const pairs: Array<{
    id: string;
    label: string;
    fg: ColorKey;
    bg: ColorKey;
    tintAlpha?: number;
  }> = [
    { id: "fg-bg", label: "正文文字 / 页面底", fg: "foreground", bg: "background" },
    { id: "fg-card", label: "正文文字 / 卡片底", fg: "foreground", bg: "card" },
    { id: "card-fg-card", label: "卡片文字 / 卡片底", fg: "card-foreground", bg: "card" },
    {
      id: "popover-fg-popover",
      label: "弹层文字 / 弹层底",
      fg: "popover-foreground",
      bg: "popover",
    },
    {
      id: "primary-fg-primary",
      label: "主按钮文字 / 主色",
      fg: "primary-foreground",
      bg: "primary",
    },
    {
      id: "secondary-fg-secondary",
      label: "次按钮文字 / 次色",
      fg: "secondary-foreground",
      bg: "secondary",
    },
    { id: "accent-fg-accent", label: "强调文字 / 强调底", fg: "accent-foreground", bg: "accent" },
    {
      id: "destructive-fg-destructive",
      label: "危险按钮文字 / 危险色",
      fg: "destructive-foreground",
      bg: "destructive",
    },
    { id: "muted-fg-bg", label: "次要文字 / 页面底", fg: "muted-foreground", bg: "background" },
    { id: "muted-fg-card", label: "次要文字 / 卡片底", fg: "muted-foreground", bg: "card" },
    // 淡底（primary/destructive/success/warning 的 10% 淡底 × 两种基底 = 8 项）
    {
      id: "primary-tint-card",
      label: "主色文字 / 主色淡底（卡片）",
      fg: "primary",
      bg: "card",
      tintAlpha: 0.1,
    },
    {
      id: "primary-tint-bg",
      label: "主色文字 / 主色淡底（页面）",
      fg: "primary",
      bg: "background",
      tintAlpha: 0.1,
    },
    {
      id: "destructive-tint-card",
      label: "危险色文字 / 危险淡底（卡片）",
      fg: "destructive",
      bg: "card",
      tintAlpha: 0.1,
    },
    {
      id: "destructive-tint-bg",
      label: "危险色文字 / 危险淡底（页面）",
      fg: "destructive",
      bg: "background",
      tintAlpha: 0.1,
    },
    {
      id: "success-tint-card",
      label: "成功色文字 / 成功淡底（卡片）",
      fg: "success",
      bg: "card",
      tintAlpha: 0.1,
    },
    {
      id: "success-tint-bg",
      label: "成功色文字 / 成功淡底（页面）",
      fg: "success",
      bg: "background",
      tintAlpha: 0.1,
    },
    {
      id: "warning-tint-card",
      label: "警告色文字 / 警告淡底（卡片）",
      fg: "warning",
      bg: "card",
      tintAlpha: 0.1,
    },
    {
      id: "warning-tint-bg",
      label: "警告色文字 / 警告淡底（页面）",
      fg: "warning",
      bg: "background",
      tintAlpha: 0.1,
    },
  ];

  return pairs.map((p) => {
    const fgRgb = hexToRgb(colors[p.fg]);
    const bgRgb = hexToRgb(colors[p.bg]);
    const effectiveBg =
      p.tintAlpha !== undefined ? compositeOver(fgRgb, bgRgb, p.tintAlpha) : bgRgb;
    const ratio = contrastRatio(fgRgb, effectiveBg);
    return { ...p, ratio, pass: ratio >= TEXT_CONTRAST_MIN };
  });
}

/** 仅返回未通过检查的项（前端警告面板用） */
export function contrastWarnings(colors: Record<ColorKey, string>): ContrastCheck[] {
  return evaluateContrast(colors).filter((c) => !c.pass);
}
