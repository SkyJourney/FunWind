/**
 * 主题包静态注册表（M11.6 Step 5b 后只保留系统回退包）：
 *
 * 只有 `default` 包在此注册（CSS 在 styles/tokens/themes/default.css，作为冷启动 / 数据库不可达时的最终兜底）。
 * 其余内置包（如 `qy2010`）与自定义包均在 `theme_packages` 表中，由种子 / 管理员维护，运行时经 lib/theme/catalog 读取。
 * html[data-pack] 由服务端直出（用户偏好 → 站点默认 → default），主题样式经 SSR 注入 <style data-fw-theme-pack>。
 */
export const THEME_PACKS = [
  { id: "default", label: "现代浅色" },
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
  // qy2010 的自带 LOGO = 站长定稿的「清爽侦探」青色半翼（与 LOGO 池当前项同一文件，public/logo/qy2010.png）；
  // qy2010 现已移至数据库种子（packages/db/src/theme-pack-seeds.ts），但 LOGO 文件仍留此处供目录回退
  { id: "qy2010", file: "qy2010.png" },
] as const satisfies readonly BundledPackLogo[];

/** 内置包自带的 LOGO 文件名；不带 LOGO 的包（含未知 id）返回 null */
export function bundledLogoOf(id: string): string | null {
  return BUNDLED_PACK_LOGOS.find((entry) => entry.id === id)?.file ?? null;
}

/** 站点默认主题包（站长未配置时的兜底） */
export const DEFAULT_PACK = "default" as const;
