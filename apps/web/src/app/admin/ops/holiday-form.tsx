import { SubmitButton } from "@/components/ui/submit-button";

import type { saveHolidayRuleAction } from "./actions";

/**
 * 节日装扮规则表单（M14 Step 4）：编辑 campaign.holiday 任务的 params。
 * 服务端渲染、无脚本可用（G 基线）：固定 3 行装扮内容（effect 留空 = 不使用该行），
 * 日历类型切换公历/农历（农历 day=0 = 该月最后一天，即除夕）。
 * 保存失败时整份表单经 draft 参数带回原样回填（G-19，与排期表单同一模式）。
 */
export function HolidayRuleForm({
  action,
  taskId,
  revision,
  params,
  draft,
}: {
  action: typeof saveHolidayRuleAction;
  taskId: number;
  revision: number;
  params: {
    calendar: string;
    month: number;
    day: number;
    beforeDays: number;
    durationDays: number;
    items: { effect: string; target: string }[];
  };
  /** 上次失败带回的草稿（优先于数据库值回填）；effects/targets 为数组形态 */
  draft: Record<string, unknown> | null;
}) {
  const text = (field: string, fallback: string): string => {
    const value = draft?.[field];
    return typeof value === "string" ? value : fallback;
  };
  const num = (field: string, fallback: number): number => {
    const value = draft?.[field];
    return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : fallback;
  };
  const calendar = (text("calendar", params.calendar) === "solar" ? "solar" : "lunar") as
    "solar" | "lunar";

  // 草稿里的 items 是 {effects: string[], targets: string[]}（与表单字段同形）；无草稿用库里的 params
  let items = params.items;
  if (draft && ("effects" in draft || "targets" in draft)) {
    const effects = draft["effects"];
    const targets = draft["targets"];
    if (Array.isArray(effects) && Array.isArray(targets)) {
      items = effects
        .slice(0, 3)
        .map((effect, index) => ({ effect: String(effect), target: String(targets[index] ?? "") }));
    }
  }
  const rows = [0, 1, 2].map((i) => items[i] ?? { effect: "", target: "" });
  const effects = ["theme.pack", "site.logo", "site.hero"] as const;
  const EFFECT_LABEL = {
    "theme.pack": "主题包",
    "site.logo": "站点 LOGO",
    "site.hero": "首页横幅",
  };

  return (
    <form action={action} className="mt-3 space-y-3 text-sm">
      <input type="hidden" name="id" value={taskId} />
      <input type="hidden" name="revision" value={revision} />
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="block">日历</span>
          <select
            name="calendar"
            defaultValue={calendar}
            className="mt-1 block rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="lunar">农历</option>
            <option value="solar">公历</option>
          </select>
        </label>
        <label className="block">
          <span className="block">月</span>
          <input
            type="number"
            name="month"
            min={1}
            max={12}
            defaultValue={num("month", params.month)}
            className="mt-1 block w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="block">日{calendar === "lunar" && "（0 = 月末）"}</span>
          <input
            type="number"
            name="day"
            min={calendar === "lunar" ? 0 : 1}
            max={calendar === "lunar" ? 30 : 31}
            defaultValue={num("day", params.day)}
            className="mt-1 block w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="block">节前偏移（天）</span>
          <input
            type="number"
            name="beforeDays"
            min={0}
            max={30}
            defaultValue={num("beforeDays", params.beforeDays)}
            className="mt-1 block w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="block">持续（天）</span>
          <input
            type="number"
            name="durationDays"
            min={1}
            max={90}
            defaultValue={num("durationDays", params.durationDays)}
            className="mt-1 block w-20 rounded-md border bg-background px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          装扮内容（最多 3 项；效果留空 = 该行不使用）。目标为该效果的选项值：主题包包 id / LOGO
          或横幅的池文件名（logo-*.png / hero-*.png）。生成的是「当前或下一年」的排期窗口，
          已生成的方案在排期页可微调，管线不会覆盖。
        </p>
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              name="itemEffect"
              defaultValue={row.effect}
              aria-label={`装扮内容 ${i + 1} 效果`}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <option value="">（不使用）</option>
              {effects.map((effect) => (
                <option key={effect} value={effect}>
                  {EFFECT_LABEL[effect]}
                </option>
              ))}
            </select>
            <input
              type="text"
              name="itemTarget"
              defaultValue={row.target}
              maxLength={120}
              aria-label={`装扮内容 ${i + 1} 目标`}
              placeholder={i === 0 ? "如 qy2010" : "如 logo-abcd1234.png"}
              className="w-full max-w-xs rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </div>
        ))}
      </div>
      <SubmitButton>保存规则</SubmitButton>
    </form>
  );
}
