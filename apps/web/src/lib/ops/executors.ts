import { z } from "zod";
import { configFromTarget, findCampaignEffect } from "@/lib/campaigns/effects";

/**
 * 运维任务的执行器注册表与触发器写法校验（M14 Step 2/4，web 侧）。
 *
 * 管线（services/ops）才是执行方：本模块是其 app/executors.py 与 app/triggers.py 的镜像——
 * 执行器清单、参数校验、cron 与单次时刻的写法规则两端必须逐条一致，由共享夹具
 * services/ops/tests/fixtures/ops-contract.json 双端测试守护（改规则先改夹具，两端测试都会提示对齐）。
 * 差异口径：节日装扮 items 的 target 语法（包 id / 池文件名正则）只在 web 校验（写前拦截），
 * 管线做结构校验、存在性由 SSR 写服务按 effect 注册表 fail-closed——此类用例不进共享夹具。
 * 纯模块（无 IO、不标 server-only）：后台表单与写服务共用。
 */

export interface OpsExecutor {
  key: string;
  label: string;
  /** 后台展示的一句话说明 */
  description: string;
  /** 参数校验：未知字段拒绝（.strict()），与管线逐字段同口径 */
  params: z.ZodType<Record<string, unknown>>;
  /** schema 通过后的语义校验（跨字段/注册表级），只有部分执行器需要 */
  semantic?: (params: Record<string, unknown>) => OpsCheck<Record<string, unknown>>;
}

/** 备份类参数：只有可选的 keep（保留份数，1–90）；缺省时管线按 v1 保留策略 / 环境默认解析 */
const retentionParams = z
  .object({ keep: z.number().int().min(1, "保留份数至少 1").max(90, "保留份数最多 90").nullish() })
  .strict();

/** 节日装扮规则（结构层）；语义（日历/月末/day 范围/注册表）在 holidayRuleSemantic */
const holidayRuleSchema = z
  .object({
    calendar: z.enum(["solar", "lunar"]),
    month: z.number().int().min(1, "月份须为 1–12").max(12),
    day: z.number().int().min(0).max(31),
    beforeDays: z.number().int().min(0, "提前天数不能为负").max(30).nullish(),
    durationDays: z.number().int().min(1, "持续至少 1 天").max(90, "持续最多 90 天").nullish(),
    items: z
      .array(
        z
          .object({ effect: z.string().min(1).max(32), target: z.string().trim().min(1).max(120) })
          .strict(),
      )
      .min(1, "至少配置一项装扮内容")
      .max(6, "装扮内容最多 6 项"),
  })
  .strict();

/** 节日装扮的语义校验：日历与日的合法组合、effect 注册且为视觉类、target 语法、去重 */
function holidayRuleSemantic(parsed: Record<string, unknown>): OpsCheck<Record<string, unknown>> {
  const { calendar, day } = parsed as { calendar: "solar" | "lunar"; day: number };
  if (calendar === "lunar" ? day > 30 : day < 1) {
    return {
      ok: false,
      message:
        calendar === "lunar"
          ? "农历的日须为 0–30（0 = 该月最后一天，如除夕）"
          : "公历的日须为 1–31",
    };
  }
  const items = parsed["items"] as { effect: string; target: string }[];
  const seen = new Set<string>();
  for (const item of items) {
    if (!findCampaignEffect(item.effect)) {
      return { ok: false, message: `未注册的效果类型：${item.effect}` };
    }
    if (seen.has(item.effect)) {
      return { ok: false, message: `装扮效果重复：${item.effect}` };
    }
    seen.add(item.effect);
    if (!configFromTarget(item.effect, item.target)) {
      return { ok: false, message: `装扮 ${item.effect} 的目标语法无效：${item.target}` };
    }
  }
  return { ok: true, value: parsed };
}

export const OPS_EXECUTORS: readonly OpsExecutor[] = [
  {
    key: "backup.db",
    label: "数据库备份",
    description: "mysqldump 一致性快照 + gzip 完整性校验，按保留份数轮转",
    params: retentionParams,
  },
  {
    key: "backup.storage",
    label: "存储备份",
    description: "附件存储目录 tar 全量（排除可再生的缓存目录），按保留份数轮转",
    params: retentionParams,
  },
  {
    key: "campaign.holiday",
    label: "节日装扮",
    description: "按农历/公历规则自动生成运营排期时间窗（当前或下一年，幂等）",
    params: holidayRuleSchema,
    semantic: holidayRuleSemantic,
  },
  {
    key: "drill.restore",
    label: "恢复演练",
    description: "每周自动将最新数据库备份导入同实例临时库并对账，结束后清理（不接受参数）",
    params: z.object({}).strict(),
  },
];

export function findOpsExecutor(key: string): OpsExecutor | null {
  return OPS_EXECUTORS.find((executor) => executor.key === key) ?? null;
}

export type OpsCheck<T> = { ok: true; value: T } | { ok: false; message: string };

/** 校验并规范化任务参数（值为 null 的可选项去掉，与管线 validate 的返回一致） */
export function validateOpsParams(
  executorKey: string,
  params: unknown,
): OpsCheck<Record<string, unknown>> {
  const executor = findOpsExecutor(executorKey);
  if (!executor) return { ok: false, message: `未注册的执行器：${executorKey}` };
  const parsed = executor.params.safeParse(params);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "参数";
    return { ok: false, message: `${where}：${first?.message ?? "不合法"}` };
  }
  const normalized = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== null && value !== undefined),
  );
  if (executor.semantic) {
    const semantic = executor.semantic(normalized);
    return semantic.ok ? { ok: true, value: semantic.value } : semantic;
  }
  return { ok: true, value: normalized };
}

