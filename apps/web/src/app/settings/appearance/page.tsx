import { redirect } from "next/navigation";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { SubmitButton } from "@/components/ui/submit-button";
import { getCurrentUser, getPasswordChangeUser } from "@/lib/auth/session";
import { getSiteChrome } from "@/lib/site-chrome";
import { getThemeCatalog } from "@/lib/theme/catalog";
import { getUserThemePack } from "@/lib/theme-pref";
import { updateThemePackAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "外观" };

/**
 * 外观（M10.6d 站长反馈：从 /me 收进设置中心页签；移动端此前不可达）。
 * M11：明暗模式（本设备，next-themes）+ 主题包偏好（存账号，跟随站点默认或自选；顶栏菜单也可即时切）。
 */
export default async function AppearanceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    if (await getPasswordChangeUser()) redirect("/settings/password?force=1");
    redirect("/login");
  }
  const [userPack, chrome, sp, catalog] = await Promise.all([
    getUserThemePack(user.id),
    getSiteChrome(),
    searchParams,
    getThemeCatalog(),
  ]);
  const current = userPack ?? "site";
  const siteLabel = catalog.find((pack) => pack.id === chrome.themePack)?.label ?? chrome.themePack;

  return (
    <div className="space-y-4">
      {sp.saved === "1" && (
        <p className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          主题包偏好已保存并即时生效。
        </p>
      )}
      {sp.error && (
        <p
          role="alert"
          className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {sp.error}
        </p>
      )}

      <section className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">明暗模式</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          浅色 / 暗色 / 跟随系统；选择即时生效并保存在本设备。
        </p>
        <div className="mt-3">
          <ThemeSwitcher />
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">主题包</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          配色与气质整套切换，保存在账号、各设备同步；站点默认当前为「
          {siteLabel}」。部分主题包仅提供浅色，暗色模式下自动回退默认暗色。
        </p>
        <form action={updateThemePackAction} className="mt-3 space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="pack"
              value="site"
              defaultChecked={current === "site"}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">跟随站点默认</span>
              <span className="text-muted-foreground">——站长切换默认主题时自动跟随</span>
            </span>
          </label>
          {catalog.map((pack) => (
            <label key={pack.id} className="flex items-start gap-2">
              <input
                type="radio"
                name="pack"
                value={pack.id}
                defaultChecked={current === pack.id}
                className="mt-1 size-4"
              />
              <span className="font-medium">{pack.label}</span>
            </label>
          ))}
          <div>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              保存主题包
            </SubmitButton>
          </div>
        </form>
      </section>
    </div>
  );
}
