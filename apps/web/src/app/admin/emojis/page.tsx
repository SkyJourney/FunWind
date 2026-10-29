import Link from "next/link";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { and, asc, eq, sql } from "drizzle-orm";
import { emojiGroups, emojis, getWebDb } from "@funwind/db";
import { requireAdmin } from "@/lib/authz/require-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { Pagination } from "@/components/content/pagination";
import {
  createGroupAction,
  deleteGroupAction,
  reorderGroupAction,
  toggleEmojiAction,
  toggleGroupAction,
  updateEmojiAction,
  uploadEmojiAction,
  uploadGroupIconAction,
  renameGroupAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "表情管理" };

type Params = {
  searchParams: Promise<Record<string, string | undefined>>;
};

/** 上传失败码 → 可读文案（码来自 lib/emoji/admin.ts 的拒绝分支） */
const UPLOAD_ERRORS: Record<string, string> = {
  empty: "文件内容为空",
  type: "格式不支持：表情只接受 PNG / GIF / WebP",
  undecodable: "无法解码图片（文件损坏或伪装）",
  size: "尺寸超限：上限 200×200 像素",
  bytes: "文件超限：上限 200KB",
};

const SAVED: Record<string, string> = {
  "group-created": "分组已创建。",
  "group-renamed": "分组已改名。",
  "group-toggled": "分组状态已更新。",
  "group-deleted": "分组已删除。",
  "group-moved": "分组顺序已更新。",
  "group-icon": "分组标题图已更新（面板分组标题旁即时生效）。",
  upload: "表情已上传（见成功计数；失败明细见下方提示）。",
  "emoji-renamed": "表情已更新。",
  "emoji-moved": "表情顺序已更新。",
  "emoji-toggled": "表情状态已更新。",
};

/**
 * 社区表情管理（M10.9）：分组（建 / 改名 / 排序 / 启停 / 删除）与表情（上传 / 改名 / 关键词 / 排序 / 停用）。
 * 停用而非物理删除：停用后从面板消失，已发布正文照常渲染；空组才可删。
 * 上限常量（≤200×200、≤200KB、png/gif/webp）在代码里，界面同样提示。
 */