// ── cron 写法（与 app/triggers.py 的严格语法逐条一致） ─────────────────────────

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

interface CronField {
  label: string;
  /** 数字取值范围；星期字段只认名称（null） */
  range: readonly [number, number] | null;
  names: readonly string[] | null;
}

const CRON_FIELDS: readonly CronField[] = [
  { label: "分", range: [0, 59], names: null },
  { label: "时", range: [0, 23], names: null },
  { label: "日", range: [1, 31], names: null },
  { label: "月", range: [1, 12], names: MONTH_NAMES },
  { label: "星期", range: null, names: WEEKDAY_NAMES },
];

const ITEM_RE = /^(\*|[0-9a-z]+(?:-[0-9a-z]+)?)(?:\/([0-9]+))?$/;

/** 字段里的一个取值 → 序号（名称换算到与数字同一基准：月份 jan=1，星期 mon=0）；不合法返回 null */
function fieldValue(token: string, field: CronField): number | null {
  if (/^[0-9]+$/.test(token) && field.range) {
    const value = Number(token);
    return value >= field.range[0] && value <= field.range[1] ? value : null;
  }
  const index = field.names?.indexOf(token) ?? -1;
  return index >= 0 ? index + (field.range?.[0] ?? 0) : null;
}

/**
 * 单个字段：逗号分隔的若干项，每项为「星号」「星号斜杠步长」「值」「值-值」「值-值斜杠步长」之一；
 * 步长 ≥ 1 且不超过跨度（星号取字段全幅）；区间不得倒置。
 */
function cronFieldOk(text: string, field: CronField): boolean {
  return text.split(",").every((item) => {
    const match = ITEM_RE.exec(item);
    if (!match) return false;
    const body = match[1]!;
    const step = match[2] === undefined ? null : Number(match[2]);
    if (step !== null && step < 1) return false;
    if (body === "*")
      return step === null || (field.range !== null && step <= field.range[1] - field.range[0]);
    if (step !== null && !body.includes("-")) return false;
    const bounds = body.split("-").map((part) => fieldValue(part, field));
    if (bounds.some((value) => value === null)) return false;
    const [low, high] = [bounds[0]!, bounds[bounds.length - 1]!];
    return low <= high && (step === null || step <= high - low);
  });
}

/**
 * 校验并规范化 cron（5 段，空白折叠，小写）。星期字段只认名称 mon…sun：管线所用 APScheduler 的 0 是周一，
 * 而标准 crontab 的 0 是周日——数字写法会静默错位一天，两端都直接拒绝。
 */
export function validateCron(expr: string): OpsCheck<string> {
  const fields = expr.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return { ok: false, message: "cron 须为 5 段：分 时 日 月 星期" };
  if (/[0-9]/.test(fields[4]!)) {
    return {
      ok: false,
      message:
        "星期字段请用名称 mon…sun（不接受数字：调度器的 0 是周一而 crontab 的 0 是周日，会错位一天）",
    };
  }
  const lower = fields.map((field) => field.toLowerCase());
  const bad = lower.findIndex((text, i) => !cronFieldOk(text, CRON_FIELDS[i]!));
  if (bad >= 0)
    return { ok: false, message: `cron 的${CRON_FIELDS[bad]!.label}字段不合法：${fields[bad]}` };
  return { ok: true, value: lower.join(" ") };
}

/** 单次触发时刻：北京墙面时间 `YYYY-MM-DD HH:MM:SS`（前后空白去掉；各段位数写死、日期须真实存在） */
export function validateOnce(expr: string): OpsCheck<string> {
  const text = expr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  const invalid = {
    ok: false as const,
    message: "单次触发时刻须为「YYYY-MM-DD HH:MM:SS」（北京时间）",
  };
  if (!match) return invalid;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const real =
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === mo - 1 &&
    probe.getUTCDate() === d &&
    probe.getUTCHours() === h &&
    probe.getUTCMinutes() === mi &&
    probe.getUTCSeconds() === s;
  return real ? { ok: true, value: text } : invalid;
}

export type OpsTriggerKind = "cron" | "once" | "manual";
export const OPS_TRIGGER_KINDS: readonly OpsTriggerKind[] = ["cron", "once", "manual"];

/** 触发器：cron / once 校验并规范化表达式；manual 的表达式恒为 null */
export function validateTrigger(
  kind: string,
  expr: string | null | undefined,
): OpsCheck<{
  kind: OpsTriggerKind;
  expr: string | null;
}> {
  if (kind === "manual") return { ok: true, value: { kind, expr: null } };
  if (kind !== "cron" && kind !== "once")
    return { ok: false, message: `未知的触发器类型：${kind}` };
  const checked = kind === "cron" ? validateCron(expr ?? "") : validateOnce(expr ?? "");
  return checked.ok ? { ok: true, value: { kind, expr: checked.value } } : checked;
}

/** 任务键：小写字母数字开头，2–64 位，允许 `.` `_` `-`（同时是台账与日志标识，定名后不改） */
export function validateTaskKey(key: string): OpsCheck<string> {
  return /^[a-z0-9][a-z0-9._-]{1,63}$/.test(key)
    ? { ok: true, value: key }
    : { ok: false, message: "任务键只允许小写字母、数字与 . _ -，2–64 位且以字母或数字开头" };
}
