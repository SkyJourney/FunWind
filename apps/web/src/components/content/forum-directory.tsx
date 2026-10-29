import Link from "next/link";
import type { Directory } from "@/lib/queries/forums";

/**
 * 版块目录（首页与 /boards 共用）：分区 → 卡片网格。
 * 数据在查询层已按访客权限过滤，这里不做权限判断。
 *
 * 板块卡片形态（M9.5 §3.4.4 站长定稿）：左侧图区铺板块图，遮罩向右渐隐（105deg 斜切梯形），
 * 文本区右移让出展示空间；无图板块用同参数纯渐变 + 板块名首字符水印。
 * 遮罩插槽参数集（M11 主题插槽骨架）：主题包只改下面这组 CSS 变量即可换
 * 遮罩方向/斜率/渐隐宽度/透明度/不遮罩——.forum-card-band 类消费这些变量，此处不定死样式。
 */
const BAND_STYLE_VARS = {
  "--band-width": "7rem",
  "--band-angle": "105deg",
  "--band-fade": "38%",
  "--band-mask-color": "var(--card)",
  "--band-dim-opacity": "0.85",
} as const;

export function ForumDirectory({ dir }: { dir: Directory }) {
  return (
    <section className="space-y-6">
      {dir.groups.map(({ section, forums }) => (
        <div key={section?.id ?? "loose"}>
          {section && (
            <h2 className="mb-2 border-b pb-1 text-base font-semibold text-foreground/90">
              {section.name}
            </h2>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {forums.map((forum) => (
              <div
                key={forum.id}
                className="forum-card-band relative flex overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/40"
                style={BAND_STYLE_VARS as React.CSSProperties}
              >
                {/* 左图区：板块图（cover）或首字符水印，右缘由遮罩渐隐（.forum-card-band 的全局样式） */}
                <div className="forum-card-band__img relative w-[var(--band-width)] shrink-0">
                  {forum.iconKey ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/files/${forum.iconKey}`}
                      alt=""
                      className="absolute inset-0 h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <>
                      <div
                        aria-hidden
                        className="absolute inset-0 bg-gradient-to-br from-primary/15 via-accent/20 to-secondary/30"
                      />
                      <span
                        aria-hidden
                        className="absolute inset-0 grid place-items-center text-3xl font-bold text-foreground/15 select-none"
                      >
                        {forum.name.slice(0, 1)}
                      </span>
                    </>
                  )}
                </div>

                {/* 文本区：右移的 padding 让出图区；内容纵向排布 */}
                <div className="min-w-0 flex-1 p-4 pl-4">
                  <Link
                    href={`/f/${forum.id}`}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    {forum.name}
                  </Link>
                  {forum.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {forum.description}
                    </p>
                  )}
                  <div className="mt-2 text-xs text-muted-foreground">
                    主题 {forum.threadCount}
                    {forum.subs.length > 0 && (
                      <span className="ml-3 inline-flex flex-wrap gap-x-2">
                        {forum.subs.map((s) => (
                          <Link key={s.id} href={`/f/${s.id}`} className="hover:text-primary">
                            ↳ {s.name}
                          </Link>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
