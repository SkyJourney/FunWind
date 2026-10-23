import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWebDb, userBans, users } from "@funwind/db";
import { legacyAvatarPath, legacyAvatarUrl } from "@/lib/auth/avatar";
import { RichContent } from "@/components/content/rich-content";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  return { title: `用户 ${uid}` };
}

export default async function ProfilePage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid: uidRaw } = await params;
  const uid = Number(uidRaw);
  if (!Number.isInteger(uid) || uid <= 0) notFound();

  const db = getWebDb();
  const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const user = rows[0];
  if (!user) notFound();

  const bans = await db
    .select({ reason: userBans.reason, endTime: userBans.endTime })
    .from(userBans)
    .where(eq(userBans.userId, uid));
  const nowWall = new Date().toISOString().slice(0, 19).replace("T", " ");
  const globalBan = bans.find((b) => !b.endTime || b.endTime > nowWall);
  const bannedNow = globalBan !== undefined || user.isSpam;

  // 旧站头像（/attachment 静态路由直出）；磁盘无头像文件 → 首字母占位
  const baseDir = process.env.ATTACHMENT_DIR ?? "";
  const hasAvatar =
    baseDir.length > 0 && existsSync(path.join(baseDir, legacyAvatarPath(uid, "_middle")));
  const credits = (user.credits as Record<string, number> | null) ?? {};

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
      <Card>
        <CardContent className="flex items-start gap-4 pt-6">
          {hasAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={legacyAvatarUrl(uid)}
              alt={user.username}
              width={64}
              height={64}
              className="rounded-xl border bg-muted object-cover"
            />
          ) : (
            <Avatar className="size-16">
              <AvatarFallback className="text-xl">{user.username.slice(0, 1)}</AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{user.username}</h1>
              {bannedNow && <Badge variant="destructive">已封禁</Badge>}
              {user.isSpam && <Badge variant="outline">广告账号</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {user.createdAt && <span>注册于 {user.createdAt}</span>}
              {" · 发帖 "}
              {user.postCount} · 精华 {user.digestCount} · 青翼币 {credits["1"] ?? 0}
            </p>
            {globalBan && (
              <p className="mt-2 text-sm text-destructive">
                封禁中{globalBan.endTime ? `（至 ${globalBan.endTime}）` : "（永久）"}
                {globalBan.reason ? `：${globalBan.reason}` : ""}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {user.signatureMd && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">签名档</CardTitle>
          </CardHeader>
          <CardContent>
            <RichContent md={user.signatureMd} />
          </CardContent>
        </Card>
      )}

      <div className="text-center text-sm">
        <Link href="/" className="text-muted-foreground hover:text-primary">
          ← 返回首页
        </Link>
      </div>
    </main>
  );
}