export default async function AdminEmojisPage({ searchParams }: Params) {
  await requireAdmin("emoji.manage");
  const sp = await searchParams;
  const groupId = sp.group ? Number(sp.group) : null;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);
  const back = "/admin/emojis";

  const groups = await getWebDb()
    .select({
      id: emojiGroups.id,
      name: emojiGroups.name,
      sort: emojiGroups.sort,
      enabled: emojiGroups.enabled,
      iconKey: emojiGroups.iconKey,
      count: sql<number>`COUNT(${emojis.id})`,
    })
    .from(emojiGroups)
    .leftJoin(emojis, eq(emojis.groupId, emojiGroups.id))
    .groupBy(emojiGroups.id)
    .orderBy(asc(emojiGroups.sort), asc(emojiGroups.id));

  // 组内表情：关键词过滤 + 分页 20（M9.5）——原无上限全量渲染（500 枚 ≈ 2500 form 节点）
  const { selected, total, totalPages } = await (async () => {
    if (groupId === null || !Number.isInteger(groupId))
      return { selected: [], total: 0, totalPages: 1 };
    const perPage = 20;
    const conds = [eq(emojis.groupId, groupId)];
    if (q)
      conds.push(sql`(${emojis.name} LIKE ${`%${q}%`} OR ${emojis.keywords} LIKE ${`%${q}%`})`);
    const where = and(...conds);
    const [countRow, rows] = await Promise.all([
      getWebDb()
        .select({ n: sql<number>`COUNT(*)` })
        .from(emojis)
        .where(where),
      getWebDb()
        .select()
        .from(emojis)
        .where(where)
        .orderBy(asc(emojis.sort), asc(emojis.id))
        .limit(perPage)
        .offset((page - 1) * perPage),
    ]);
    return {
      selected: rows,
      total: Number(countRow[0]?.n ?? 0),
      totalPages: Math.max(1, Math.ceil(Number(countRow[0]?.n ?? 0) / perPage)),
    };
  })();

  const saved = sp.saved ? SAVED[sp.saved] : undefined;
  const failedList = typeof sp.failed === "string" && sp.failed ? sp.failed.split("|") : [];
  const failedMore = Number(sp.failedMore ?? "0") || 0;
  const uploadErr =
    sp.err && UPLOAD_ERRORS[sp.err]
      ? `${UPLOAD_ERRORS[sp.err]}${sp.name ? `：${sp.name}` : ""}`
      : undefined;
  const otherErr =
    sp.err === "name-exists"
      ? "名称已存在（分组名全站唯一）。"
      : sp.err === "group-not-empty"
        ? "分组内还有表情，先移走或停用后才能删除（表情不做物理删除）。"
        : undefined;

  return (
    <div className="space-y-4">
      {saved && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {sp.saved === "upload" && sp.uploaded ? `成功上传 ${sp.uploaded} 枚表情。` : saved}
          {failedList.length > 0 && (
            <div className="mt-1 text-xs text-destructive">
              失败 {failedList.length + failedMore} 枚：
              <ul className="ml-4 list-disc">
                {failedList.map((f) => (
                  <li key={f}>
                    {f.split("：")[0]}：{UPLOAD_ERRORS[f.split("：")[1]] ?? f.split("：")[1]}
                  </li>
                ))}
                {failedMore > 0 && <li>…另有 {failedMore} 枚未列出</li>}
              </ul>
            </div>
          )}
        </div>
      )}
      {(uploadErr || otherErr) && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {uploadErr ?? otherErr}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>分组（{groups.length}）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form action={createGroupAction} className="flex flex-wrap items-center gap-2 text-sm">
            <input type="hidden" name="back" value={back} />
            <input
              name="name"
              required
              maxLength={50}
              placeholder="新分组名"
              className="w-48 rounded-lg border bg-background px-2.5 py-1.5"
            />
            <SubmitButton
              className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
              pendingText="创建中…"
            >
              新建分组
            </SubmitButton>
          </form>
          <ul className="divide-y" data-testid="group-list">
            {groups.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                {g.iconKey && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/files/${g.iconKey}`}
                    alt=""
                    width={28}
                    height={28}
                    className="size-7 rounded border object-cover"
                  />
                )}
                <a
                  href={`/admin/emojis?group=${g.id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {g.name}
                </a>
                <span className="text-xs text-muted-foreground">
                  {Number(g.count)} 枚 · 排序 {g.sort} · {g.enabled ? "启用" : "停用"}
                  {!g.enabled && "（面板隐藏）"}
                </span>
                <span className="ml-auto flex items-center gap-1">
                  <form action={reorderGroupAction} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="back" value={back} />
                    <input
                      name="sort"
                      type="number"
                      min={0}
                      max={9999}
                      defaultValue={g.sort}
                      aria-label={`分组「${g.name}」的排序值`}
                      className="w-16 rounded border bg-background px-1.5 py-1 text-xs tabular-nums"
                    />
                    <SubmitButton
                      className="rounded px-1.5 py-1 text-xs hover:bg-accent"
                      pendingText="…"
                    >
                      存排序
                    </SubmitButton>
                  </form>
                  <form action={toggleGroupAction}>
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="back" value={back} />
                    <input type="hidden" name="enabled" value={g.enabled ? "0" : "1"} />
                    <SubmitButton
                      className="rounded px-2 py-1 text-xs hover:bg-accent"
                      pendingText="…"
                    >
                      {g.enabled ? "停用" : "启用"}
                    </SubmitButton>
                  </form>
                  <form action={deleteGroupAction}>
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="back" value={back} />
                    <ConfirmSubmit
                      title="删除分组"
                      description={`确认删除分组「${g.name}」？仅当组内无表情时允许。`}
                      className="text-xs text-destructive hover:underline disabled:opacity-40"
                      pendingText="…"
                    >
                      删除
                    </ConfirmSubmit>
                  </form>
                </span>
                <form
                  action={uploadGroupIconAction}
                  className="flex w-full items-center gap-2 sm:w-auto"
                >
                  <input type="hidden" name="id" value={g.id} />
                  <input type="hidden" name="back" value={back} />
                  <input
                    type="file"
                    name="icon"
                    required
                    accept=".png,.gif,.webp,image/png,image/gif,image/webp"
                    aria-label={`分组「${g.name}」的标题图`}
                    className="max-w-52 text-xs"
                  />
                  <SubmitButton
                    className="rounded px-2 py-1 text-xs hover:bg-accent"
                    pendingText="…"
                  >
                    {g.iconKey ? "更换标题图" : "上传标题图"}
                  </SubmitButton>
                </form>
                <form
                  action={renameGroupAction}
                  className="flex w-full items-center gap-2 sm:w-auto"
                >
                  <input type="hidden" name="id" value={g.id} />
                  <input type="hidden" name="back" value={back} />
                  <input
                    name="name"
                    defaultValue={g.name}
                    maxLength={50}
                    aria-label={`分组「${g.name}」的新名称`}
                    className="w-40 rounded-lg border bg-background px-2 py-1 text-xs"
                  />
                  <SubmitButton
                    className="rounded px-2 py-1 text-xs hover:bg-accent"
                    pendingText="…"
                  >
                    改名
                  </SubmitButton>
                </form>
              </li>
            ))}
            {groups.length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">
                还没有分组——先新建一个（迁移导入的站点会有「茉莉 01 / 茉莉 02」）。
              </li>
            )}
          </ul>
        </CardContent>
      </Card>

      {groupId !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {groups.find((g) => g.id === groupId)?.name ?? `分组 ${groupId}`} · 表情（共 {total}{" "}
                枚{q ? `，匹配「${q}」` : ""}）
              </span>
              {/* 关键词过滤（名称/关键词 LIKE）+ 分页（M9.5） */}
              <form
                action="/admin/emojis"
                method="get"
                className="flex items-center gap-1.5 text-sm font-normal"
              >
                <input type="hidden" name="group" value={groupId} />
                <input
                  name="q"
                  defaultValue={q}
                  placeholder="名称 / 关键词"
                  className="w-36 rounded-lg border bg-background px-2 py-1 text-xs"
                />
                <button
                  type="submit"
                  className="rounded-lg border px-2.5 py-1 text-xs hover:bg-accent"
                >
                  筛选
                </button>
                {q && (
                  <Link
                    href={`/admin/emojis?group=${groupId}`}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    重置
                  </Link>
                )}
              </form>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              action={uploadEmojiAction}
              className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm"
            >
              <input type="hidden" name="groupId" value={groupId} />
              <input type="hidden" name="back" value={back} />
              <input
                type="file"
                name="files"
                multiple
                required
                accept=".png,.gif,.webp,image/png,image/gif,image/webp"
                aria-label="选择表情文件（可多选）"
                className="text-xs"
              />
              <SubmitButton
                className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90"
                pendingText="上传中…"
              >
                上传表情
              </SubmitButton>
              <span className="text-xs text-muted-foreground">
                仅 PNG / GIF / WebP，≤ 200×200 像素、≤ 200KB；同名内容自动去重。
              </span>
            </form>

            <div className="overflow-x-auto rounded-lg border" data-testid="emoji-grid">
              <table className="w-full text-left text-sm">
                <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-2">预览</th>
                    <th className="px-2.5 py-2">名称</th>
                    <th className="px-2.5 py-2">关键词（搜索用，空格分隔）</th>
                    <th className="px-2.5 py-2">排序</th>
                    <th className="px-2.5 py-2">状态</th>
                    <th className="px-2.5 py-2" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {selected.map((e) => (
                    <tr key={e.id} className="border-t" data-enabled={e.enabled ? "1" : "0"}>
                      <td className="px-2.5 py-1.5">
                        {/* /emoji/{id}.{ext}：与正文引用同一 URL；停用也照常可渲染 */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/emoji/${e.id}.${e.ext}`}
                          alt={e.name}
                          width={e.width ?? 32}
                          height={e.height ?? 32}
                          className={`size-8 ${e.enabled ? "" : "opacity-40"}`}
                        />
                      </td>
                      <td className="px-2.5 py-1.5" colSpan={4}>
                        <form
                          action={updateEmojiAction}
                          className="flex flex-wrap items-center gap-1.5"
                        >
                          <input type="hidden" name="id" value={e.id} />
                          <input type="hidden" name="back" value={back} />
                          <input
                            name="name"
                            defaultValue={e.name}
                            maxLength={50}
                            aria-label={`表情 #${e.id} 的名称`}
                            className="w-32 rounded border bg-background px-1.5 py-1 text-xs"
                          />
                          <input
                            name="keywords"
                            defaultValue={e.keywords}
                            maxLength={200}
                            aria-label={`表情 #${e.id} 的搜索关键词`}
                            placeholder="关键词（空格分隔）"
                            className="w-56 rounded border bg-background px-1.5 py-1 text-xs"
                          />
                          <input
                            name="sort"
                            type="number"
                            min={0}
                            max={9999}
                            defaultValue={e.sort}
                            aria-label={`表情 #${e.id} 的排序值`}
                            className="w-16 rounded border bg-background px-1.5 py-1 text-xs tabular-nums"
                          />
                          <SubmitButton
                            className="rounded px-2 py-1 text-xs hover:bg-accent"
                            pendingText="…"
                          >
                            保存
                          </SubmitButton>
                          <span className="text-xs text-muted-foreground">#{e.id}</span>
                        </form>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <form action={toggleEmojiAction}>
                          <input type="hidden" name="id" value={e.id} />
                          <input type="hidden" name="back" value={back} />
                          <input type="hidden" name="enabled" value={e.enabled ? "0" : "1"} />
                          <SubmitButton
                            className="rounded px-2 py-1 text-xs hover:bg-accent"
                            pendingText="…"
                          >
                            {e.enabled ? "停用" : "启用"}
                          </SubmitButton>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {selected.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                        {q ? "没有匹配的表情。" : "此分组还没有表情，用上方表单上传。"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination
              basePath={`/admin/emojis?group=${groupId}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              page={page}
              totalPages={totalPages}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
