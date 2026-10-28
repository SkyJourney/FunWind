import { ThemeSwitcher } from "@/components/theme-switcher";

export const dynamic = "force-dynamic";
export const metadata = { title: "外观" };

/** 外观（M10.6d 站长反馈：从 /me 收进设置中心页签；移动端此前不可达）。 */
export default function AppearanceSettingsPage() {
  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">主题外观</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          浅色 / 暗色 / 跟随系统；选择即时生效并保存在本设备。
        </p>
        <div className="mt-3">
          <ThemeSwitcher />
        </div>
      </section>
    </div>
  );
}
