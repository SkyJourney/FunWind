import { decorUrl } from "@/lib/theme/decor-url";
import type { SurfaceCapabilities } from "@/lib/theme/surface-schema";

/** 按真实前台组件结构渲染的 Surface 预览体（消费与实站相同的 --sf-* 变量） */
export function ThemeSurfaceMock({
  surface,
  label,
  caps,
}: {
  surface: string;
  label: string;
  caps: SurfaceCapabilities;
}) {
  const hideText = caps.contentSlot?.hideText === true;
  switch (surface) {
    case "header":
      return (
        <div className="flex h-14 items-center gap-3 px-4">
          <span aria-hidden className="size-6 rounded bg-current/20" />
          <span className="text-sm font-semibold" style={{ opacity: hideText ? 0 : 1 }}>
            青翼字幕组
          </span>
          <nav aria-hidden className="ml-4 hidden gap-2 text-xs opacity-70 sm:flex">
            <span>首页</span>
            <span>板块</span>
            <span>动态</span>
          </nav>
          <span aria-hidden className="ml-auto size-6 rounded-full bg-current/15" />
        </div>
      );
    case "banner-announce":
      return (
        <div className="flex items-center justify-center gap-2 px-4 py-2 text-xs">
          <span style={{ opacity: hideText ? 0 : 1 }}>📢 欢迎来到 FunWind</span>
          <span aria-hidden className="ml-2 size-3 rounded-full bg-current/25" />
        </div>
      );
    case "forum-band":
      return (
        <div className="flex gap-3 p-3">
          <div
            aria-hidden={caps.fill?.type !== "image"}
            className="relative w-24 shrink-0 overflow-hidden rounded-md bg-cover bg-center"
            style={{
              backgroundImage: caps.fill?.type === "image" ? undefined : "var(--sf-forum-band-bg)",
              aspectRatio: "4 / 3",
            }}
          >
            {caps.fill?.type === "image" ? (
              // 图片底纹用真实 <img>：能直接验证取图链路（naturalWidth > 0），而不是只看 CSS 变量
              // eslint-disable-next-line @next/next/no-img-element -- 素材池公开路由缩略图
              <img
                src={decorUrl(caps.fill.asset)}
                alt=""
                className="size-full object-cover"
                data-testid="theme-preview-image"
              />
            ) : (
              <span className="grid h-full place-items-center text-2xl font-bold opacity-20">
                翼
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1 py-1">
            <p className="truncate text-sm font-medium" style={{ opacity: hideText ? 0 : 1 }}>
              『演示区』板块卡片
            </p>
            <p
              className="mt-1 line-clamp-2 text-xs opacity-70"
              style={{ opacity: hideText ? 0 : undefined }}
            >
              左侧图区铺底纹，右侧文字区随主题换色。
            </p>
          </div>
        </div>
      );
    case "hero-brand":
      return (
        <div className="flex flex-col items-center gap-2 p-5 text-center">
          <span aria-hidden className="size-16 rounded-xl bg-current/15" />
          <span className="text-base font-bold" style={{ opacity: hideText ? 0 : 1 }}>
            青翼字幕组
          </span>
          <span className="text-xs opacity-70" style={{ opacity: hideText ? 0 : undefined }}>
            日语·ACG 情怀社区
          </span>
        </div>
      );
    case "hero-image":
      return (
        <div className="p-3">
          <div
            role="img"
            aria-label={`${label}装饰图片预览`}
            className="rounded-lg bg-cover bg-center"
            style={{
              backgroundImage: caps.contentSlot?.image
                ? `var(--sf-hero-image-content-image)`
                : undefined,
              height: `var(--sf-hero-image-content-image-height, 120px)`,
              backgroundColor: caps.contentSlot?.image ? undefined : "rgb(0 0 0 / 0.08)",
            }}
          >
            {!caps.contentSlot?.image && (
              <p className="grid h-full place-items-center text-xs opacity-60">
                在素材库选择内容图后这里显示
              </p>
            )}
          </div>
        </div>
      );
    case "tabbar":
      return (
        <div className="flex h-12 items-stretch border-t border-current/15 text-[10px]">
          {["首页", "板块", "发帖", "消息"].map((tab, index) => (
            <span
              key={tab}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 ${
                index === 0 ? "font-medium" : "opacity-70"
              }`}
            >
              <span aria-hidden className="size-3.5 rounded bg-current/25" />
              {tab}
            </span>
          ))}
        </div>
      );
    case "footer":
      return (
        <div className="space-y-2 px-5 py-4 text-xs">
          <p
            className="flex flex-wrap gap-3 opacity-90"
            style={{ opacity: hideText ? 0 : undefined }}
          >
            <span className="font-medium">友情链接</span>
            <span className="underline">旧站档案馆</span>
            <span className="underline">字幕组百科</span>
          </p>
          <p className="opacity-60" style={{ opacity: hideText ? 0 : undefined }}>
            © 青翼字幕组 · 页脚文字随主题换色
          </p>
        </div>
      );
    case "auth":
      return (
        <div className="p-4">
          <div className="rounded-lg border border-current/15 bg-background/40 p-4">
            <p className="text-center text-sm font-semibold" style={{ opacity: hideText ? 0 : 1 }}>
              登录
            </p>
            <div aria-hidden className="mt-3 space-y-2">
              <span className="block h-7 rounded border border-current/20" />
              <span className="block h-7 rounded border border-current/20" />
              <span className="block h-7 rounded bg-current/25" />
            </div>
          </div>
        </div>
      );
    default:
      return (
        <div className="space-y-3 p-4">
          <p className="text-xs opacity-70">{label} · 全局背景预览</p>
          <div aria-hidden className="h-16 rounded-lg border border-current/15 bg-current/5" />
          <div aria-hidden className="h-16 rounded-lg border border-current/15 bg-current/5" />
        </div>
      );
  }
}
