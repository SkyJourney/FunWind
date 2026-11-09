/**
 * qy2010「复刻·青翼2010」的定稿定义（站长 2026-11-08：qy2010 移出内置种子，作为站点自定义主题存在）。
 * 值为生产库当前 definition 的导出，是测试与 E2E 夹具的单一来源：web 集成测试（插入「数据库启用的包」）、
 * 令牌对比度单测、`db:e2e-fixtures`（E2E 库里的 qy2010 自定义包）都读这里。生产库里的 qy2010 改了定稿时同步更新。
 * 注意：这不是种子——bootstrap 不写它（零数据站点只有内置 default 包）。
 */

export interface Qy2010PackDefinition {
  pwa: { themeColor: string; backgroundColor: string };
  tokens: { light: Record<string, unknown> };
  surfaces: Record<string, unknown>;
}

export const QY2010_PACK = {
  id: "qy2010",
  name: "复刻·青翼2010",
} as const;

/**
 * 淡金底 + 同色描边的三个同款表面（footer / header / tabbar）：定稿导出里它们完全相同。
 * 提取为常量只为了通过重复代码棘轮门禁（jscpd 对生成数据同样计数），值与定稿导出逐字节一致。
 */
const PALE_GOLD_FILL = { type: "solid", color: "#f8f5e8" } as const;
const PALE_GOLD_BORDER = { color: "#ddd5b4", style: "solid", width: 1 } as const;

export const QY2010_PACK_DEFINITION: Qy2010PackDefinition = {
  pwa: {
    themeColor: "#116a92",
    backgroundColor: "#f6f3e7",
  },
  tokens: {
    light: {
      band: {
        dim: 1,
        fade: 0,
        mask: false,
        angle: 90,
        width: 8.5,
      },
      colors: {
        card: "#fffdf4",
        info: "#3b82f6",
        ring: "#116a92",
        input: "#e0d9c0",
        muted: "#efe9d6",
        accent: "#e7f1e4",
        border: "#e0d9c0",
        popover: "#fffdf4",
        primary: "#116a92",
        success: "#166534",
        warning: "#8a5200",
        secondary: "#f3edc8",
        background: "#f6f3e7",
        foreground: "#33332f",
        destructive: "#a3425b",
        "card-foreground": "#33332f",
        "muted-foreground": "#706952",
        "accent-foreground": "#33613f",
        "popover-foreground": "#33332f",
        "primary-foreground": "#ffffff",
        "secondary-foreground": "#6d4a0f",
        "destructive-foreground": "#ffffff",
      },
      radius: "sm",
      shadows: {
        s1: {
          x: 0,
          y: 1,
          blur: 2,
          alpha: 0.1,
          color: "#786428",
          spread: 0,
        },
        s2: {
          x: 0,
          y: 4,
          blur: 12,
          alpha: 0.14,
          color: "#786428",
          spread: 0,
        },
        s3: {
          x: 0,
          y: 12,
          blur: 32,
          alpha: 0.2,
          color: "#786428",
          spread: 0,
        },
      },
      displayFont: "songti",
      brandGradient: {
        to: "#efe9b5",
        from: "#9bcba5",
        angle: 120,
      },
    },
  },
  surfaces: {
    auth: {
      light: {
        fill: {
          type: "solid",
          color: "#f6f3e7",
        },
      },
    },
    page: {
      light: {
        fill: {
          type: "solid",
          color: "#f6f3e7",
        },
      },
    },
    footer: {
      light: {
        fill: PALE_GOLD_FILL,
        text: {
          link: "#116a92",
          muted: "#706952",
          primary: "#33332f",
        },
        border: PALE_GOLD_BORDER,
      },
    },
    header: {
      light: {
        blur: 0,
        fill: PALE_GOLD_FILL,
        border: PALE_GOLD_BORDER,
      },
    },
    tabbar: {
      light: {
        blur: 0,
        fill: PALE_GOLD_FILL,
        border: PALE_GOLD_BORDER,
      },
    },
    "forum-band": {
      light: {
        fill: {
          type: "solid",
          color: "#fffdf4",
        },
        overlay: {
          type: "solid",
          color: "#fffdf4",
          overlayOpacity: 0,
        },
      },
    },
    "banner-announce": {
      light: {
        fill: {
          type: "solid",
          color: "#f3edc8",
        },
        text: {
          link: "#116a92",
          muted: "#706952",
          primary: "#6d4a0f",
        },
      },
    },
  },
};
