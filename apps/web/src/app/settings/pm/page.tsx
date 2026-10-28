import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { eq } from "drizzle-orm";
import { getWebDb, userProfiles } from "@funwind/db";
import { getCurrentUser } from "@/lib/auth/session";
import { SubmitButton } from "@/components/ui/submit-button";
import { updatePmPolicyAction } from "@/app/actions/pm";

export const dynamic = "force-dynamic";
export const metadata = { title: "私信偏好" };

const POLICY_LABEL = { all: "所有人", following: "仅我关注的人", off: "关闭私信" } as const;

/** 私信偏好（M10.6d 站长反馈：从 /me 收进设置中心页签）。 */
export default async function PmSettingsPage() {
  const user = await getCurrentUser();
  if (!user) return null;
  const [row] = await getWebDb()
    .select({ pmPolicy: userProfiles.pmPolicy })
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .limit(1);
  const pmPolicy = row?.pmPolicy ?? "all";

  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="size-4 text-primary" aria-hidden /> 谁可以给我发私信
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          判定在服务端执行；公开页与悬浮名片的入口会按此三态呈现。
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {(["all", "following", "off"] as const).map((p) => (
            <form key={p} action={updatePmPolicyAction}>
              <input type="hidden" name="policy" value={p} />
              <SubmitButton
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  pmPolicy === p
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                }`}
                pendingText="…"
              >
                {POLICY_LABEL[p]}
              </SubmitButton>
            </form>
          ))}
        </div>
      </section>
      <p className="text-center text-xs text-muted-foreground">
        外观（主题切换）在顶部工具栏的{" "}
        <Link href="/me" className="hover:text-primary">
          「我的」页
        </Link>{" "}
        也可用。
      </p>
    </div>
  );
}
