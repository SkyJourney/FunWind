import { isValidBeijingDateTime } from "@/lib/datetime";
import { configFromTarget, findCampaignEffect, validateCampaignConfig } from "./effects";

/**
 * 运营排期方案的表单输入校验（M11.2，纯函数，无 IO）。
 * 引用的存在性（包是否启用、池文件是否在池内）需要读库，由写服务另行校验（refs.ts）。
 */

export const CAMPAIGN_NAME_MAX = 60;
/** priority 列是 smallint unsigned */
export const CAMPAIGN_PRIORITY_MAX = 65535;

/** 效果与目标合并在一个下拉里提交：`<effect>::<target>`，无脚本也能联动，不需要二级选择 */
const CHOICE_SEPARATOR = "::";

export function joinChoice(effect: string, target: string): string {
  return `${effect}${CHOICE_SEPARATOR}${target}`;
}

export function splitChoice(choice: string): { effect: string; target: string } | null {
  const at = choice.indexOf(CHOICE_SEPARATOR);
  if (at <= 0) return null;
  const effect = choice.slice(0, at);
  const target = choice.slice(at + CHOICE_SEPARATOR.length);
  return target === "" ? null : { effect, target };
}

/**
 * datetime-local（`YYYY-MM-DDTHH:MM`，浏览器也可能带秒）→ 北京墙面 DATETIME；
 * 空串返回空串，由调用方决定留空的含义（新建 = 立即，结束时间 = 长期）。格式不合法的值原样透出，交给校验拒绝。
 */
export function toWallTime(local: string): string {
  const value = local.trim().replace("T", " ");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

export type CampaignInputError =
  | "bad-name"
  | "bad-effect"
  | "bad-target"
  | "bad-start"
  | "bad-end"
  | "bad-window"
  | "bad-priority";

export interface CampaignFields {
  name: string;
  effect: string;
  target: string;
  /** 已转成 "YYYY-MM-DD HH:MM:SS" */
  startsAt: string;
  /** 空串或 null = 长期 */
  endsAt: string | null;
  priority: number;
}

export interface ValidCampaign {
  name: string;
  effect: string;
  config: Record<string, string>;
  startsAt: string;
  endsAt: string | null;
  priority: number;
}

export function validateCampaignFields(
  fields: CampaignFields,
): { ok: true; value: ValidCampaign } | { ok: false; code: CampaignInputError } {
  const name = fields.name.trim();
  // 按码点计数：与 varchar(60) 的字符计数一致（emoji 不会被当成两个字符）
  const nameLength = [...name].length;
  if (nameLength < 1 || nameLength > CAMPAIGN_NAME_MAX) return { ok: false, code: "bad-name" };

  if (!findCampaignEffect(fields.effect)) return { ok: false, code: "bad-effect" };
  const config = configFromTarget(fields.effect, fields.target.trim());
  if (!config || !validateCampaignConfig(fields.effect, config).ok) {
    return { ok: false, code: "bad-target" };
  }

  if (!isValidBeijingDateTime(fields.startsAt)) return { ok: false, code: "bad-start" };
  const endsAt = fields.endsAt === null || fields.endsAt === "" ? null : fields.endsAt;
  if (endsAt !== null) {
    if (!isValidBeijingDateTime(endsAt)) return { ok: false, code: "bad-end" };
    // 同格式字符串的字典序即先后；结束必须晚于开始，否则窗口为空
    if (endsAt <= fields.startsAt) return { ok: false, code: "bad-window" };
  }

  const { priority } = fields;
  if (!Number.isInteger(priority) || priority < 0 || priority > CAMPAIGN_PRIORITY_MAX) {
    return { ok: false, code: "bad-priority" };
  }

  return {
    ok: true,
    value: { name, effect: fields.effect, config, startsAt: fields.startsAt, endsAt, priority },
  };
}
