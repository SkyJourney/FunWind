import "server-only";

import { getSiteIdentity } from "@/lib/chrome/site-chrome";
import type { FeedScope } from "./query";

/** 订阅使用站点对外身份，拒绝无法安全构造规范链接的配置。 */
export async function getFeedSiteIdentity(): Promise<{ name: string; url: URL }> {
  const identity = await getSiteIdentity();
  const url = new URL(identity.url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("站点订阅地址无效");
  }
  return { name: identity.name, url };
}

export async function getFeedSiteUrl(): Promise<URL> {
  return (await getFeedSiteIdentity()).url;
}

/** 保留配置中的路径前缀，所有路由及主题链接使用同一站点地址。 */
function sitePath(site: URL, path: string): URL {
  return new URL(path, `${site.origin}${site.pathname.replace(/\/+$/, "")}/`);
}

export function getFeedUrls(
  site: URL,
  scope: FeedScope,
): { rss: string; atom: string; page: string } {
  const feedPath = scope.kind === "latest" ? "feeds/latest" : `feeds/forum/${scope.fid}`;
  const pagePath = scope.kind === "latest" ? "" : `f/${scope.fid}`;
  return {
    rss: sitePath(site, feedPath).href,
    atom: sitePath(site, `${feedPath}?format=atom`).href,
    page: sitePath(site, pagePath).href,
  };
}

export function getFeedThreadUrl(site: URL, tid: number): string {
  return sitePath(site, `t/${tid}`).href;
}
