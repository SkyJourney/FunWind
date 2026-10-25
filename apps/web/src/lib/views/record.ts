/**
 * 记录一次主题阅读（M6.5b）。规则：
 *  · 主题必须对观众可见且状态为 visible（隐藏 / 待审 / 删除的主题不计，哪怕版主看得到）；
 *  · 作者本人访问不计；
 *  · 同一访客 30 分钟内只计一次（ViewDedupe）；
 *  · 计数进入进程内队列，由 ViewCounter 批量写库。
 * 本函数不返回主题是否存在：调用方对外一律 204（不泄露可见性）。
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getWebDb, threads } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { buildViewerScope, visiblePredicate } from "@/lib/queries/visibility";
import { ViewCounter, type ViewDelta } from "./counter";
import { ViewDedupe } from "./dedupe";

export type RecordResult = "counted" | "deduped" | "skipped";

const FLUSH_MS = 10_000;

/** 进程内单例（挂在 globalThis，避免开发模式热更新时产生多个定时器） */
const g = globalThis as unknown as { __fwViews?: { counter: ViewCounter; dedupe: ViewDedupe } };

async function writeDeltas(rows: ViewDelta[]): Promise<void> {
  if (rows.length === 0) return;
  await getWebDb().transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .update(threads)
        .set({ viewCount: sql`${threads.viewCount} + ${r.count}` })
        .where(and(eq(threads.id, r.threadId), eq(threads.state, "visible")));
    }
  });
}

export function viewRuntime(): { counter: ViewCounter; dedupe: ViewDedupe } {
  if (!g.__fwViews) {
    const counter = new ViewCounter(writeDeltas);
    const timer = setInterval(() => {
      counter.flush().catch((e) => console.error("[views] 批量写入失败，下一轮重试", e));
    }, FLUSH_MS);
    (timer as { unref?: () => void }).unref?.();
    g.__fwViews = { counter, dedupe: new ViewDedupe() };
  }
  return g.__fwViews;
}

/** 访客标识：登录用户按账号；游客按 IP（取不到时按 UA），哈希后入内存 */
export function visitorKey(
  userId: number | null,
  ip: string | null,
  userAgent: string | null,
): string {
  if (userId !== null) return `u:${userId}`;
  const basis = ip ?? `ua:${userAgent ?? ""}`;
  return `g:${createHash("sha256").update(basis).digest("hex").slice(0, 32)}`;
}

export async function recordThreadView(input: {
  subject: Subject;
  threadId: number;
  ip: string | null;
  userAgent: string | null;
  now?: number;
}): Promise<RecordResult> {
  const { subject, threadId } = input;
  const scope = await buildViewerScope(subject);
  const [row] = await getWebDb()
    .select({ authorId: threads.authorId })
    .from(threads)
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.state, "visible"),
        visiblePredicate(
          { forumId: threads.forumId, state: threads.state, authorId: threads.authorId },
          scope,
        ),
      ),
    )
    .limit(1);
  if (!row) return "skipped";
  if (subject.userId !== null && subject.userId === row.authorId) return "skipped";

  const { counter, dedupe } = viewRuntime();
  const key = `${threadId}:${visitorKey(subject.userId, input.ip, input.userAgent)}`;
  if (!dedupe.admit(key, input.now ?? Date.now())) return "deduped";
  counter.add(threadId);
  return "counted";
}
