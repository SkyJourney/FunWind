/**
 * 主题包注册表（M11，docs/THEME-SYSTEM.md）：与 styles/tokens/themes/<id>.css 一一对应，
 * 新增主题包时两边同步。html[data-pack] 由服务端直出（用户偏好 → 站点默认 → default），
 * CSS 选择器见各主题文件；qy2010 等「仅浅色」包用 :not([data-mode="dark"]) 限定，暗色自动回退默认暗色。
 *
 * logo：主题包可选自带一枚 LOGO（public/logo/ 下的文件名）。站长把该包设为全站默认主题时，
 * 自带 LOGO 自动导入 LOGO 池（池项带 pack 标签去重）并设为当前项；之后仍可在后台独立切换
 * （补充关系，非硬绑定，docs/LOGO-POOL.md 联动已兑现）。无 logo 的主题不触碰 LOGO 池。
 */
export const THEME_PACKS = [
  { id: "default", label: "现代浅色", logo: null },
  // CSS 在 themes/qy2010.css：Step 2 先登记骨架（仅浅色限定选择器），Step 4 采样旧皮肤填色板与插槽示范；
  // logo 随站长素材到位后填入 public/logo/ 下的文件名
  { id: "qy2010", label: "复刻·青翼2010", logo: null },
] as const satisfies readonly ThemePack[];

export interface ThemePack {
  readonly id: string;
  readonly label: string;
  /** 自带 LOGO 文件名（apps/web/public/logo/ 下的 PNG）；null = 不带 */
  readonly logo: string | null;
}

export type PackId = (typeof THEME_PACKS)[number]["id"];

/** 站点默认主题包（站长未配置时的兜底） */
export const DEFAULT_PACK: PackId = "default";

export function isPackValue(v: string | null | undefined): v is PackId {
  return THEME_PACKS.some((p) => p.id === v);
}

export function packLabel(id: PackId): string {
  return THEME_PACKS.find((p) => p.id === id)?.label ?? id;
}
