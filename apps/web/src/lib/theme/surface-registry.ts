/** Surface 区域注册表：纯静态白名单，可安全供客户端渲染器使用。 */
export const SURFACES = [
  {
    id: "header",
    label: "顶部导航",
    caps: ["fill", "overlay", "border", "blur", "text", "contentSlot"],
  },
  { id: "hero-brand", label: "首页品牌区", caps: ["fill", "overlay", "text", "contentSlot"] },
  { id: "banner-announce", label: "公告横幅", caps: ["fill", "text", "contentSlot"] },
  { id: "forum-band", label: "板块卡底纹", caps: ["fill", "overlay"] },
  { id: "hero-image", label: "首页 Hero 图", caps: ["contentSlot"] },
  { id: "tabbar", label: "底部 Tab", caps: ["fill", "blur", "border"] },
  { id: "footer", label: "页脚", caps: ["fill", "border", "text"] },
  { id: "auth", label: "登录/注册壳", caps: ["fill", "overlay"] },
  { id: "page", label: "全局页面背景", caps: ["fill"] },
] as const;

export type SurfaceId = (typeof SURFACES)[number]["id"];

export function isSurfaceId(value: string): value is SurfaceId {
  return SURFACES.some((surface) => surface.id === value);
}
