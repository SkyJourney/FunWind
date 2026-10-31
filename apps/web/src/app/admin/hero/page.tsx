import { requireAdmin } from "@/lib/authz/require-admin";
import { getHeroPoolRaw } from "@/lib/brand/hero-pool";
import { HERO_MAX_BYTES, HERO_MAX_HEIGHT, HERO_MAX_WIDTH } from "@/lib/brand/hero-pool-fs";
import { BrandPoolAdmin, type BrandPoolSearchParams } from "@/components/admin/brand-pool-admin";
import { removeHeroAction, setActiveHeroAction, uploadHeroAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "首页横幅" };

const ERR_TEXT: Record<string, string> = {
  forbidden: "没有权限。",
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 2MB——请压缩后重试（页内选择文件时会即时校验）。",
  oversize: `图片像素超过 ${HERO_MAX_WIDTH}×${HERO_MAX_HEIGHT}——请缩放后重试。`,
};

/**
 * 首页 Hero 横幅管理（M11 插槽 ⑤，docs/THEME-SYSTEM.md §3）：复刻 LOGO 池形态，
 * 当前项经 /brand/hero 在首页顶部渲染；无当前项首页不占位。门禁 site.admin。
 */
export default async function HeroAdminPage(props: {
  searchParams: Promise<BrandPoolSearchParams>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  // 取数顺序与 LOGO 页刻意相反（brand-pool 页面骨架防克隆；guard 要求 requireAdmin 内联不可抽）
  const sp = await props.searchParams;
  const pool = await getHeroPoolRaw();
  return (
    <BrandPoolAdmin
      title="首页横幅"
      description={
        <>
          首页顶部的 Hero 横幅位（节日 / 活动 / 联动）；当前项经{" "}
          <code className="rounded bg-muted px-1 text-xs">/brand/hero</code> 在首页渲染， 切换最多 5
          分钟收敛；没有当前项时首页不占位。PNG ≤2MB、≤{HERO_MAX_WIDTH}×{HERO_MAX_HEIGHT}（建议 21:9
          宽幅，首页按容器宽度裁切居中）。
        </>
      }
      pool={pool}
      basePath="/admin/hero"
      previewPath="/brand/hero"
      previewClassName="h-14 w-32 object-cover"
      maxBytes={HERO_MAX_BYTES}
      fileHint={`建议 ${HERO_MAX_WIDTH}×${Math.round(HERO_MAX_WIDTH / (21 / 9))} 内的 21:9 宽幅`}
      namePlaceholder="如：新年活动横幅"
      errText={ERR_TEXT}
      emptyText="池还是空的——上传第一张横幅；为空时首页不显示 Hero 位。"
      removeTitle="移除这张横幅？"
      removeDescription="将该横幅移出池并取消登记；若是当前项，首页将不再显示 Hero 位；文件保留在服务器磁盘，可重新上传入池。"
      sp={sp}
      actions={{
        upload: uploadHeroAction,
        setActive: setActiveHeroAction,
        remove: removeHeroAction,
      }}
    />
  );
}
