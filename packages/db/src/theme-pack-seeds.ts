/**
 * 内置主题包定义（M11.1，docs/milestones/M11.1-theme-engine.md §1.2）。
 * 值来源：styles/tokens/themes/{default,qy2010}.css 的数据化（单一事实源=种子首写）；
 * bootstrap 只补缺（INSERT IGNORE 语义），站长在 /admin/themes 的编辑不被升级覆盖。
 * 站长决策（2026-11-01）：M13 上线以新主题体系做完整新主题，qy2010 降级为可选情怀包保留；
 * 站长决策（2026-11-08）：qy2010 **不再内置**——作为青翼站点自己添加的自定义主题存在
 *   （导入路径上线时 UPDATE is_builtin=false），种子/补缺/升级不再触碰它；
 *   BUILTIN_THEME_COLORS 的 qy2010 条目保留（PWA 色值表，非内置语义）。
 *
 * 注意：本模块不得 import web 私有模块（packages/db 被 web/migration 共享）；
 * surface-schema 的 zod 校验在 web 渲染/编辑层执行，种子层为信任数据（与 CSS 同源审阅）。
 */

export interface BuiltinThemePackSeed {
  id: string;
  name: string;
  description: string;
  definition: {
    pwa?: { themeColor: string; backgroundColor: string };
    surfaces: Record<
      string,
      {
        light: Record<string, unknown>;
        dark?: Record<string, unknown>;
      }
    >;
    tokens?: {
      light?: Record<string, unknown>;
      dark?: Record<string, unknown>;
    };
  };
}

/** default 包：即各令牌内置默认（CSS 层已有同值兜底；种子使后台编辑器可所见即所得编辑） */
const defaultPack: BuiltinThemePackSeed = {
  id: "default",
  name: "现代浅色",
  description: "FunWind 默认主题：青翼品牌青 + 冷调中性灰，圆角卡片与毛玻璃表面。",
  definition: {
    pwa: { themeColor: "#0e7490", backgroundColor: "#f8fafc" },
    surfaces: {
      header: {
        light: {
          fill: { type: "solid", color: "#f8fafc" },
          border: { color: "#e2e8f0", width: 1, style: "solid" },
          blur: 8,
        },
        dark: {
          fill: { type: "solid", color: "#0f172a" },
          border: { color: "#1e293b", width: 1, style: "solid" },
          blur: 8,
        },
      },
      tabbar: {
        light: {
          fill: { type: "solid", color: "#f8fafc" },
          border: { color: "#e2e8f0", width: 1, style: "solid" },
          blur: 8,
        },
        dark: {
          fill: { type: "solid", color: "#0f172a" },
          border: { color: "#1e293b", width: 1, style: "solid" },
          blur: 8,
        },
      },
      page: {
        light: { fill: { type: "solid", color: "#f8fafc" } },
        dark: { fill: { type: "solid", color: "#020617" } },
      },
      "banner-announce": {
        light: {
          fill: { type: "solid", color: "#ecfeff" },
          text: { primary: "#155e75", muted: "#64748b", link: "#0e7490" },
        },
      },
      "forum-band": {
        light: {
          fill: { type: "solid", color: "#ffffff" },
          overlay: {
            type: "linear",
            angle: 105,
            stops: [
              { color: "#ffffff", alpha: 0, position: 50 },
              { color: "#ffffff", alpha: 1, position: 100 },
            ],
          },
        },
        dark: {
          fill: { type: "solid", color: "#0f172a" },
          overlay: {
            type: "linear",
            angle: 105,
            stops: [
              { color: "#0f172a", alpha: 0, position: 50 },
              { color: "#0f172a", alpha: 1, position: 100 },
            ],
          },
        },
      },
      footer: {
        light: {
          fill: { type: "solid", color: "#f8fafc" },
          border: { color: "#e2e8f0", width: 1, style: "solid" },
          text: { primary: "#0f172a", muted: "#64748b", link: "#0e7490" },
        },
        dark: {
          fill: { type: "solid", color: "#0f172a" },
          border: { color: "#1e293b", width: 1, style: "solid" },
          text: { primary: "#f1f5f9", muted: "#94a3b8", link: "#22d3ee" },
        },
      },
      auth: {
        light: { fill: { type: "solid", color: "#f8fafc" } },
        dark: { fill: { type: "solid", color: "#020617" } },
      },
    },
  },
};

export const BUILTIN_THEME_PACK_SEEDS: readonly BuiltinThemePackSeed[] = [defaultPack];

/** 主题色（PWA manifest / 地址栏）：qy2010 情怀青蓝（M11.6 Step 6 加深到 #116a92）、default 品牌青。
 *  qy2010 已非内置包——此条目仅为该自定义包的已知色值（catalog 回退用），不代表内置语义。 */
export const BUILTIN_THEME_COLORS: Record<string, { themeColor: string; backgroundColor: string }> =
  {
    default: { themeColor: "#0e7490", backgroundColor: "#f8fafc" },
    qy2010: { themeColor: "#116a92", backgroundColor: "#f6f3e7" },
  };
