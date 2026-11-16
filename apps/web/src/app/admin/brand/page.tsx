import { requireAdmin } from "@/lib/authz/require-admin";
import { getHeroPoolRaw } from "@/lib/brand/hero-pool";
import { HERO_MAX_BYTES, HERO_MAX_HEIGHT, HERO_MAX_WIDTH } from "@/lib/brand/hero-pool-fs";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { LOGO_MAX_BYTES } from "@/lib/brand/logo-pool-fs";
import { listThemePacks } from "@/lib/theme/packs";
import { AdminTabs, type AdminTab } from "@/components/admin/admin-tabs";
import {
  BrandPoolAdmin,
  type BrandPoolAdminProps,
  type BrandPoolSearchParams,
} from "@/components/admin/brand-pool-admin";
import type { BrandItem, BrandPool } from "@/lib/brand/brand-pool";
import { removeHeroAction, setActiveHeroAction, uploadHeroAction } from "@/app/admin/hero/actions";
import { removeLogoAction, setActiveLogoAction, uploadLogoAction } from "@/app/admin/logo/actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "品牌素材" };

/**
 * 品牌素材（M19 Q2 合并：LOGO 池 + 首页横幅池 → 单页 ?kind= 页签；decor 主题素材维持主题编辑器内的
 * 二级页——站长拍板 906dd710，不进本页）。两类池共用 BrandPoolAdmin，差异全部是配置注入：
 * 取数、限额、文案与徽标。门禁 site.admin（站点级配置语义，复用总开关权限点，不新增词汇表）。
 * 旧路由 /admin/logo、/admin/hero 保留永久跳转。
 */

type BrandKind = "logo" | "hero";

/** kind → BrandPoolAdmin 配置（原 logo/page.tsx 与 hero/page.tsx 的差异点全部收编于此） */
async function brandKindConfig(kind: BrandKind): Promise<{
  config: Omit<BrandPoolAdminProps, "pool" | "sp" | "actions" | "itemBadge"> & {
    itemBadge?: (item: BrandItem) => React.ReactNode;
  };
  load: () => Promise<BrandPool>;
  actions: BrandPoolAdminProps["actions"];
}> {
  if (kind === "hero") {
    return {
      load: getHeroPoolRaw,
      actions: {
        upload: uploadHeroAction,
        setActive: setActiveHeroAction,
        remove: removeHeroAction,
      },
      config: {
        title: "首页横幅",
        description: (
          <>
            首页顶部的 Hero 横幅位（节日 / 活动 / 联动）；当前项经{" "}
            <code className="rounded bg-muted px-1 text-xs">/brand/hero</code> 在首页渲染， 切换最多
            5 分钟收敛；没有当前项时首页不占位。PNG ≤2MB、≤{HERO_MAX_WIDTH}×{HERO_MAX_HEIGHT}
            （建议 21:9 宽幅，首页按容器宽度裁切居中）。
          </>
        ),
        basePath: "/admin/brand?kind=hero",
        previewPath: "/brand/hero",
        previewClassName: "h-14 w-32 object-cover",
        maxBytes: HERO_MAX_BYTES,
        fileHint: `建议 ${HERO_MAX_WIDTH}×${Math.round(HERO_MAX_WIDTH / (21 / 9))} 内的 21:9 宽幅`,
        namePlaceholder: "如：新年活动横幅",
        errText: {
          forbidden: "没有权限。",
          bad_type: "仅支持 PNG（文件魔数校验）。",
          too_large: "文件超过 2MB——请压缩后重试（页内选择文件时会即时校验）。",
          oversize: `图片像素超过 ${HERO_MAX_WIDTH}×${HERO_MAX_HEIGHT}——请缩放后重试。`,
        },
        emptyText: "池还是空的——上传第一张横幅；为空时首页不显示 Hero 位。",
        removeTitle: "移除这张横幅？",
        removeDescription:
          "将该横幅移出池并取消登记；若是当前项，首页将不再显示 Hero 位；文件保留在服务器磁盘，可重新上传入池。",
      },
    };
  }
  // logo（默认）：构建包名映射（用于徽标显示；包含停用包）
  const packs = await listThemePacks();
  const packNames = new Map(packs.map((p) => [p.id, p.name]));
  return {
    load: getLogoPoolRaw,
    actions: {
      upload: uploadLogoAction,
      setActive: setActiveLogoAction,
      remove: removeLogoAction,
    },
    config: {
      title: "LOGO 管理",
      description: (
        <>
          品牌池随时切换（节日 / 联动主题日）；当前项经{" "}
          <code className="rounded bg-muted px-1 text-xs">/brand/logo</code> 全站输出，切换最多 5
          分钟收敛。PNG ≤512KB（选择文件时即时校验，超限会被清空重选）。 主题包自带的 LOGO
          在设为全站默认主题时自动入池（带「自带」徽标），之后仍可在这里独立切换。
        </>
      ),
      basePath: "/admin/brand?kind=logo",
      previewPath: "/brand/logo",
      previewClassName: "size-14 object-contain",
      maxBytes: LOGO_MAX_BYTES,
      fileHint: "建议 224×224 内",
      namePlaceholder: "如：圣诞节版",
      errText: {
        forbidden: "没有权限。",
        bad_type: "仅支持 PNG（文件魔数校验）。",
        too_large: "文件超过 512KB——请压缩后重试（页内选择文件时会即时校验）。",
      },
      emptyText: "池还是空的——上传第一枚 LOGO；为空时前台显示占位图标。",
      removeTitle: "移除这枚 LOGO？",
      removeDescription:
        "将该 LOGO 移出池并取消登记；不影响当前生效的 LOGO 展示，文件保留在服务器磁盘，可重新上传入池。",
      itemBadge: (item) =>
        // 主题包自带 LOGO（M11 联动入池）：移除后再次设该主题为默认会重新导入
        item.pack ? (
          <p className="mt-0.5 text-xs">
            <span className="rounded bg-accent px-1 text-accent-foreground">
              {packNames.get(item.pack) ?? item.pack} 自带
            </span>
          </p>
        ) : null,
    },
  };
}

export default async function BrandAdminPage(props: {
  searchParams: Promise<BrandPoolSearchParams & { kind?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const sp = await props.searchParams;
  const kind: BrandKind = sp.kind === "hero" ? "hero" : "logo";
  const { config, load, actions } = await brandKindConfig(kind);
  const pool = await load();

  const kindTabs: AdminTab[] = [
    { key: "logo", label: "LOGO", href: "/admin/brand?kind=logo" },
    { key: "hero", label: "首页横幅", href: "/admin/brand?kind=hero" },
  ];

  return (
    <div className="space-y-4">
      <AdminTabs label="素材类型" activeKey={kind} tabs={kindTabs} />
      <BrandPoolAdmin {...config} pool={pool} sp={sp} actions={actions} />
    </div>
  );
}
