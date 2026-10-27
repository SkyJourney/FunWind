import type { MetadataRoute } from "next";
import { APP_URL } from "@/lib/site";

/** robots（M10.6b）：后台/私信/个人设置等私有面不进索引；内容面交给 sitemap */
export default function robots(): MetadataRoute.Robots {
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
    sitemap: `${APP_URL}/sitemap.xml`,
  };
}
