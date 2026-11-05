import {
  BASE_BAND,
  BASE_FONT,
  BASE_RADIUS,
  BASE_SHADOWS,
  SHADOW_SLOTS,
  effectiveColors,
  type ColorMode,
} from "./token-base";
import { renderTokenVars } from "./token-render";
import type { TokenSet } from "./token-schema";

/**
 * 后台令牌预览容器上的标记属性（M11.6 Step 3d）。semantic.css 里品牌渐变的选择器写的就是它，
 * 改名时 src/test/token-contrast.test.ts 会变红。
 */
export const TOKEN_PREVIEW_ATTR = "data-token-preview";

/**
 * 令牌预览容器的完整 CSS 变量集：基础层事实 + 草稿覆盖，补成「不依赖继承」的全量。
 *
 * 为什么不只输出覆盖项：预览容器嵌在后台页面里，页面自己可能是深色模式。
 * 容器只带覆盖项的话，没覆盖的颜色会从页面继承，浅色档预览里就混进深色的底和字。
 * 所以 22 个颜色、圆角、展示字体、三档阴影、板块卡参数全部在容器上写明，走与站点相同的 renderTokenVars。
 *
 * 两处例外，都是为了与站点逐值一致：
 *  · 浅色档没覆盖的阴影写成 `var(--fw-shadow-N)`：基础层浅色 s1 是两层叠加，令牌只能写一层，
 *    直接引用原子变量才是原样（原子变量不随明暗变化，所以在深色页面里也对）；
 *  · 品牌渐变没覆盖时不输出：它由 semantic.css 的 `[data-token-preview]` 规则在容器上按公式算，
 *    引用的是容器自己的 --primary / --accent / --secondary，随草稿变化。
 *
 * 板块卡遮罩色没覆盖时，基础层是 `var(--card)`，这里写成本档生效的卡片底色，等价且不依赖继承。
 */
export function previewTokenVars(
  mode: ColorMode,
  set: TokenSet | undefined,
): Record<string, string> {
  const own = set ?? {};
  const colors = effectiveColors(mode, own.colors);

  const shadows: NonNullable<TokenSet["shadows"]> = {};
  for (const slot of SHADOW_SLOTS) {
    const shadow = own.shadows?.[slot] ?? (mode === "dark" ? BASE_SHADOWS.dark[slot] : undefined);
    if (shadow) shadows[slot] = shadow;
  }

  const vars = renderTokenVars({
    colors,
    radius: own.radius ?? BASE_RADIUS,
    displayFont: own.displayFont ?? BASE_FONT,
    shadows,
    band: { ...BASE_BAND, maskColor: colors.card, ...own.band },
    ...(own.brandGradient ? { brandGradient: own.brandGradient } : {}),
  });

  if (mode === "light") {
    for (const slot of SHADOW_SLOTS) {
      const name = `--shadow-${slot.slice(1)}`;
      if (!(name in vars)) vars[name] = `var(--fw-shadow-${slot.slice(1)})`;
    }
  }
  return vars;
}
