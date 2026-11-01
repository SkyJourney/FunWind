import type { MetadataRoute } from "next";
import { getSiteChrome } from "@/lib/site-chrome";

/** PWA manifest：站点身份跟随后台配置；图标来自当前品牌「清爽侦探」青色半翼。 */
export const dynamic = "force-dynamic";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const chrome = await getSiteChrome();
  const qy2010 = chrome.themePack === "qy2010";
  return {
    id: "/",
    name: chrome.identity.name,
    short_name: chrome.identity.name.slice(0, 12),
    description: chrome.identity.tagline || "青翼字幕组社区",
    lang: "zh-CN",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: qy2010 ? "#f6f3e7" : "#f8fafc",
    theme_color: qy2010 ? "#147ba9" : "#0e7490",
    categories: ["social", "entertainment"],
    icons: [
      { src: "/brand/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/brand/pwa-icon/maskable-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
