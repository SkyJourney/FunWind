import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getForumModerators } from "@/lib/authz/service";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";

export const dynamic = "force-dynamic";
export const metadata = { title: "版块权限视角" };

const READ_LABEL = { public: "公开", members: "仅登录会员", restricted: "仅授权角色" } as const;
const WRITE_LABEL = { members: "登录会员（凭全局发帖权）", restricted: "仅授权角色" } as const;
const REVIEW_LABEL = { none: "无需审核", threads: "新主题需审核", all: "所有发帖需审核" } as const;

export default async function ForumAuthzPage({ params }: { params: Promise<{ fid: string }> }) {
  // 第一个 await：局部渲染可能跳过 layout，页面自己必须鉴权（admin-entry-guard.test.ts 守护）
  await requireAdmin("admin.roles");
  const { fid: fidRaw } = await params;
  const fid = Number(fidRaw);
  if (!Number.isInteger(fid)) notFound();

  const snap = await getAuthzSnapshot();
  const forum = snap.tree.get(fid);
  if (!forum) notFound();

  const chain = snap.tree.chain(fid);
  // 版块作用域授权（含祖先继承）；全局基线另表展示，不混入
  const grants = snap.grants.filter((g) => g.scopeId > 0 && chain.includes(g.scopeId));
  const moderators = await getForumModerators(fid);
  const read = snap.tree.readPolicy(fid);
  const write = snap.tree.writePolicy(fid);
  const review = snap.tree.reviewPolicy(fid);
  const from = (holderId: number | null) =>
    holderId === null
      ? "全链未声明，取默认"
      : holderId === fid
        ? "本版块声明"
        : `继承自版块 ${holderId}`;

  return (
    <div className="space-y-6">
      <nav className="text-sm text-muted-foreground">
        <Link href="/admin/authz" className="hover:text-primary">
          ← 角色与授权
        </Link>
        <span> / 版块视角</span>
      </nav>

      <header>
        <h1 className="text-xl font-bold">{forum.name} · 权限视角</h1>
        <p className="text-xs text-muted-foreground">
          作用域链：{chain.join(" ← ")}（授权与策略沿此链向子版块继承）
        </p>
      </header>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-semibold">有效策略</h2>
        <dl className="grid gap-1 text-sm sm:grid-cols-[6rem_1fr]">
          <dt className="text-muted-foreground">读取</dt>
          <dd>
            {READ_LABEL[read.value]}
            <span className="ml-2 text-xs text-muted-foreground">{from(read.holderId)}</span>
          </dd>
          <dt className="text-muted-foreground">发帖</dt>
          <dd>
            {WRITE_LABEL[write.value]}
            <span className="ml-2 text-xs text-muted-foreground">{from(write.holderId)}</span>
          </dd>
          <dt className="text-muted-foreground">审核</dt>
          <dd>
            {REVIEW_LABEL[review.value]}
            <span className="ml-2 text-xs text-muted-foreground">{from(review.holderId)}</span>
          </dd>
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-semibold">版主（持有 forum.moderate 授权的角色的持有人）</h2>
        {moderators.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            无（该版块链上没有角色被授予 forum.moderate）
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {moderators.map((m) => (
              <Link
                key={m.userId}
                href={`/u/${m.userId}`}
                className="rounded-lg border px-3 py-1.5 text-sm hover:bg-accent"
              >
                {m.username}
                {m.viaParent && (
                  <span className="ml-1 text-xs text-muted-foreground">（继承）</span>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 font-semibold">版块作用域授权（含继承）</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-1.5">角色</th>
              <th className="py-1.5">权限点</th>
              <th className="py-1.5">来源版块</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr
                key={`${g.roleKey}:${g.permissionKey}:${g.scopeId}`}
                className="border-b last:border-b-0"
              >
                <td className="py-1.5">{g.roleKey}</td>
                <td className="py-1.5">
                  <code className="text-xs">{g.permissionKey}</code>
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {g.scopeId === fid ? "本版块" : `继承自 /f/${g.scopeId}`}
                </td>
              </tr>
            ))}
            {grants.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-muted-foreground">
                  无
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
