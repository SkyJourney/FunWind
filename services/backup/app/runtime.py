"""管线运行时：启动引导（降级与重试）、配置加载与周期对账、触发器登记、手动触发（异步）。

启动不阻塞：uvicorn 先起来提供 /health，引导在后台线程里做（台账演进 → 回收残留 → 启动调度器 →
加载配置并登记触发器）；库不通就按间隔重试，期间 /health 返回 503（M14 F23：不再崩溃循环）。

调度定义一律来自任务配置（或其内置默认回落），代码里不再硬编码 add_job——M13 双定时线教训：
同一时间只能有一条调度路径。
"""
import logging
import threading
from dataclasses import dataclass, field

from apscheduler.schedulers.base import STATE_STOPPED

from . import config, db, ledger
from .backup import LockBusyError
from .executors import REGISTRY, kinds_in_group
from .tasks import TaskDef, fingerprint, load_tasks
from .triggers import build_schedule

log = logging.getLogger("ops.runtime")

TRIGGER_JOB_PREFIX = "trigger:"
MANUAL_JOB_PREFIX = "manual:"
RECONCILE_JOB_ID = "ops:reconcile"


class RuntimeUnavailable(RuntimeError):
    """管线处于降级状态（缺必需配置 / 库不可达 / 尚未完成引导）。"""


class TaskNotFound(LookupError):
    """任务不存在。"""


class ManualTriggerRejected(ValueError):
    """任务已停用，或没有启用中的手动触发器。"""


class TaskBusy(RuntimeError):
    """同一互斥组已有任务在执行。"""


@dataclass
class RuntimeStatus:
    ready: bool = False
    missing_env: list[str] = field(default_factory=list)
    last_error: str | None = None
    config_source: str | None = None
    fingerprint: str | None = None
    problems: list[str] = field(default_factory=list)
    schema_actions: list[str] = field(default_factory=list)


def run_now(task: TaskDef, trigger: str = "manual") -> dict:
    """同步执行一个任务（不经调度器）：兼容旧 POST /runs 与 CLI，与定时/异步触发是同一执行器。"""
    spec = REGISTRY[task.executor]
    return spec.run(task.params, trigger=trigger, task_key=task.key, run_id=None)


