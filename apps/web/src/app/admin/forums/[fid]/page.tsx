import Link from "next/link";
import { ArrowLeft, Tag } from "lucide-react";
import { requireAdmin } from "@/lib/authz/require-admin";
import { listForumRows, listPrefixes } from "@/lib/forums/admin";
import { ForumTree } from "@/lib/forums/forum-tree";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { addPrefixAction, removePrefixAction, updateForumAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑版块" };

const ERR_TEXT: Record<string, string> = {
  not_found: "目标版块或父级不存在（可能已被删除），请刷新后重试。",
  cycle: "不能把版块移动到它自己或它的子版块之下。",
  has_children: "该版块还有子版块，不能删除。",
  has_threads: "该版块还有主题，不能删除——请先迁移主题或改为归档。",
};

const inputCls =
  "rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const selectCls = `${inputCls} w-full max-w-xs`;

const POLICY_OPTIONS = {
  readPolicy: [
    ["inherit", "继承（取最近祖先，全链继承=公开）"],
    ["public", "公开（含游客可读）"],
    ["members", "会员（登录可读）"],
    ["restricted", "受限（须版块作用域授权）"],
  ],
  writePolicy: [
    ["inherit", "继承（取最近祖先，全链继承=会员可发帖）"],
    ["members", "会员（登录并持 forum.write 即可）"],
    ["restricted", "受限（须本版块作用域 forum.write 授权）"],
  ],
  reviewPolicy: [
    ["inherit", "继承（取最近祖先，全链继承=不审核）"],
    ["none", "不审核"],
    ["threads", "新主题需审核"],
    ["all", "全部发帖需审核（持 forum.moderate 者免审）"],
  ],
} as const;

/**
 * 编辑版块（M10.6a）：元数据、三类策略、isListed/归档、父级迁移、版块前缀。
 * kind 创建后不可变（分区/版块语义转换不做）；父级迁移服务端做环检测与整棵子树 path/depth 重算。
 */
export default async function ForumEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ fid: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const { fid: fidRaw } = await params;
  const fid = Number(fidRaw);
  if (!Number.isInteger(fid) || fid < 1) notFound();

  const rows = await listForumRows();
  const row = rows.find((r) => r.id === fid);
  if (!row) notFound();
  const tree = new ForumTree(rows);
  const subtree = new Set(tree.subtree(fid));
  const prefixes = await listPrefixes(fid);
  const sp = await searchParams;
  const effective = tree.readPolicy(fid);

  return (
    <div className="space-y-5">
      <header>
        <Link
          href="/admin/forums"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> 返回板块管理
        </Link>
        <h2 className="mt-1 text-lg font-bold tracking-tight">编辑：{row.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          #{row.id} · {row.kind === "section" ? "分区" : "版块"} · 当前有效可见性：
          {effective.value === "public" ? "公开" : effective.value === "members" ? "会员" : "受限"}
          {effective.holderId !== null && effective.holderId !== fid && (
            <>（继承自 #{effective.holderId}）</>
          )}
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

      <Card>
        <CardContent className="pt-5">
          <form action={updateForumAction} className="grid gap-4">
            <input type="hidden" name="fid" value={fid} />
            <input type="hidden" name="kind" value={row.kind} />
            <input type="hidden" name="back" value={`/admin/forums/${fid}`} />

            <div className="flex flex-wrap gap-4">
              <label className="grid flex-1 gap-1 text-sm" style={{ minWidth: "14rem" }}>
                名称
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={row.name}
                  className={inputCls}
                />
              </label>
              <label className="grid gap-1 text-sm">
                排序
                <input
                  name="sortOrder"
                  type="number"
                  min={0}
                  max={1000000}
                  defaultValue={row.sortOrder}
                  className={`${inputCls} w-28`}
                />
              </label>
              <label className="grid gap-1 text-sm">
                父级
                <select name="parentId" defaultValue={row.parentId} className={selectCls}>
                  <option value="0">（顶级）</option>
                  {rows
                    .filter((r) => !subtree.has(r.id))
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {"　".repeat(r.depth - 1)}
                        {r.kind === "section" ? "［分区］" : ""}
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <label className="grid gap-1 text-sm">
              描述（版块页头展示）
              <textarea
                name="description"
                maxLength={2000}
                rows={2}
                defaultValue={row.description ?? ""}
                className={inputCls}
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-3">
              {(
                [
                  ["readPolicy", "可见性 readPolicy", row.readPolicy],
                  ["writePolicy", "写入策略 writePolicy", row.writePolicy],
                  ["reviewPolicy", "审核策略 reviewPolicy", row.reviewPolicy],
                ] as const
              ).map(([name, label, current]) => (
                <label key={name} className="grid gap-1 text-sm">
                  {label}
                  <select name={name} defaultValue={current} className={selectCls}>
                    {POLICY_OPTIONS[name].map(([v, text]) => (
                      <option key={v} value={v}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="isListed"
                  defaultChecked={row.isListed}
                  className="size-4"
                />
                出现在首页与目录
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="isArchived"
                  defaultChecked={row.isArchived}
                  className="size-4"
                />
                归档（可读、不可发帖）
              </label>
            </div>

            <div>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                保存
              </SubmitButton>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* 版块前缀 */}
      <Card>
        <CardContent className="pt-5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Tag className="size-4" aria-hidden /> 版块主题前缀
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            发帖时可选的标题前缀（如「转载」「求助」）；排序小的靠前。
          </p>
          {prefixes.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {prefixes.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-sm">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{p.name}</span>
                  <span className="text-xs text-muted-foreground">排序 {p.sortOrder}</span>
                  <form action={removePrefixAction} className="ml-auto">
                    <input type="hidden" name="fid" value={fid} />
                    <input type="hidden" name="prefixId" value={p.id} />
                    <ConfirmSubmit
                      title={`删除前缀「${p.name}」？`}
                      description="已有主题上保留的前缀文字不受影响，仅影响今后发帖的可选项。"
                      className="rounded-md border px-2 py-0.5 text-xs text-destructive hover:bg-destructive/10"
                      pendingText="…"
                    >
                      删除
                    </ConfirmSubmit>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form action={addPrefixAction} className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="fid" value={fid} />
            <label className="grid gap-1 text-sm">
              前缀名
              <input
                name="name"
                required
                maxLength={64}
                placeholder="如：转载"
                className={`${inputCls} w-36`}
              />
            </label>
            <label className="grid gap-1 text-sm">
              排序
              <input
                name="sortOrder"
                type="number"
                min={0}
                max={32767}
                defaultValue={0}
                className={`${inputCls} w-24`}
              />
            </label>
            <SubmitButton className="rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-60">
              添加前缀
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
