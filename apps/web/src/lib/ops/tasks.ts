import "server-only";

import { asc, eq, inArray } from "drizzle-orm";
import {
  getWebDb,
  insertIdOf,
  LEGACY_BACKUP_POLICY_KEY,
  legacyKeep,
  opsTasks,
  opsTriggers,
  siteSettings,
} from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { withDeadlockRetry } from "@/lib/points/retry";
import { isMissingTable } from "@/lib/ops/runs";
import { notifyOpsReload } from "./client";
import { validateOpsParams, validateTaskKey, validateTrigger } from "./executors";

/**
 * 运维任务与触发器的配置写服务（M14 Step 2）。
 * 约定与排期写服务（lib/campaigns/admin.ts）一致：事务内写审计（动作回滚则审计一并回滚）、
 * revision 乐观锁（冲突不覆盖，G-19）、启停与触发器增删改等旁路写同样让任务 revision+1（G-20），
 * 写事务外包 withDeadlockRetry。加锁顺序固定为「任务行 → 触发器行」。
 * 写路径不执行任务：提交后通知管线热加载（best-effort），失败由管线周期对账兜底（M14 D1 配置与执行解耦）。
 */

export type OpsErrorCode = "bad-input" | "not-found" | "conflict";

export type OpsResult<T = { id: number }> =
  { ok: true; value: T } | { ok: false; code: OpsErrorCode; message?: string };

type TaskRow = typeof opsTasks.$inferSelect;
type TriggerRow = typeof opsTriggers.$inferSelect;

export interface OpsTaskView {
  id: number;
  taskKey: string;
  name: string;
  executor: string;
  params: Record<string, unknown>;
  enabled: boolean;
  revision: number;
  triggers: {
    id: number;
    kind: TriggerRow["kind"];
    expr: string | null;
    enabled: boolean;
    revision: number;
  }[];
}

function taskSnapshot(row: TaskRow) {
  return {
    name: row.name,
    executor: row.executor,
    params: row.params,
    enabled: row.enabled,
    revision: row.revision,
  };
}

function triggerSnapshot(row: TriggerRow) {
  return {
    taskKey: row.taskKey,
    kind: row.kind,
    expr: row.expr,
    enabled: row.enabled,
    revision: row.revision,
  };
}

async function audit(
  tx: DbTx,
  actor: ConfigActor,
  action: string,
  target: { type: "ops_task" | "ops_trigger"; id: string | number },
  before: unknown,
  after: Record<string, unknown> | null,
) {
  await writeAudit(tx, {
    actorId: actor.userId,
    action,
    targetType: target.type,
    targetId: target.id,
    before,
    after: after === null ? null : { ...after, via: actor.via },
    ip: actor.ip,
  });
}

async function lockTaskBy(tx: DbTx, where: ReturnType<typeof eq>): Promise<TaskRow | null> {
  const [row] = await tx.select().from(opsTasks).where(where).limit(1).for("update");
  return row ?? null;
}

/** 锁触发器及其所属任务（先任务后触发器，与其余写路径同序，避免互锁） */
async function lockTriggerWithTask(tx: DbTx, id: number) {
  const [peek] = await tx
    .select({ taskKey: opsTriggers.taskKey })
    .from(opsTriggers)
    .where(eq(opsTriggers.id, id))
    .limit(1);
  if (!peek) return null;
  const task = await lockTaskBy(tx, eq(opsTasks.taskKey, peek.taskKey));
  const [trigger] = await tx
    .select()
    .from(opsTriggers)
    .where(eq(opsTriggers.id, id))
    .limit(1)
    .for("update");
  return task && trigger ? { task, trigger } : null;
}

/** 任务 revision+1（自身编辑与一切旁路写共用） */
async function bumpTask(tx: DbTx, task: TaskRow, set: Partial<typeof opsTasks.$inferInsert> = {}) {
  const revision = task.revision + 1;
  await tx
    .update(opsTasks)
    .set({ ...set, revision, updatedAt: nowBeijingWallTime() })
    .where(eq(opsTasks.id, task.id));
  return revision;
}

