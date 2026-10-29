import { and, eq, inArray, or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import { getModeratedForumIds, getReadableForumIds } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";

/**
 * 查询层的可见性范围：把“这个访客能看到什么”在**取数之前**翻译成 SQL 谓词，
 * 而不是取出来再逐行过滤——受限版块的标题、计数、置顶、最新动态因此根本不会进入结果集（P0 泄露的修法）。
 * 语义与 evaluator.contentVisibleTo 一致（docs/DESIGN-MODEL.md §4）：
 *   visible            → 版块可读即可见
 *   pending / rejected → 作者本人 + 持有 forum.moderate 的版块
 *   hidden / deleted   → 仅持有 forum.moderate 的版块
 */

export interface ViewerScope {
  userId: number | null;
  /** 可读版块 id */
  readable: number[];
  /** 持有 forum.moderate 的版块 id（可见非公开状态内容的范围） */
  moderated: number[];
}

export async function buildViewerScope(viewer: Subject): Promise<ViewerScope> {
  const [readable, moderated] = await Promise.all([
    getReadableForumIds(viewer),
    getModeratedForumIds(viewer),
  ]);
  return { userId: viewer.userId, readable, moderated };
}

/** 谓词作用的列：主题表与帖子表（经 join 主题表取版块）共用同一个构造 */
export interface ScopeColumns {
  forumId: AnyColumn;
  state: AnyColumn;
  authorId: AnyColumn;
}

/** 永假谓词：可读版块为空（如全站只剩受限版块的游客）时用，避免拼出非法的 IN () */
export const NOTHING: SQL = sql`1 = 0`;

export function visiblePredicate(cols: ScopeColumns, scope: ViewerScope): SQL {
  if (scope.readable.length === 0) return NOTHING;
  const visibleToMe: SQL[] = [eq(cols.state, "visible")];
  if (scope.userId !== null) {
    visibleToMe.push(
      and(
        eq(cols.authorId, scope.userId),
        // disabled 也对作者可见（M9.5 拍板 B：作者知情才能申诉——渲染层给封禁理由横幅）
        inArray(cols.state, ["pending", "rejected", "disabled"]),
      )!,
    );
  }
  if (scope.moderated.length > 0) {
    visibleToMe.push(
      and(
        inArray(cols.forumId, scope.moderated),
        inArray(cols.state, ["pending", "rejected", "hidden", "deleted", "disabled"]),
      )!,
    );
  }
  return and(inArray(cols.forumId, scope.readable), or(...visibleToMe))!;
}
