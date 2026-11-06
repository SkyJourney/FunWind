import { getThemeCatalog } from "@/lib/theme/catalog";

/**
 * 主题包注册表展示（M11.6 Step 5b，/design 开发页用）：
 * 读取运行时目录（default 静态回退 + DB 启用包），展示 id / 标签 / 自带 LOGO。
 */
export async function ThemePackRegistry() {
  const catalog = await getThemeCatalog();
  return (
    <div className="space-y-2">
      {catalog.map((pack) => (
        <div key={pack.id} className="rounded border bg-card p-3 text-sm">
          <div className="flex items-baseline gap-2">
            <code className="font-mono text-xs">{pack.id}</code>
            <span className="text-muted-foreground">·</span>
            <span>{pack.label}</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">自带 LOGO：{pack.logo ?? "无"}</p>
        </div>
      ))}
    </div>
  );
}
