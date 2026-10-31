import { requireAdmin } from "@/lib/authz/require-admin";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { LOGO_MAX_BYTES } from "@/lib/brand/logo-pool-fs";
import { isPackValue, packLabel } from "@/lib/theme-packs";
import { BrandPoolAdmin, type BrandPoolSearchParams } from "@/components/admin/brand-pool-admin";
import { removeLogoAction, setActiveLogoAction, uploadLogoAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "LOGO 管理" };

const ERR_TEXT: Record<string, string> = {
  forbidden: "没有权限。",
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 512KB——请压缩后重试（页内选择文件时会即时校验）。",
};

/**
 * LOGO 管理（M10.5，docs/LOGO-POOL.md）：池网格 + 上传 + 设为当前/移除（页面本体由 BrandPoolAdmin 承担，M11 泛化）。
 * 门禁 site.admin（站点级配置语义，复用总开关权限点，不新增词汇表）。
 */
export default async function LogoAdminPage(props: {
  searchParams: Promise<BrandPoolSearchParams>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  // 取数顺序与 Hero 页刻意相反（brand-pool 页面骨架防克隆；guard 要求 requireAdmin 内联不可抽）
  const pool = await getLogoPoolRaw();
  const sp = await props.searchParams;
  return (
    <BrandPoolAdmin
      title="LOGO 管理"
      description={
        <>
          品牌池随时切换（节日 / 联动主题日）；当前项经{" "}
          <code className="rounded bg-muted px-1 text-xs">/brand/logo</code> 全站输出，切换最多 5
          分钟收敛。PNG ≤512KB（选择文件时即时校验，超限会被清空重选）。 主题包自带的 LOGO
          在设为全站默认主题时自动入池（带「自带」徽标），之后仍可在这里独立切换。
        </>
      }
      pool={pool}
      basePath="/admin/logo"
      previewPath="/brand/logo"
      previewClassName="size-14 object-contain"
      maxBytes={LOGO_MAX_BYTES}
      fileHint="建议 224×224 内"
      namePlaceholder="如：圣诞节版"
      errText={ERR_TEXT}
      emptyText="池还是空的——上传第一枚 LOGO；为空时前台显示占位图标。"
      removeTitle="移除这枚 LOGO？"
      removeDescription="将该 LOGO 移出池并取消登记；不影响当前生效的 LOGO 展示，文件保留在服务器磁盘，可重新上传入池。"
      itemBadge={(item) =>
        // 主题包自带 LOGO（M11 联动入池）：移除后再次设该主题为默认会重新导入
        item.pack ? (
          <p className="mt-0.5 text-xs">
            <span className="rounded bg-accent px-1 text-accent-foreground">
              {isPackValue(item.pack) ? packLabel(item.pack) : item.pack} 自带
            </span>
          </p>
        ) : null
      }
      sp={sp}
      actions={{
        upload: uploadLogoAction,
        setActive: setActiveLogoAction,
        remove: removeLogoAction,
      }}
    />
  );
}
