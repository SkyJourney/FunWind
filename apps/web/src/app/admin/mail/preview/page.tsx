import Link from "next/link";
import { requireAdmin } from "@/lib/authz/require-admin";
import { getMailBrand } from "@/lib/mail";
import { MAIL_PREVIEWS, findMailPreview } from "@/lib/mail/previews";

export const dynamic = "force-dynamic";
export const metadata = { title: "邮件模板预览" };

type Params = {
  searchParams: Promise<{ t?: string }>;
};

/**
 * 模板预览（admin.logs，与 /admin/mail 同档）：用固定样例数据与当前邮件品牌渲染任意模板，
 * 站长改样式 / 调文案不用真发信。iframe sandbox 不放行脚本（模板本身零脚本）。
 */
export default async function AdminMailPreviewPage({ searchParams }: Params) {
  await requireAdmin("admin.logs");
  const sp = await searchParams;
  const preview = findMailPreview(sp.t);
  const brand = await getMailBrand();
  const message = preview.build(brand);

  const groups = [...new Set(MAIL_PREVIEWS.map((p) => p.group))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          样例数据渲染，非真实发送；品牌跟随站点身份与默认主题包（当前主题色 {brand.accent}）。
        </p>
        <Link href="/admin/mail" className="rounded-lg border px-3 py-1.5 text-xs hover:bg-accent">
          ← 发送记录
        </Link>
      </div>

      <nav className="flex flex-wrap gap-1.5 text-xs" aria-label="模板分组">
        {groups.map((g) => (
          <div key={g} className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground">{g}</span>
            {MAIL_PREVIEWS.filter((p) => p.group === g).map((p) => (
              <Link
                key={p.id}
                href={`/admin/mail/preview?t=${p.id}`}
                className={`rounded-full border px-2.5 py-1 ${
                  p.id === preview.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="rounded-xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">主题</p>
        <p className="mb-3 font-medium">{message.subject}</p>
        <iframe
          sandbox=""
          srcDoc={message.html}
          title={`模板预览：${preview.label}`}
          className="h-[760px] w-full rounded-lg border bg-[#f1f5f9]"
        />
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            纯文本版本（纯文本客户端 / 无障碍阅读器所见）
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border bg-background p-3 text-xs leading-relaxed whitespace-pre-wrap">
            {message.text}
          </pre>
        </details>
      </div>
    </div>
  );
}
