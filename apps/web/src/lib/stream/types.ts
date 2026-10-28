import type { HomeFeedItem } from "@/lib/queries/threads";
import type { UserReplyItem } from "@/lib/queries/users";

/**
 * 首页内容流的追加条目：在 HomeFeedItem 上补板块名，客户端追加渲染时不必再取版块树。
 * 单独成文件而不放在 route.ts：Next 的 route 文件只允许导出固定名字（HTTP 方法与路由配置）。
 */
export type HomeStreamItem = HomeFeedItem & { forumName: string | null };

/** 用户回复流的追加条目：以 postId 作为流的去重主键 id（StreamList 约定条目有数字 id） */
export type UserReplyStreamItem = UserReplyItem & { id: number };
