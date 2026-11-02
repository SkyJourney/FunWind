import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getDecorPoolRaw } from "@/lib/brand/decor-pool";
import { DECOR_MAX_BYTES, DECOR_MAX_HEIGHT, DECOR_MAX_WIDTH } from "@/lib/brand/decor-pool-fs";
import { getDecorUsage } from "@/lib/theme/packs";
import { BrandPoolAdmin, type BrandPoolSearchParams } from "@/components/admin/brand-pool-admin";
import { removeDecorAction, setActiveDecorAction, uploadDecorAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "主题素材" };

const ERR_TEXT: Record<string, string> = {
  forbidden: "没有权限。",
  bad_type: "仅支持 PNG（文件魔数校验）。",
  too_large: "文件超过 4MB——请压缩后重试（页内选择文件时会即时校验）。",
  oversize: `图片像素超过 ${DECOR_MAX_WIDTH}×${DECOR_MAX_HEIGHT}——请缩放后重试。`,
  "in-use": "素材仍被主题包引用，不能移除；请先在主题包中解除引用。",
};

/**
 * 主题装饰素材管理（M11.1 Step 4/7）：主题包可引用的背景/底纹/装饰图素材池。
 * 当前项经 /brand/decor 公开输出，主题包按 poolFile 引用；卡片徽标展示引用去向；门禁 site.admin。
 */
export default async function DecorAdminPage(props: {
  searchParams: Promise<BrandPoolSearchParams>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const sp = await props.searchParams;
  const [pool, usage] = await Promise.all([getDecorPoolRaw(), getDecorUsage()]);
  return (
    <BrandPoolAdmin
      title="主题素材"
      description={
        <>
          主题包可引用的背景 / 底纹 / 装饰图；素材经{" "}
          <code className="rounded bg-muted px-1 text-xs">/brand/decor</code> 公开输出， 切换最多 5
          分钟收敛。PNG ≤4MB、≤{DECOR_MAX_WIDTH}×{DECOR_MAX_HEIGHT}。也可在
          <Link href="/admin/themes" className="text-primary underline">
            主题管理
          </Link>
          的编辑区直接上传与选用。
        </>
      }
      pool={pool}
      basePath="/admin/decor"
      previewPath="/brand/decor"
      previewClassName="h-14 w-32 object-cover"
      maxBytes={DECOR_MAX_BYTES}
      fileHint={`建议 ${DECOR_MAX_WIDTH}×${DECOR_MAX_HEIGHT} 内的宽幅底纹`}
      namePlaceholder="如：宣纸底纹"
      errText={ERR_TEXT}
      emptyText="池还是空的——上传第一张素材；为空时主题包只能用纯色与渐变背景。"
      removeTitle="移除这张素材？"
      removeDescription="被主题包引用的素材会阻止移除；请先在主题包中解除引用。未被引用时，文件会移出池并保留在服务器磁盘。"
      itemBadge={(item) => {
        const refs = usage.get(item.file);
        if (!refs?.length) return null;
        const label = refs
          .map((ref) => `${ref.packName}（${ref.surfaceIds.join("、")}）`)
          .join("、");
        return (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={label}>
            被 {refs.length} 个主题引用：{label}
          </p>
        );
      }}
      sp={sp}
      actions={{
        upload: uploadDecorAction,
        setActive: setActiveDecorAction,
        remove: removeDecorAction,
      }}
    />
  );
}
