import { redirect } from "next/navigation";
import { AvatarUploader } from "@/components/upload/avatar-uploader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentSubject } from "@/lib/authz/subject";
import { getProfile } from "@/lib/queries/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "头像设置" };

/** 头像设置（M6.4d3）：登录后可用；未登录跳转登录页；no_avatar 限制下只显示说明 */
export default async function AvatarSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const subject = await getCurrentSubject();
  const blocked = subject.restrictions.some((r) => r.kind === "no_avatar" && r.scopeId === 0);
  const profile = await getProfile(user.id);

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <Card>
        <CardHeader>
          <CardTitle>头像设置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {blocked ? (
            <p className="text-sm text-muted-foreground">
              当前账号暂时不能设置头像。如有疑问，请联系版主。
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                选择一张图片，拖动框选正方形区域即可。GIF 将取首帧并居中裁切。头像会显示为 240×240。
              </p>
              <AvatarUploader currentKey={profile?.avatarKey ?? null} name={user.username} />
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
