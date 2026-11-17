import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { ChromeRowsEditor } from "@/components/admin/chrome-rows-editor";
import { saveFooterAction, saveLinksAction, saveNavAction } from "./actions";

/**
 * 站点框架卡（M19 Q3 自公告页迁入 settings）：导航/友链/页脚三键独立保存（setSetting 自带审计），
 * 保存即失效 chrome 缓存前台即时生效。三卡数据来自 getSiteChrome()。
 */
export function SiteChromeCard({
  chrome,
}: {
  chrome: {
    nav: { label: string; href: string }[];
    links: { label: string; href: string }[];
    footerText: string;
  };
}) {
  return (
    <Card id="chrome">
      <CardHeader>
        <CardTitle>站点框架</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-3">
          <form action={saveNavAction} className="space-y-2">
            <p className="text-sm font-medium">导航项</p>
            <ChromeRowsEditor
              name="navRaw"
              initialRows={chrome.nav}
              hrefPlaceholder="/f/951"
              addLabel="添加导航项"
            />
            <SubmitButton
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="…"
            >
              保存导航
            </SubmitButton>
          </form>

          <form action={saveLinksAction} className="space-y-2">
            <p className="text-sm font-medium">友情链接</p>
            <ChromeRowsEditor
              name="linksRaw"
              initialRows={chrome.links}
              hrefPlaceholder="https://…"
              addLabel="添加友链"
            />
            <SubmitButton
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="…"
            >
              保存友链
            </SubmitButton>
          </form>

          <form action={saveFooterAction} className="space-y-2">
            <p className="text-sm font-medium">页脚</p>
            <textarea
              name="footerText"
              rows={5}
              maxLength={300}
              className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm"
              defaultValue={chrome.footerText}
              placeholder="版权/备案/联系方式等纯文本"
            />
            <SubmitButton
              className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              pendingText="…"
            >
              保存页脚
            </SubmitButton>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}
