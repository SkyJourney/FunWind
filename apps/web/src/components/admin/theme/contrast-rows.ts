import { evaluateContrast, type ContrastCheck } from "@/lib/theme/contrast-advisor";
import { hexColorSchema } from "@/lib/theme/color";
import { effectiveColors, type ColorMode } from "@/lib/theme/token-base";
import type { ColorKey, TokenSet } from "@/lib/theme/token-schema";
import { COLOR_GROUPS } from "./token-draft";

/**
 * 对比度面板的行数据（M11.6 Step 3d）：在顾问的 18 个固定配对之上，补编辑器需要的两样东西——
 * 前景 / 背景在令牌编辑器里的中文名（给「定位」按钮），以及这一行有没有被本包动过。
 */
export interface ContrastRow extends ContrastCheck {
  fgLabel: string;
  bgLabel: string;
  /**
   * 前景、背景两端都没有被本包覆盖：这一行的结果完全来自默认主题，不是这个包造成的。
   * 面板对未达标的这类行标「来自默认主题」，既不隐藏它们，也不让作者误以为是自己改坏的。
   */
  inherited: boolean;
}

const LABELS = Object.fromEntries(
  COLOR_GROUPS.flatMap((group) => group.items.map((item) => [item.key, item.label])),
) as Record<ColorKey, string>;

/** 某一档当前生效的颜色（基础层 + 草稿覆盖）上的 18 项检查，顺序与顾问一致 */
export function contrastRows(mode: ColorMode, set: TokenSet | undefined): ContrastRow[] {
  const overrides = set?.colors;
  // 与 effectiveColors 同一条规则：只有合法的 #RRGGBB 才算覆盖
  const overridden = (key: ColorKey) => hexColorSchema.safeParse(overrides?.[key]).success;
  return evaluateContrast(effectiveColors(mode, overrides)).map((check) => ({
    ...check,
    fgLabel: LABELS[check.fg],
    bgLabel: LABELS[check.bg],
    inherited: !overridden(check.fg) && !overridden(check.bg),
  }));
}

/**
 * 比值显示成两位小数，**向下取整**而不是四舍五入：达标线是 4.5，
 * 4.4996 四舍五入会显示成「4.50」，看上去达标，其实判的是未达标。
 * 乘 100 前加一个极小量，吸收 4.55 * 100 = 454.99999999999994 这类浮点误差。
 */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2);
}
