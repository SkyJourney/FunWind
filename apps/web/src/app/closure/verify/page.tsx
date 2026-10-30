import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { consumeClosureEmailTokenAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "验证注销操作", robots: { index: false, follow: false } };

export default async function ClosureVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const params = await searchParams;
  if (!params.token) redirect("/closure");

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <Card>
        <CardHeader>
          <h1 className="text-lg leading-none font-semibold">确认账号安全操作</h1>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            此一次性验证链接仅用于继续注销申请或查看注销状态，不会恢复普通登录权限。
          </p>
          {params.error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
            >
              {params.error}
            </p>
          )}
          <form action={consumeClosureEmailTokenAction}>
            <input type="hidden" name="token" value={params.token} />
            <SubmitButton
              pendingText="验证中…"
              className="rounded-lg bg-primary px-4 py-2 text-primary-foreground"
            >
              继续
            </SubmitButton>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
