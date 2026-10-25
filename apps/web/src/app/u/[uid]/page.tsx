import Link from "next/link";
import { notFound } from "next/navigation";
import { RichContent } from "@/components/content/rich-content";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slot } from "@/modules/kernel/slot";
import { fileUrl } from "@/lib/files";
import { getProfile } from "@/lib/queries/users";

export const dynamic = "force-dynamic";

const parseUid = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function generateMetadata({ params }: { params: Promise<{ uid: string }> }) {
  const uid = parseUid((await params).uid);
  const profile = uid ? await getProfile(uid) : null;
  return { title: profile?.username ?? "用户" };
}

export default async function ProfilePage({ params }: { params: Promise<{ uid: string }> }) {
  const uid = parseUid((await params).uid);
  if (!uid) notFound();
  // 不存在或已注销（含迁移生成的“已注销用户”占位账号）→ 404，占位账号不开个人页
  const profile = await getProfile(uid);
  if (!profile) notFound();

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
      <Card>
        <CardContent className="flex items-start gap-4 pt-6">
          {profile.avatarKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl(profile.avatarKey)}
              alt={profile.username}
              width={64}
              height={64}
              className="rounded-xl border bg-muted object-cover"
            />
          ) : (
            <Avatar className="size-16">
              <AvatarFallback className="text-xl">{profile.username.slice(0, 1)}</AvatarFallback>
            </Avatar>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{profile.username}</h1>
              {profile.ban && <Badge variant="destructive">已封禁</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              注册于 {profile.createdAt} · 主题 {profile.threadCount} · 帖子 {profile.postCount} ·
              精华 {profile.featuredCount} · {profile.pointsName} {profile.points}
            </p>
            {profile.ban && (
              <p className="mt-2 text-sm text-destructive">
                封禁中{profile.ban.endsAt ? `（至 ${profile.ban.endsAt}）` : "（永久）"}
                {profile.ban.reason ? `：${profile.ban.reason}` : ""}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Slot name="profile.header" ctx={{ userId: uid }} />

      {profile.signatureMd && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">签名档</CardTitle>
          </CardHeader>
          <CardContent>
            <RichContent md={profile.signatureMd} />
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
