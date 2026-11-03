/**
 * 排期表单的错误回显草稿（M11.2，纯函数）。
 *
 * G-19：保存失败不得清空用户填写的内容。表单是服务端渲染、无脚本也能用，所以失败时把提交的字段
 * 编码进一个 `draft` 查询参数带回页面；编辑场景同时保留原 revision，版本冲突时不会被悄悄换成最新值。
 * 草稿只用于回填表单，从不信任：解析失败或形态不符一律忽略，回到数据库里的值。
 */

export interface CampaignDraft {
  /** 编辑中的方案 id；新建为 undefined */
  id?: number;
  /** 打开编辑页时读到的 revision（乐观锁的“旧锁”） */
  revision?: number;
  name: string;
  /** `<effect>::<target>` */
  choice: string;
  /** 原样的 datetime-local 字符串，便于直接回填 */
  startsAt: string;
  endsAt: string;
  priority: string;
}

const FIELD_LIMITS = { name: 200, choice: 120, startsAt: 32, endsAt: 32, priority: 8 } as const;

export function encodeCampaignDraft(draft: CampaignDraft): string {
  return encodeURIComponent(JSON.stringify(draft));
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** 参数已被框架解码一次；这里只做 JSON 解析与形态校验 */
export function decodeCampaignDraft(raw: string | undefined): CampaignDraft | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const text = record[field];
    if (typeof text !== "string" || text.length > max) return null;
  }
  if (record.id !== undefined && !isPositiveInt(record.id)) return null;
  if (record.revision !== undefined && !isPositiveInt(record.revision)) return null;
  return {
    ...(record.id !== undefined ? { id: record.id as number } : {}),
    ...(record.revision !== undefined ? { revision: record.revision as number } : {}),
    name: record.name as string,
    choice: record.choice as string,
    startsAt: record.startsAt as string,
    endsAt: record.endsAt as string,
    priority: record.priority as string,
  };
}
