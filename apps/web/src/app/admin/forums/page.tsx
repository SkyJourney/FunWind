import Link from "next/link";
import { FolderTree, MessageSquare, PencilLine, Trash2 } from "lucide-react";
import { forums, getWebDb } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listForumRows } from "@/lib/forums/admin";
import { ForumTree } from "@/lib/forums/forum-tree";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/empty-state";
import { createForumAction, deleteForumAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "板块管理" };

const ERR_TEXT: Record<string, string> = {
  not_found: "目标版块或父级不存在（可能已被删除），请刷新后重试。",
  cycle: "不能把版块移动到它自己或它的子版块之下。",
  has_children: "该版块还有子版块——先删除或迁移子版块，或将本版块归档。",
  has_threads: "该版块还有主题——请先迁移主题，或将本版块归档（不再出现在目录、不可发帖）。",
};

const READ_LABEL = { public: "公开", members: "会员", restricted: "受限" } as const;

const inputCls =
  "rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/**
 * 板块管理（M10.6a）：版块树列表 + 新建。编辑/前缀在 /admin/forums/[fid]。
 * 只做编辑入口：可见性判定引擎照旧（lib/authz），保存后服务端已失效权限快照。
 */
export default async function ForumsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; created?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const rows = await listForumRows();
  const counts = await getWebDb()
    .select({ id: forums.id, threadCount: forums.threadCount })
    .from(forums);
  const threadCount = new Map(counts.map((c) => [c.id, c.threadCount]));
  const childCount = new Map<number, number>();
  for (const r of rows) childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);

  const tree = new ForumTree(rows);
  const sp = await searchParams;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">板块管理</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          版块树与可见性（readPolicy 沿祖先链解析：inherit 取最近的非 inherit 祖先，全无则公开）。
          上目录（isListed）只影响首页与目录展示，权限不受影响；归档版块仍可读但不可发帖。
        </p>
      </header>

      {sp.err && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {ERR_TEXT[sp.err] ?? "操作失败，请重试。"}
        </p>
      )}

      {/* 新建 */}
      <Card>
        <CardContent className="pt-5">
          <form action={createForumAction} className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              名称
              <input
                name="name"
                required
                maxLength={100}
                placeholder="如：动画交流"
                className={`${inputCls} w-44`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              父级
              <select name="parentId" defaultValue="0" className={inputCls}>
                <option value="0">（顶级）</option>
                {tree.all().map((n) => (
                  <option key={n.id} value={n.id}>
                    {"　".repeat(n.depth - 1)}
                    {n.kind === "section" ? "［分区］" : ""}
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              类型
              <select name="kind" defaultValue="forum" className={inputCls}>
                <option value="forum">版块（可发帖）</option>
                <option value="section">分区（仅容器）</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              排序
              <input
                name="sortOrder"
                type="number"
                min={0}
                max={1000000}
                defaultValue={0}
                className={`${inputCls} w-24`}
              />
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-sm">
              <input type="checkbox" name="isListed" defaultChecked className="size-4" />
              上目录
            </label>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              创建
            </SubmitButton>
          </form>
        </CardContent>
      </Card>

      {/* 版块树 */}
      {rows.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title="还没有任何版块"
          description="用上方表单创建第一个分区或版块；前台目录与发帖入口会立即出现。"
        />
      ) : (
        <div className="space-y-2">
          {tree.all().map((n) => {
            const effective = tree.readPolicy(n.id);
            const deletable =
              (childCount.get(n.id) ?? 0) === 0 && (threadCount.get(n.id) ?? 0) === 0;
            return (
              <Card key={n.id}>
                <CardContent
                  data-testid={`forum-row-${n.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3"
                  style={{ paddingLeft: `${0.75 + (n.depth - 1) * 1.25}rem` }}
                >
                  {n.kind === "section" ? (
                    <FolderTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <Link
                    href={`/admin/forums/${n.id}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {n.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {n.kind === "section" ? "分区" : `版块 · ${threadCount.get(n.id) ?? 0} 主题`} ·
                    排序 {n.sortOrder} · #{n.id}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {READ_LABEL[effective.value]}
                    </span>
                    {n.readPolicy === "inherit" && (
                      <span className="text-muted-foreground">继承</span>
                    )}
                  </span>
                  {!n.isListed && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      不上目录
                    </span>
                  )}
                  {n.isArchived && (
                    <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
                      已归档
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <Link
                      href={`/admin/forums/${n.id}`}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs hover:bg-accent"
                    >
                      <PencilLine className="size-3" aria-hidden /> 编辑
                    </Link>
                    {deletable && (
                      <form action={deleteForumAction}>
                        <input type="hidden" name="fid" value={n.id} />
                        <ConfirmSubmit
                          title={`删除「${n.name}」？`}
                          description="该版块为空（无主题、无子版块），删除后不可恢复。"
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs text-destructive hover:bg-destructive/10"
                          pendingText="…"
                        >
                          <Trash2 className="size-3" aria-hidden /> 删除
                        </ConfirmSubmit>
                      </form>
                    )}
                  </span>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
