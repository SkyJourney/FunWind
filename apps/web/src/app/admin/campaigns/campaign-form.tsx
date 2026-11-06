import Link from "next/link";
import { ActionGroup } from "@/components/ui/action-group";
import { SubmitButton } from "@/components/ui/submit-button";
import type { CampaignDraft } from "@/lib/campaigns/draft";
import { findCampaignEffect } from "@/lib/campaigns/effects";
import { createCampaignAction, updateCampaignAction } from "./actions";

export interface ChoiceGroup {
  label: string;
  options: { value: string; label: string }[];
}

const FIELD = "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm";

/**
 * 新建 / 编辑表单（服务端组件，无脚本可用）。
 * M11.4 改造：根据 effect 的字段类型动态渲染输入组件。
 * M11.2 兼容：select effect 仍用下拉菜单（choice 格式）；新 effect 用对应的输入类型。
 * 版本冲突时保留用户填写的草稿与旧 revision，并禁用保存：必须先放弃草稿、载入最新版本，
 * 绝不把旧草稿的版本悄悄换成服务端最新版（G-19）。
 */
export function CampaignForm({
  groups,
  values,
  conflict,
}: {
  groups: ChoiceGroup[];
  values: CampaignDraft;
  conflict: boolean;
}) {
  const editing = values.id !== undefined;
  // 从 choice 中解析出 effect（格式：`effect::target`）
  const choiceParts = values.choice.split("::");
  const selectedEffect = choiceParts[0] || "";
  const effect = selectedEffect ? findCampaignEffect(selectedEffect) : null;

  return (
    <form
      // 软导航会复用同一个 DOM：<select> 的 defaultValue 只在挂载时生效，
      // 必须随编辑对象、版本与冲突状态重新挂载，否则编辑页下拉为空、required 静默拦截提交
      key={`${values.id ?? "new"}:${values.revision ?? 0}:${conflict ? "c" : "n"}`}
      action={editing ? updateCampaignAction : createCampaignAction}
      className="grid max-w-full min-w-0 gap-3"
    >
      {editing && <input type="hidden" name="id" value={values.id} />}
      {editing && <input type="hidden" name="revision" value={values.revision} />}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1 text-sm">
          方案名称
          <input
            name="name"
            required
            maxLength={60}
            defaultValue={values.name}
            placeholder="如：圣诞装扮"
            className={FIELD}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm">
          生效内容
          <select name="choice" required defaultValue={values.choice} className={FIELD}>
            <option value="" disabled>
              请选择…
            </option>
            {groups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {/* M11.4 none effect（register.open）：无参数提示 */}
      {effect?.field.type === "none" && (
        <p className="text-sm text-muted-foreground">该效果无需额外配置，生效即临时开放注册。</p>
      )}

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <label className="grid min-w-0 gap-1 text-sm">
          开始时间{editing ? "" : "（留空 = 现在）"}
          <input
            type="datetime-local"
            name="startsAt"
            defaultValue={values.startsAt}
            className={FIELD}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm">
          结束时间（留空 = 长期）
          <input
            type="datetime-local"
            name="endsAt"
            defaultValue={values.endsAt}
            className={FIELD}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm">
          优先级（同类冲突时数字大者生效）
          <input
            type="number"
            name="priority"
            min={0}
            max={65535}
            step={1}
            defaultValue={values.priority}
            className={FIELD}
          />
        </label>
      </div>
      {conflict && (
        <p role="alert" className="min-w-0 text-sm [overflow-wrap:anywhere] text-destructive">
          这个方案已被他人修改（版本冲突）。你填写的内容已保留在下方，但不能覆盖对方的改动：
          请先复制需要的内容，再点击「放弃草稿并载入最新版本」后重新编辑。
        </p>
      )}
      <ActionGroup>
        <SubmitButton
          disabled={conflict}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {editing ? "保存修改" : "创建方案"}
        </SubmitButton>
        {editing && (
          <Link
            href={`/admin/campaigns?edit=${values.id}`}
            className="shrink-0 rounded-lg border px-4 py-2 text-sm whitespace-nowrap hover:bg-accent"
          >
            {conflict ? "放弃草稿并载入最新版本" : "重新载入"}
          </Link>
        )}
        {editing && (
          <Link
            href="/admin/campaigns"
            className="shrink-0 rounded-lg border px-4 py-2 text-sm whitespace-nowrap hover:bg-accent"
          >
            取消编辑
          </Link>
        )}
      </ActionGroup>
    </form>
  );
}
