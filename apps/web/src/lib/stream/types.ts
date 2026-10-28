import type { HomeFeedItem } from "@/lib/queries/threads";

/**
 * 首页内容流的追加条目：在 HomeFeedItem 上补板块名，客户端追加渲染时不必再取版块树。
 * 单独成文件而不放在 route.ts：Next 的 route 文件只允许导出固定名字（HTTP 方法与路由配置）。
 */
export type HomeStreamItem = HomeFeedItem & { forumName: string | null };
