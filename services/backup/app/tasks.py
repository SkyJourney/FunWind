"""任务定义：配置表（web 写，M14 D1）优先，配置表未就绪时回落内置默认（零表韧性，M14 §3.1）。

配置表由 Step 2 的 drizzle 迁移创建，列契约以此为准（Step 2 的契约测试守护两端一致）：
  ops_tasks(task_key UNIQUE, name, executor, params JSON, enabled, revision, …)
  ops_triggers(id, task_key, kind ENUM('cron','once','manual'), expr NULL, enabled, revision, …)

配置表存在但没有任何任务行，同样回落内置默认：备份是兜底能力，「表被清空」更可能是事故而不是
意图——要停掉某个任务应把它的 enabled 置 0，而不是删光配置。
"""
import hashlib
import json
from dataclasses import dataclass, field, replace

from . import config, db
from .executors import REGISTRY, ParamsError
from .triggers import TriggerConfigError, TriggerDef

TASKS_TABLE = "ops_tasks"
TRIGGERS_TABLE = "ops_triggers"


@dataclass(frozen=True)
class TaskDef:
    key: str
    name: str
    executor: str
    params: dict
    enabled: bool
    triggers: tuple[TriggerDef, ...]

    def manual_trigger(self) -> TriggerDef | None:
        """启用中的手动触发器（有它才允许后台/API 手动触发）。"""
        return next((t for t in self.triggers if t.kind == "manual" and t.enabled), None)


@dataclass
class LoadResult:
    tasks: list[TaskDef]
    source: str  # "config" | "default"
    problems: list[str] = field(default_factory=list)


def default_tasks() -> list[TaskDef]:
    """内置默认任务（= v1 的两条备份 cron + 手动触发；配置表未就绪时使用）。"""

    def backup_task(key: str, name: str, cron: str) -> TaskDef:
        return TaskDef(
            key=key,
            name=name,
            executor=key,
            params={},
            enabled=True,
            triggers=(
                TriggerDef(f"default:{key}:cron", key, "cron", cron),
                TriggerDef(f"default:{key}:manual", key, "manual", None),
            ),
        )

    return [
        backup_task("backup.db", "数据库备份", config.DB_CRON),
        backup_task("backup.storage", "存储备份", config.STORAGE_CRON),
    ]


def _checked(raw_tasks: list[TaskDef], problems: list[str]) -> list[TaskDef]:
    """逐项校验：执行器未注册 / 参数非法 → 跳过整个任务；触发器非法 → 只跳过该触发器。"""
    result = []
    for task in raw_tasks:
        spec = REGISTRY.get(task.executor)
        if spec is None:
            problems.append(f"任务 {task.key}：未注册的执行器 {task.executor}")
            continue
        try:
            params = spec.validate(task.params)
        except ParamsError as exc:
            problems.append(f"任务 {task.key}：{exc}")
            continue
        triggers = []
        for trigger in task.triggers:
            try:
                triggers.append(trigger.validated())
            except TriggerConfigError as exc:
                problems.append(f"触发器 {trigger.key}（任务 {task.key}）：{exc}")
        result.append(replace(task, params=params, triggers=tuple(triggers)))
    return result


def _parse_params(raw: object) -> dict | None:
    """JSON 列 → dict；不是 JSON 对象返回 None（pymysql 把 JSON 列读成字符串）。"""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, (str, bytes)):
        try:
            value = json.loads(raw)
        except ValueError:
            return None
        return value if isinstance(value, dict) else None
    return None


def load_tasks(conn) -> LoadResult:
    """加载任务定义（配置表优先，未就绪回落内置默认），并逐项校验。"""
    problems: list[str] = []
    if not (db.table_exists(conn, TASKS_TABLE) and db.table_exists(conn, TRIGGERS_TABLE)):
        return LoadResult(_checked(default_tasks(), problems), "default", problems)

    with conn.cursor() as cur:
        cur.execute(f"SELECT task_key, name, executor, params, enabled FROM `{TASKS_TABLE}` ORDER BY task_key")
        task_rows = cur.fetchall()
        cur.execute(f"SELECT id, task_key, kind, expr, enabled FROM `{TRIGGERS_TABLE}` ORDER BY id")
        trigger_rows = cur.fetchall()

    if not task_rows:
        problems.append("配置表 ops_tasks 为空，回落内置默认任务（要停用任务请置 enabled=0，不要删行）")
        return LoadResult(_checked(default_tasks(), problems), "default", problems)

    triggers_by_task: dict[str, list[TriggerDef]] = {}
    for trigger_id, task_key, kind, expr, enabled in trigger_rows:
        triggers_by_task.setdefault(str(task_key), []).append(
            TriggerDef(f"t{trigger_id}", str(task_key), str(kind), expr, bool(enabled))
        )

    raw_tasks = []
    for task_key, name, executor, params, enabled in task_rows:
        parsed = _parse_params(params)
        if parsed is None:
            problems.append(f"任务 {task_key}：params 不是 JSON 对象")
            continue
        raw_tasks.append(
            TaskDef(
                key=str(task_key),
                name=str(name),
                executor=str(executor),
                params=parsed,
                enabled=bool(enabled),
                triggers=tuple(triggers_by_task.pop(str(task_key), [])),
            )
        )
    for orphan_key in sorted(triggers_by_task):
        problems.append(f"触发器指向不存在的任务 {orphan_key}，已忽略")

    return LoadResult(_checked(raw_tasks, problems), "config", problems)


def fingerprint(tasks: list[TaskDef]) -> str:
    """配置指纹：内容不变则不重登触发器（周期对账的变更判定）。"""
    payload = [
        {
            "key": task.key,
            "executor": task.executor,
            "params": task.params,
            "enabled": task.enabled,
            "triggers": [[t.key, t.kind, t.expr, t.enabled] for t in task.triggers],
        }
        for task in sorted(tasks, key=lambda t: t.key)
    ]
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]
