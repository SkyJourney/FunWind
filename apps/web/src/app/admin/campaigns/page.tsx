import { AdminFlash } from "@/components/admin/admin-flash";
import { Card, CardContent } from "@/components/ui/card";
import { getHeroPoolRaw } from "@/lib/brand/hero-pool";
import { getLogoPoolRaw } from "@/lib/brand/logo-pool";
import { requireAdmin } from "@/lib/authz/require-admin";
import type { CampaignErrorCode } from "@/lib/campaigns/admin";
import { decodeCampaignDraft, type CampaignDraft } from "@/lib/campaigns/draft";
import { CAMPAIGN_EFFECTS, type CampaignEffect } from "@/lib/campaigns/effects";
import { joinChoice } from "@/lib/campaigns/input";
import { listCampaigns, type CampaignListItem } from "@/lib/campaigns/list";
import { getThemeCatalog } from "@/lib/theme/catalog";
import { CampaignForm, type ChoiceGroup } from "./campaign-form";
import { CampaignSection } from "./campaign-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "运营排期" };

const FLASH: Record<string, string> = {
  created: "排期方案已创建。",
  updated: "排期方案已保存。",
  toggled: "排期方案状态已更新。",
  deleted: "排期方案已删除。",
};

/** 键类型取自写服务的失败码：服务新增失败码而这里没补文案，类型检查就会报错（G-15） */
const ERR_TEXT: Record<CampaignErrorCode, string> = {
  "bad-name": "方案名称不能为空，且不超过 60 个字符。",
  "bad-effect": "请选择要生效的内容。",
  "bad-target": "所选内容的格式不合法。",
  "bad-start": "开始时间格式不合法。",
  "bad-end": "结束时间格式不合法。",
  "bad-window": "结束时间必须晚于开始时间。",
  "bad-priority": "优先级须为 0–65535 的整数。",
  "missing-ref": "所选主题包已停用或不存在，或素材已不在素材池中，请重新选择。",
  "not-found": "方案不存在或已被删除。",
  conflict: "方案已被他人修改（版本冲突）。你填写的内容已保留，请先放弃草稿并载入最新版本。",
  overlap:
    "该时间窗与另一个启用中的同类行为方案重叠：行为类方案不能时间重叠，可调整时间或先停用对方。",
  "behavior-needs-end": "行为类方案必须填写结束时间（要长期生效请改用站点设置）。",
};

/** 回执码查表：只认表里自有的键，`toString` 这类原型属性名不会被当成文案 */
function textOf(table: Readonly<Record<string, string>>, code: string | undefined) {
  return code !== undefined && Object.hasOwn(table, code) ? table[code] : undefined;
}

/** DB "YYYY-MM-DD HH:MM:SS" → datetime-local 预填值 */
const toLocalInput = (value: string | null) => (value ? value.replace(" ", "T").slice(0, 16) : "");

const EMPTY: CampaignDraft = { name: "", choice: "", startsAt: "", endsAt: "", priority: "0" };

/**
 * 下拉选项（M11.4 Step 0）：视觉类按库里的主题包 / 素材池生成；自带 fixedOptions 的效果
 * （M11.4 行为类）用注册表清单。新增效果时页面零改动。
 */
function optionsOf(
  effect: CampaignEffect<never>,
  libraryOptions: readonly { value: string; label: string }[],
): { value: string; label: string }[] {
  const source = effect.fixedOptions ?? libraryOptions.map((o) => [o.value, o.label] as const);
  return source.map(([value, label]) => ({ value, label }));
}

function draftOf(item: CampaignListItem): CampaignDraft {
  return {
    id: item.id,
    revision: item.revision,
    name: item.name,
    choice: item.target ? joinChoice(item.effect, item.target) : "",
    startsAt: toLocalInput(item.startsAt),
    endsAt: toLocalInput(item.endsAt),
    priority: String(item.priority),
  };
}

type SearchParams = { saved?: string; err?: string; edit?: string; draft?: string };

/**
 * 运营排期（M11.2）：按 effect 分区的方案列表 + 新建/编辑表单。门禁 site.admin；
 * 同一 effect 的多个方案按优先级决定谁生效，不同 effect 互不压制。
 * 前台读取链有 ≤30 秒的缓存收敛窗口（与其他站点配置一致），后台保存会即时失效本进程缓存。
 */
