/**
 * 主题包注册表（M11，docs/THEME-SYSTEM.md）：与 styles/tokens/themes/<id>.css 一一对应，
 * 新增主题包时两边同步。html[data-pack] 由服务端直出（用户偏好 → 站点默认 → default），
 * CSS 选择器见各主题文件；qy2010 等「仅浅色」包用 :not([data-mode="dark"]) 限定，暗色自动回退默认暗色。
 */
export const THEME_PACKS = [
  { id: "default", label: "现代浅色" },
  // CSS 在 themes/qy2010.css（Step 4 旧站采样色板 + 插槽示范）
  { id: "qy2010", label: "复刻·青翼2010" },
] as const satisfies readonly ThemePack[];

export interface ThemePack {
  readonly id: string;
  readonly label: string;
}

/** 内置包随代码发布的 LOGO 文件登记（M11.6 Step 5a 从 THEME_PACKS 里拆出来） */
export interface BundledPackLogo {
  readonly id: string;
  /** apps/web/public/logo/ 下的 PNG 文件名（不带路径） */
  readonly file: string;
}

/**
 * 内置包自带的 LOGO：站长把该包设为全站默认主题时，自带 LOGO 自动导入 LOGO 池（池项带 pack 标签去重）
 * 并设为当前项；之后仍可在后台独立切换（补充关系，非硬绑定，docs/LOGO-POOL.md 联动已兑现）。
 * 不在登记表里的包不带 LOGO，联动时不触碰 LOGO 池。
 * 新增登记项时，logo-pool-fs.ts 的 readBundledPackLogo 要同步加一个字面路径（构建期可追踪），
 * apply-pack-logo.int.test 会在两边不同步时变红。
 */
export const BUNDLED_PACK_LOGOS = [
  // qy2010 的自带 LOGO = 站长定稿的「清爽侦探」青色半翼（与 LOGO 池当前项同一文件，public/logo/qy2010.png）
  { id: "qy2010", file: "qy2010.png" },
] as const satisfies readonly BundledPackLogo[];

/** 内置包自带的 LOGO 文件名；不带 LOGO 的包（含未知 id）返回 null */
export function bundledLogoOf(id: string): string | null {
  return BUNDLED_PACK_LOGOS.find((entry) => entry.id === id)?.file ?? null;
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