/** 写事务提交成功后通知管线热加载（best-effort） */
async function committed<T>(pending: OpsResult<T> | Promise<OpsResult<T>>): Promise<OpsResult<T>> {
  const result = await pending;
  if (result.ok) await notifyOpsReload();
  return result;
}

function checkName(raw: string): string | null {
  const name = raw.trim();
  return name && name.length <= 60 ? name : null;
}

// ── 读取 ────────────────────────────────────────────────

/**
 * 任务清单；配置表不存在（全新安装尚未跑迁移 0025）时返回空数组——零表韧性（M14 F12 同语义：
 * 运维页降级空态而非 500）。其余数据库错误照常抛出。
 */
export async function listOpsTasks(): Promise<OpsTaskView[]> {
  let tasks: TaskRow[];
  try {
    tasks = await getWebDb().select().from(opsTasks).orderBy(asc(opsTasks.taskKey));
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
  if (tasks.length === 0) return [];
  const triggers = await getWebDb()
    .select()
    .from(opsTriggers)
    .where(
      inArray(
        opsTriggers.taskKey,
        tasks.map((task) => task.taskKey),
      ),
    )
    .orderBy(asc(opsTriggers.id));
  return tasks.map((task) => ({
    id: task.id,
    taskKey: task.taskKey,
    name: task.name,
    executor: task.executor,
    params: task.params as Record<string, unknown>,
    enabled: task.enabled,
    revision: task.revision,
    triggers: triggers
      .filter((trigger) => trigger.taskKey === task.taskKey)
      .map(({ id, kind, expr, enabled, revision }) => ({ id, kind, expr, enabled, revision })),
  }));
}

// ── 任务写路径 ──────────────────────────────────────────

/** 任务写路径的公共骨架：withDeadlockRetry + 事务 + committed（成功后通知管线热加载） */
function taskTx<T>(fn: (tx: DbTx) => Promise<OpsResult<T>>): Promise<OpsResult<T>> {
  return committed(withDeadlockRetry(() => getWebDb().transaction(fn)));
}

export interface TaskInput {
  taskKey: string;
  name: string;
  executor: string;
  params: unknown;
  triggers: { kind: string; expr: string | null | undefined }[];
}

export async function createOpsTask(input: TaskInput, actor: ConfigActor): Promise<OpsResult> {
  const key = validateTaskKey(input.taskKey);
  if (!key.ok) return { ok: false, code: "bad-input", message: key.message };
  const params = validateOpsParams(input.executor, input.params);
  if (!params.ok) return { ok: false, code: "bad-input", message: params.message };
  const name = checkName(input.name);
  if (!name) return { ok: false, code: "bad-input", message: "任务名须为 1–60 字" };
  const triggers: { kind: TriggerRow["kind"]; expr: string | null }[] = [];
  for (const raw of input.triggers) {
    const checked = validateTrigger(raw.kind, raw.expr);
    if (!checked.ok) return { ok: false, code: "bad-input", message: checked.message };
    triggers.push(checked.value);
  }

  const now = nowBeijingWallTime();
  return taskTx(async (tx) => {
    // 加锁读：键不存在时持间隙锁，并发同键新建串行化（或死锁后重试看到对方已提交的行）
    if (await lockTaskBy(tx, eq(opsTasks.taskKey, key.value))) {
      return { ok: false, code: "bad-input", message: `任务键已存在：${key.value}` };
    }
    const id = insertIdOf(
      await tx.insert(opsTasks).values({
        taskKey: key.value,
        name,
        executor: input.executor,
        params: params.value,
        enabled: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
    );
    if (triggers.length > 0) {
      await tx.insert(opsTriggers).values(
        triggers.map((trigger) => ({
          taskKey: key.value,
          ...trigger,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await audit(tx, actor, "ops.task.create", { type: "ops_task", id: key.value }, null, {
      name,
      executor: input.executor,
      params: params.value,
      triggers,
      enabled: true,
      revision: 1,
    });
    return { ok: true, value: { id } };
  });
}

/** 锁定任务行 + 冲突检查（revision=null 跳过比较）：not-found / conflict 的公共前置 */
async function lockTaskForWrite(
  tx: DbTx,
  where: ReturnType<typeof eq>,
  expectedRevision: number | null,
): Promise<TaskRow | { ok: false; code: "not-found" | "conflict" }> {
  const row = await lockTaskBy(tx, where);
  if (!row) return { ok: false, code: "not-found" };
  if (expectedRevision !== null && row.revision !== expectedRevision) {
    return { ok: false, code: "conflict" };
  }
  return row;
}

/** 编辑任务（名称 / 参数；执行器与任务键创建后不可改）：revision 与库内不一致 → conflict */
export async function updateOpsTask(
  id: number,
  expectedRevision: number,
  input: { name?: string; params?: unknown },
  actor: ConfigActor,
): Promise<OpsResult> {
  return taskTx(async (tx) => {
    const row = await lockTaskForWrite(tx, eq(opsTasks.id, id), expectedRevision);
    if (!("id" in row)) return row;
    const set: Partial<typeof opsTasks.$inferInsert> = {};
    if (input.name !== undefined) {
      const name = checkName(input.name);
      if (!name) return { ok: false, code: "bad-input", message: "任务名须为 1–60 字" };
      set.name = name;
    }
    if (input.params !== undefined) {
      const params = validateOpsParams(row.executor, input.params);
      if (!params.ok) return { ok: false, code: "bad-input", message: params.message };
      set.params = params.value;
    }
    if (Object.keys(set).length === 0) {
      return { ok: false, code: "bad-input", message: "没有可保存的变更" };
    }
    const revision = await bumpTask(tx, row, set);
    await audit(
      tx,
      actor,
      "ops.task.update",
      { type: "ops_task", id: row.taskKey },
      taskSnapshot(row),
      {
        ...set,
        revision,
      },
    );
    return { ok: true, value: { id } };
  });
}

/** 启停：旁路写同样 revision+1（G-20），使打开着的编辑页下次提交能感知并发 */
export async function setOpsTaskEnabled(
  id: number,
  enabled: boolean,
  actor: ConfigActor,
): Promise<OpsResult> {
  return taskTx(async (tx) => {
    const row = await lockTaskBy(tx, eq(opsTasks.id, id));
    if (!row) return { ok: false, code: "not-found" };
    if (row.enabled === enabled) return { ok: true, value: { id } };
    const revision = await bumpTask(tx, row, { enabled });
    await audit(
      tx,
      actor,
      "ops.task.toggle",
      { type: "ops_task", id: row.taskKey },
      { enabled: row.enabled, revision: row.revision },
      { enabled, revision },
    );
    return { ok: true, value: { id } };
  });
}

/** 删除任务连同其触发器（台账里的历史记录归管线管，不受影响） */
export async function deleteOpsTask(id: number, actor: ConfigActor): Promise<OpsResult> {
  return taskTx(async (tx) => {
    const row = await lockTaskBy(tx, eq(opsTasks.id, id));
    if (!row) return { ok: false, code: "not-found" };
    const triggers = await tx
      .select()
      .from(opsTriggers)
      .where(eq(opsTriggers.taskKey, row.taskKey));
    await tx.delete(opsTriggers).where(eq(opsTriggers.taskKey, row.taskKey));
    await tx.delete(opsTasks).where(eq(opsTasks.id, id));
    await audit(
      tx,
      actor,
      "ops.task.delete",
      { type: "ops_task", id: row.taskKey },
      { ...taskSnapshot(row), triggers: triggers.map(triggerSnapshot) },
      null,
    );
    return { ok: true, value: { id } };
  });
}

// ── 触发器写路径（每次都让所属任务 revision+1：触发器是任务的旁路写，G-20） ─────────

/** 触发器写路径的公共骨架：锁（任务 + 触发器）→ 冲突检查 → 修改 → 任务 revision+1 → 审计。
 *  mutate 返回 false 表示目标状态已达成（如启停到同一状态）：不递增、不审计、不算写入。 */
async function withLockedTrigger(
  id: number,
  expectedRevision: number | null,
  actor: ConfigActor,
  action: "ops.trigger.update" | "ops.trigger.toggle" | "ops.trigger.delete",
  mutate: (
    tx: DbTx,
    locked: { task: TaskRow; trigger: TriggerRow },
  ) => Promise<Record<string, unknown> | null | false>,
): Promise<OpsResult> {
  return taskTx(async (tx) => {
    const locked = await lockTriggerWithTask(tx, id);
    if (!locked) return { ok: false, code: "not-found" };
    if (expectedRevision !== null && locked.trigger.revision !== expectedRevision) {
      return { ok: false, code: "conflict" };
    }
    const after = await mutate(tx, locked);
    if (after === false) return { ok: true, value: { id } };
    const taskRevision = await bumpTask(tx, locked.task);
    await audit(tx, actor, action, { type: "ops_trigger", id }, triggerSnapshot(locked.trigger), {
      taskKey: locked.trigger.taskKey,
      ...(after ?? {}),
      taskRevision,
    });
    return { ok: true, value: { id } };
  });
}

/** 触发器入参的公共校验（创建与编辑共用） */
function checkTriggerInput(input: { kind: string; expr: string | null | undefined }) {
  return validateTrigger(input.kind, input.expr);
}

export async function createOpsTrigger(
  taskKey: string,
  input: { kind: string; expr: string | null | undefined },
  actor: ConfigActor,
): Promise<OpsResult> {
  const checked = checkTriggerInput(input);
  if (!checked.ok) return { ok: false, code: "bad-input", message: checked.message };
  return taskTx(async (tx) => {
    const task = await lockTaskForWrite(tx, eq(opsTasks.taskKey, taskKey), null);
    if (!("id" in task)) return task;
    // 触发器走 update（同样 revision+1）而不是 insert，减少一条与编辑路径重复的分支
    const id = insertIdOf(
      await tx.insert(opsTriggers).values({
        taskKey,
        ...checked.value,
        enabled: true,
        revision: 1,
        createdAt: nowBeijingWallTime(),
        updatedAt: nowBeijingWallTime(),
      }),
    );
    const taskRevision = await bumpTask(tx, task);
    await audit(tx, actor, "ops.trigger.create", { type: "ops_trigger", id }, null, {
      ...checked.value,
      enabled: true,
      revision: 1,
      taskRevision,
    });
    return { ok: true, value: { id } };
  });
}

/** 编辑触发器：revision 与库内不一致 → conflict */
export async function updateOpsTrigger(
  id: number,
  expectedRevision: number,
  input: { kind: string; expr: string | null | undefined },
  actor: ConfigActor,
): Promise<OpsResult> {
  const checked = checkTriggerInput(input);
  if (!checked.ok) return { ok: false, code: "bad-input", message: checked.message };
  return await withLockedTrigger(
    id,
    expectedRevision,
    actor,
    "ops.trigger.update",
    async (tx, locked) => {
      const revision = locked.trigger.revision + 1;
      await tx
        .update(opsTriggers)
        .set({ ...checked.value, revision, updatedAt: nowBeijingWallTime() })
        .where(eq(opsTriggers.id, id));
      return { ...checked.value, revision };
    },
  );
}

export async function setOpsTriggerEnabled(
  id: number,
  enabled: boolean,
  actor: ConfigActor,
): Promise<OpsResult> {
  return await withLockedTrigger(id, null, actor, "ops.trigger.toggle", async (tx, locked) => {
    if (locked.trigger.enabled === enabled) return false;
    const revision = locked.trigger.revision + 1;
    await tx
      .update(opsTriggers)
      .set({ enabled, revision, updatedAt: nowBeijingWallTime() })
      .where(eq(opsTriggers.id, id));
    return { enabled, revision };
  });
}

export async function deleteOpsTrigger(id: number, actor: ConfigActor): Promise<OpsResult> {
  return await withLockedTrigger(id, null, actor, "ops.trigger.delete", async (tx) => {
    await tx.delete(opsTriggers).where(eq(opsTriggers.id, id));
    return null;
  });
}

// ── 手动触发资格（Action 前置校验；触发本身走管线客户端） ────────────────────

export type ManualTriggerCheck =
  | { ok: true; task: OpsTaskView }
  | { ok: false; code: "not-found" | "disabled" | "no-manual-trigger" };

/** 任务存在、启用且配置了启用中的手动触发器才允许手动触发 */
export async function getManuallyTriggerableTask(taskKey: string): Promise<ManualTriggerCheck> {
  const tasks = await listOpsTasks();
  const task = tasks.find((t) => t.taskKey === taskKey);
  if (!task) return { ok: false, code: "not-found" };
  if (!task.enabled) return { ok: false, code: "disabled" };
  const manual = task.triggers.find((t) => t.kind === "manual" && t.enabled);
  return manual ? { ok: true, task } : { ok: false, code: "no-manual-trigger" };
}

// ── 备份保留份数（备份任务参数 keep；v1 后台设置区沿用这组读写） ──────────────────

export interface BackupRetention {
  keepDb: number;
  keepStorage: number;
}

const RETENTION_TASKS = [
  { taskKey: "backup.db", field: "keepDb", fallback: 14 },
  { taskKey: "backup.storage", field: "keepStorage", fallback: 7 },
] as const;

function keepOf(params: unknown): number | null {
  const keep = (params as { keep?: unknown } | null)?.keep;
  return typeof keep === "number" && Number.isInteger(keep) && keep >= 1 && keep <= 90
    ? keep
    : null;
}

/**
 * 当前生效的保留份数，与管线的解析顺序一致：任务参数 keep → v1 保留策略 site_settings → 默认 14 / 7。
 */
export async function getBackupRetention(): Promise<BackupRetention> {
  // 复用 listOpsTasks（配置表缺失时返回 []，零表韧性同语义）
  const all = await listOpsTasks();
  const tasks = all
    .filter((t) => RETENTION_TASKS.some((r) => r.taskKey === t.taskKey))
    .map((t) => ({ taskKey: t.taskKey, params: t.params as unknown }));
  const [legacy] = await getWebDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, LEGACY_BACKUP_POLICY_KEY))
    .limit(1);
  const resolve = ({ taskKey, field, fallback }: (typeof RETENTION_TASKS)[number]) =>
    keepOf(tasks.find((t) => t.taskKey === taskKey)?.params) ??
    legacyKeep(legacy?.value, field, fallback);
  return { keepDb: resolve(RETENTION_TASKS[0]), keepStorage: resolve(RETENTION_TASKS[1]) };
}

/** 保存保留份数：两条备份任务的参数 keep 同一事务改写（各自 revision+1、各写一条审计）。
 *  先把两条任务都锁住并确认存在、再动第一笔写——drizzle 的事务回调正常返回即提交，
 *  「改完第一条才发现第二条不在」时返回错误码并不会回滚已改的那条。 */
export async function setBackupRetention(
  retention: BackupRetention,
  actor: ConfigActor,
): Promise<OpsResult<BackupRetention>> {
  for (const { field } of RETENTION_TASKS) {
    if (keepOf({ keep: retention[field] }) === null) {
      return { ok: false, code: "bad-input", message: "保留份数须为 1–90 的整数" };
    }
  }
  return taskTx(async (tx) => {
    const rows: TaskRow[] = [];
    for (const { taskKey } of RETENTION_TASKS) {
      const row = await lockTaskBy(tx, eq(opsTasks.taskKey, taskKey));
      if (!row) return { ok: false, code: "not-found", message: `备份任务不存在：${taskKey}` };
      rows.push(row);
    }
    for (const [index, { taskKey, field }] of RETENTION_TASKS.entries()) {
      const row = rows[index]!;
      const params = { ...(row.params as Record<string, unknown>), keep: retention[field] };
      const revision = await bumpTask(tx, row, { params });
      await audit(
        tx,
        actor,
        "ops.task.update",
        { type: "ops_task", id: taskKey },
        taskSnapshot(row),
        {
          params,
          revision,
        },
      );
    }
    return { ok: true, value: retention };
  });
}

/** 手动触发的审计（管线已受理、拿到 run id 才记——没有发生任何事的失败尝试不记） */
export async function recordManualTrigger(taskKey: string, runId: number, actor: ConfigActor) {
  await writeAudit(getWebDb(), {
    actorId: actor.userId,
    action: "ops.task.run",
    targetType: "ops_task",
    targetId: taskKey,
    after: { runId, via: actor.via },
    ip: actor.ip,
  });
}