export default async function CampaignsAdminPage(props: { searchParams: Promise<SearchParams> }) {
  // 入口鉴权约定：第一个 await 必须是 requireAdmin（admin-entry-guard 静态守护）
  await requireAdmin("site.admin");
  const sp = await props.searchParams;
  const savedText = textOf(FLASH, sp.saved);
  const errText = sp.err ? (textOf(ERR_TEXT, sp.err) ?? "操作失败，请重试。") : undefined;
  const [{ items }, catalog, logoPool, heroPool] = await Promise.all([
    listCampaigns(),
    getThemeCatalog(),
    getLogoPoolRaw(),
    getHeroPoolRaw(),
  ]);

  const libraryOptions: Record<string, { value: string; label: string }[]> = {
    "theme.pack": catalog.map((pack) => ({ value: pack.id, label: `${pack.label}（${pack.id}）` })),
    "site.logo": logoPool.items.map((item) => ({ value: item.file, label: item.name })),
    "site.hero": heroPool.items.map((item) => ({ value: item.file, label: item.name })),
  };
  const labelByChoice = new Map(
    CAMPAIGN_EFFECTS.flatMap((effect) =>
      optionsOf(effect, libraryOptions[effect.key] ?? []).map(
        (option) => [joinChoice(effect.key, option.value), option.label] as const,
      ),
    ),
  );

  // 表单取值：失败草稿（含旧 revision）> 编辑中的方案 > 空白
  const editing = items.find((item) => item.id === Number(sp.edit));
  const draft = decodeCampaignDraft(sp.draft);
  const values = draft ?? (editing ? draftOf(editing) : EMPTY);
  const conflict = sp.err === "conflict" && values.id !== undefined;

  // 当前取值若已不在可选项里（包被停用、素材被移出池），补一个“已失效”选项，避免编辑时静默丢掉原值
  const groups: ChoiceGroup[] = CAMPAIGN_EFFECTS.map((effect) => {
    const options = optionsOf(effect, libraryOptions[effect.key] ?? []).map((option) => ({
      value: joinChoice(effect.key, option.value),
      label: option.label,
    }));
    if (
      values.choice.startsWith(`${effect.key}::`) &&
      !options.some((option) => option.value === values.choice)
    ) {
      options.push({ value: values.choice, label: `${values.choice.split("::")[1]}（已失效）` });
    }
    return { label: effect.label, options };
  });

  const summaryOf = (item: CampaignListItem) =>
    item.invalid || item.target === null
      ? "配置无效（读取时会被忽略）"
      : `${item.effectLabel} → ${labelByChoice.get(joinChoice(item.effect, item.target)) ?? `${item.target}（已失效）`}`;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-bold tracking-tight">运营排期</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          在指定时间窗内临时替换站点的主题包、LOGO 或首页横幅，到期自动回到常态，无需手动切换。
          同类方案时间重叠时，优先级数字大者生效；用户自己选择的主题包仍然优先于排期。 前台最多有 30
          秒的缓存延迟。
        </p>
      </header>
      {savedText && (
        <AdminFlash kind="success" dismissHref="/admin/campaigns">
          {savedText}
        </AdminFlash>
      )}
      {errText && (
        <AdminFlash kind="error" dismissHref="/admin/campaigns">
          {errText}
        </AdminFlash>
      )}
      <Card>
        <CardContent className="pt-5">
          <h3 className="mb-3 text-sm font-semibold">
            {values.id !== undefined ? `编辑方案 #${values.id}` : "新建方案"}
          </h3>
          <CampaignForm groups={groups} values={values} conflict={conflict} />
        </CardContent>
      </Card>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center text-sm text-muted-foreground">
          还没有排期方案。
        </p>
      ) : (
        CAMPAIGN_EFFECTS.map((effect) => {
          const rows = items.filter((item) => item.effect === effect.key);
          return rows.length === 0 ? null : (
            <CampaignSection
              key={effect.key}
              title={effect.label}
              items={[...rows].sort((a, b) => b.priority - a.priority || b.id - a.id)}
              labelOf={summaryOf}
            />
          );
        })
      )}
    </div>
  );
}