class PipelineRuntime:
    def __init__(self, scheduler):
        self.scheduler = scheduler
        self.status = RuntimeStatus()
        self._tasks: dict[str, TaskDef] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()

    # ── 生命周期 ─────────────────────────────────────────

    def start(self) -> None:
        """非阻塞启动：缺必需配置则只停留在降级态；否则在后台线程引导（失败按间隔重试）。"""
        self.status.missing_env = config.missing_required_env()
        if self.status.missing_env:
            log.error(
                "缺少必需环境变量 %s：服务以降级模式运行（/health 503，调度器不启动）",
                "、".join(self.status.missing_env),
            )
            return
        threading.Thread(target=self._bootstrap_loop, name="ops-bootstrap", daemon=True).start()

    def shutdown(self) -> None:
        self._stop.set()
        if self.scheduler.state != STATE_STOPPED:
            self.scheduler.shutdown(wait=False)

    def _bootstrap_loop(self) -> None:
        while not self._stop.is_set():
            if self.bootstrap_once():
                return
            self._stop.wait(config.BOOTSTRAP_RETRY_SECONDS)

    def bootstrap_once(self) -> bool:
        """引导一次：成功返回 True；失败记录原因并返回 False（由调用方按间隔重试）。"""
        try:
            conn = db.connect()
            try:
                self.status.schema_actions = ledger.ensure_schema(conn)
            finally:
                conn.close()
            recovered = ledger.recover_stale_runs(config.STALE_RUN_MINUTES)
            if recovered:
                log.warning(
                    "回收进程中断残留 %d 条（running 超过 %d 分钟，已标记 failed）",
                    recovered,
                    config.STALE_RUN_MINUTES,
                )
            if self.scheduler.state == STATE_STOPPED:
                self.scheduler.start()
            self.reload()
            self.scheduler.add_job(
                self.reconcile,
                "interval",
                seconds=config.RECONCILE_SECONDS,
                id=RECONCILE_JOB_ID,
                replace_existing=True,
                coalesce=True,
                max_instances=1,
            )
            self.status.ready = True
            self.status.last_error = None
            log.info(
                "管线就绪：配置来源=%s，任务 %d 个，台账演进=%s",
                self.status.config_source,
                len(self._tasks),
                "、".join(self.status.schema_actions) or "无",
            )
            return True
        except Exception as exc:
            self.status.last_error = str(exc)[:300]
            log.warning("引导失败，%d 秒后重试：%s", config.BOOTSTRAP_RETRY_SECONDS, exc)
            return False

    def unavailable_reason(self) -> str:
        if self.status.missing_env:
            return f"服务降级：缺少必需环境变量 {'、'.join(self.status.missing_env)}"
        return f"服务降级：尚未完成引导（{self.status.last_error or '启动中'}）"

    # ── 配置加载与触发器登记 ──────────────────────────────

    def reload(self) -> dict:
        """重新加载任务配置；配置指纹变化才重登触发器（热加载通知与周期对账共用）。"""
        with self._lock:
            conn = db.connect()
            try:
                loaded = load_tasks(conn)
            finally:
                conn.close()
            new_fingerprint = fingerprint(loaded.tasks)
            changed = new_fingerprint != self.status.fingerprint
            self._tasks = {task.key: task for task in loaded.tasks}
            if changed:
                self._register(loaded.tasks)
                for problem in loaded.problems:
                    log.warning("配置问题：%s", problem)
                log.info("触发器已按配置重登（来源=%s，指纹=%s）", loaded.source, new_fingerprint)
            self.status.config_source = loaded.source
            self.status.fingerprint = new_fingerprint
            self.status.problems = loaded.problems
            self._sync_states()
            return {
                "changed": changed,
                "source": loaded.source,
                "tasks": sorted(self._tasks),
                "problems": loaded.problems,
            }

    def _register(self, tasks: list[TaskDef]) -> None:
        for job in self.scheduler.get_jobs():
            if job.id.startswith(TRIGGER_JOB_PREFIX):
                job.remove()
        fired = ledger.fired_trigger_keys()
        for task in tasks:
            if not task.enabled:
                continue
            for trigger in task.triggers:
                if not trigger.enabled or trigger.kind == "manual":
                    continue
                if trigger.kind == "once" and trigger.key in fired:
                    continue  # 单次触发器触发过就不再登记
                self.scheduler.add_job(
                    self._fire,
                    build_schedule(trigger),
                    args=[trigger.key, task.key, trigger.kind],
                    id=TRIGGER_JOB_PREFIX + trigger.key,
                    replace_existing=True,
                    coalesce=True,
                    misfire_grace_time=3600,
                    max_instances=1,
                )

    def _next_fire(self, trigger_key: str) -> str | None:
        job = self.scheduler.get_job(TRIGGER_JOB_PREFIX + trigger_key)
        return db.wall_time(job.next_run_time) if job else None

    def _sync_states(self) -> None:
        """把当前生效触发器的「下次运行」写进状态表（后台展示以它为准，web 不复算 cron）。"""
        entries: dict[str, tuple[str, str | None]] = {}
        for task in self._tasks.values():
            if not task.enabled:
                continue
            for trigger in task.triggers:
                if trigger.enabled:
                    entries[trigger.key] = (task.key, self._next_fire(trigger.key))
        ledger.sync_trigger_states(entries)

    def reconcile(self) -> None:
        """周期对账（热加载通知的兜底）：重载配置 + 回收残留；失败只记日志，下个周期再试。"""
        try:
            self.reload()
            ledger.recover_stale_runs(config.STALE_RUN_MINUTES)
        except Exception as exc:
            self.status.last_error = str(exc)[:300]
            log.warning("周期对账失败：%s", exc)

    # ── 执行 ─────────────────────────────────────────────

    def _fire(self, trigger_key: str, task_key: str, source: str) -> None:
        """调度器到点回调（在调度器线程池里执行）。"""
        task = self._tasks.get(task_key)
        if task is None or not task.enabled:
            log.warning("[ops] task=%s trigger=%s status=skipped 任务已不存在或已停用", task_key, trigger_key)
            return
        self._execute(task, trigger_key, source, None)

    def _execute(self, task: TaskDef, trigger_key: str, source: str, run_id: int | None) -> None:
        spec = REGISTRY[task.executor]
        result, final_run_id = "failed", run_id
        try:
            outcome = spec.run(task.params, trigger=source, task_key=task.key, run_id=run_id)
            final_run_id = outcome.get("run_id", run_id)
            result = "success"
            log.info("[ops] task=%s trigger=%s status=success run=%s", task.key, trigger_key, final_run_id)
        except LockBusyError:
            # 定时触发撞锁 = 本轮跳过；手动触发的预插记录已被收尾为 failed，状态如实记 failed
            result = "skipped" if run_id is None else "failed"
            log.info("[ops] task=%s trigger=%s status=%s 同组已有任务在执行", task.key, trigger_key, result)
        except Exception as exc:
            log.exception("[ops] task=%s trigger=%s status=failed %s", task.key, trigger_key, exc)
        finally:
            try:
                ledger.record_trigger_fire(
                    trigger_key, task.key, final_run_id, result, self._next_fire(trigger_key)
                )
            except Exception:
                log.exception("触发器状态写入失败：%s", trigger_key)

    def trigger_manual(self, task_key: str) -> int:
        """异步手动触发：预检 → 插入 running 记录 → 交给调度器线程池执行，立即返回 run id。"""
        if not self.status.ready:
            raise RuntimeUnavailable(self.unavailable_reason())
        task = self._tasks.get(task_key)
        if task is None:
            raise TaskNotFound(task_key)
        manual = task.manual_trigger()
        if not task.enabled or manual is None:
            raise ManualTriggerRejected(f"任务 {task_key} 已停用或未配置手动触发器")
        spec = REGISTRY[task.executor]
        with self._lock:
            if ledger.running_count(kinds_in_group(spec.lock_group)) > 0:
                raise TaskBusy("同组已有任务在执行，稍后再试")
            run_id = ledger.insert_run(spec.run_kind, "manual", task.key)
        try:
            self.scheduler.add_job(
                self._execute,
                args=[task, manual.key, "manual", run_id],
                id=f"{MANUAL_JOB_PREFIX}{run_id}",
                misfire_grace_time=None,  # 线程池繁忙时晚点跑也要跑，不能因「错过」而丢弃
            )
        except Exception as exc:
            ledger.finish_run(run_id, "failed", error=f"提交执行失败：{str(exc)[:300]}")
            raise
        log.info("[ops] task=%s trigger=%s status=queued run=%d", task.key, manual.key, run_id)
        return run_id

    def task(self, task_key: str) -> TaskDef | None:
        return self._tasks.get(task_key)

    # ── 状态展示 ─────────────────────────────────────────

    def _probe_db(self) -> bool:
        if self.status.missing_env:
            return False
        try:
            conn = db.connect()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
            finally:
                conn.close()
            return True
        except Exception:
            return False

    def health(self) -> tuple[bool, dict]:
        """健康：已引导 + 库可达 + 配置齐全才算健康（compose healthcheck 据此判 unhealthy）。"""
        db_ok = self._probe_db()
        ok = self.status.ready and db_ok and not self.status.missing_env
        jobs = (
            [job.id[len(TRIGGER_JOB_PREFIX):] for job in self.scheduler.get_jobs() if job.id.startswith(TRIGGER_JOB_PREFIX)]
            if self.scheduler.state != STATE_STOPPED
            else []
        )
        return ok, {
            "ok": ok,
            "db": db_ok,
            "ready": self.status.ready,
            "scheduler_jobs": jobs,
            "config_source": self.status.config_source,
            "problems": self.status.problems,
            "missing_env": self.status.missing_env,
            "last_error": self.status.last_error,
        }

    def describe_tasks(self) -> dict:
        """任务与触发器清单（含状态表里的下次/上次触发），供 GET /tasks 与 CLI 展示。"""
        states = ledger.load_trigger_states()
        tasks = []
        for task in sorted(self._tasks.values(), key=lambda t: t.key):
            triggers = []
            for trigger in task.triggers:
                state = states.get(trigger.key, {})
                triggers.append(
                    {
                        "key": trigger.key,
                        "kind": trigger.kind,
                        "expr": trigger.expr,
                        "enabled": trigger.enabled,
                        "next_fire_at": state.get("next_fire_at"),
                        "last_fired_at": state.get("last_fired_at"),
                        "last_result": state.get("last_result"),
                        "last_run_id": state.get("last_run_id"),
                    }
                )
            tasks.append(
                {
                    "key": task.key,
                    "name": task.name,
                    "executor": task.executor,
                    "params": task.params,
                    "enabled": task.enabled,
                    "triggers": triggers,
                }
            )
        return {
            "source": self.status.config_source,
            "fingerprint": self.status.fingerprint,
            "problems": self.status.problems,
            "tasks": tasks,
        }


def _create_default_runtime() -> PipelineRuntime:
    from .scheduler import scheduler

    return PipelineRuntime(scheduler)


runtime = _create_default_runtime()
