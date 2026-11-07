import { Layers } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ForumDirectory } from "@/components/content/forum-directory";
import { EmptyState } from "@/components/empty-state";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkPermission } from "@/lib/authz/service";
import { getSiteChrome } from "@/lib/chrome/site-chrome";
import { getDirectory } from "@/lib/queries/forums";

export const metadata: Metadata = { title: "板块目录" };
export const dynamic = "force-dynamic";

/**
 * 板块目录页（M10.5）：分区 → 板块卡片。与首页共用 ForumDirectory；
 * 首页将在 S2 线稿翻转为「内容流优先」，目录以此页为家（底部 Tab「板块」的目标）。
 * 零数据空态（M12）：安装后尚无版块时给三要素引导——管理员直达后台建版块；
 * 访客按注册策略给「注册账号」（开放/邀请均可注册，区别只在是否要邀请码）或仅提示登录。
 */
export default async function BoardsPage() {
  const viewer = await getCurrentSubject();
  // 与首页同口径：受限板块的名称/计数不出现在任何位置
  const dir = await getDirectory(viewer);

  if (dir.forumCount === 0) {
    const [canManage, chrome] = await Promise.all([
      checkPermission(viewer, "site.admin"),
      getSiteChrome(),
    ]);
    // 三档主行动（审查 F-10）：管理员直达后台；游客按注册策略给注册入口；
    // 已登录非管理员不给 CTA——「注册账号/登录」对已登录用户是错误引导
    const action = canManage.allowed ? (
      <Link
        href="/admin/forums"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        进后台创建第一个版块 →
      </Link>
    ) : viewer.userId === null ? (
      chrome.registrationOpen ? (
        <Link href="/register" className="text-sm text-primary hover:underline">
          注册账号，等版块开放后发第一帖 →
        </Link>
      ) : (
        <Link href="/login" className="text-sm text-primary hover:underline">
          登录 →
        </Link>
      )
    ) : null;
    return (
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Layers className="size-6 text-primary" aria-hidden />
            板块目录
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">0 个板块 · 0 个主题</p>
        </header>
        <EmptyState
          icon={Layers}
          title="这里还没有板块"
          description={
            canManage.allowed
              ? "零数据站点：创建第一个版块后，社区就从这里开始。"
              : "站长正在准备社区，稍后再来看看。"
          }
          action={action}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Layers className="size-6 text-primary" aria-hidden />
          板块目录
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {dir.forumCount} 个板块 · {dir.threadCount} 个主题
        </p>
      </header>
      <ForumDirectory dir={dir} />
    </main>
  );
}
