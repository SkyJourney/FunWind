import type { MetadataRoute } from "next";
import { getSiteIdentity } from "@/lib/site-chrome";

/** robots（M10.6b）：后台/私信/个人设置等私有面不进索引；内容面交给 sitemap。站点地址可后台配置 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const siteUrl = (await getSiteIdentity()).url;
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/api/",
          "/files",
          "/login",
          "/register",
          "/forgot",
          "/messages",
          "/notifications",
          "/settings",
          "/submit",
          "/follows",
          "/points",
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
