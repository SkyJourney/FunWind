"""运行时：引导 / 触发器登记与状态回写 / 配置热加载 / 异步手动触发 / 降级——真实 MySQL + 真实调度器。"""
import time
from dataclasses import replace
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.schedulers.base import STATE_STOPPED

from app import config, executors, ledger
from app.backup import LockBusyError
from app.runtime import (
    ManualTriggerRejected,
    PipelineRuntime,
    RuntimeUnavailable,
    TaskBusy,
    TaskNotFound,
)
from contract import add_task, add_trigger, create_config_tables

pytestmark = pytest.mark.db
SHANGHAI = ZoneInfo("Asia/Shanghai")


@pytest.fixture
def runtime(temp_db):
    rt = PipelineRuntime(BackgroundScheduler(timezone=config.TIMEZONE))
    yield rt
    rt.shutdown()


def _wait_for(predicate, timeout: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def _job_ids(rt: PipelineRuntime) -> list[str]:
    return sorted(job.id for job in rt.scheduler.get_jobs())


def test_bootstrap_registers_default_triggers_and_writes_next_fire(runtime):
    assert runtime.bootstrap_once() is True
    assert runtime.status.ready and runtime.status.config_source == "default"
    ok, body = runtime.health()
    assert ok is True and body["db"] is True
    assert sorted(body["scheduler_jobs"]) == ["default:backup.db:cron", "default:backup.storage:cron"]

    states = ledger.load_trigger_states()
    assert set(states) == {
        "default:backup.db:cron",
        "default:backup.db:manual",
        "default:backup.storage:cron",
        "default:backup.storage:manual",
    }
    next_db = states["default:backup.db:cron"]["next_fire_at"]
    assert (next_db.hour, next_db.minute) == (3, 10)
    assert states["default:backup.db:manual"]["next_fire_at"] is None


def test_named_weekday_cron_lands_on_that_weekday_in_state_table(runtime, db_conn):
    """F8 端到端：配置表里写「每周五」，状态表里的下次运行必须是周五（不是周六）。"""
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db")
    trigger_id = add_trigger(db_conn, "backup.db", "cron", "0 2 * * fri")
    assert runtime.bootstrap_once()
    next_fire = ledger.load_trigger_states()[f"t{trigger_id}"]["next_fire_at"]
    assert next_fire.weekday() == 4 and (next_fire.hour, next_fire.minute) == (2, 0)


def test_reload_reregisters_only_on_change_and_prunes_disabled(runtime, db_conn):
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db")
    trigger_id = add_trigger(db_conn, "backup.db", "cron", "0 4 * * *")
    assert runtime.bootstrap_once()
    assert runtime.reload()["changed"] is False

    with db_conn.cursor() as cur:
        cur.execute("UPDATE ops_triggers SET expr = '30 5 * * *' WHERE id = %s", (trigger_id,))
    assert runtime.reload()["changed"] is True
    next_fire = ledger.load_trigger_states()[f"t{trigger_id}"]["next_fire_at"]
    assert (next_fire.hour, next_fire.minute) == (5, 30)

    with db_conn.cursor() as cur:
        cur.execute("UPDATE ops_tasks SET enabled = 0")
    runtime.reload()
    assert runtime.health()[1]["scheduler_jobs"] == []
    assert ledger.load_trigger_states() == {}


def test_manual_trigger_returns_immediately_and_settles_run(runtime, fake_executors):
    assert runtime.bootstrap_once()
    run_id = runtime.trigger_manual("backup.db")
    assert _wait_for(lambda: ledger.get_run(run_id)["status"] == "success")
    assert fake_executors[-1][:3] == ("backup.db", "manual", run_id)
    assert _wait_for(
        lambda: ledger.load_trigger_states()["default:backup.db:manual"]["last_result"] == "success"
    )


def test_manual_trigger_is_rejected_while_same_group_runs(runtime, fake_executors):
    assert runtime.bootstrap_once()
    ledger.insert_run("restore", "manual", "restore")  # 恢复与备份同一互斥组
    with pytest.raises(TaskBusy):
        runtime.trigger_manual("backup.storage")


def test_manual_trigger_rejections(runtime, db_conn):
    with pytest.raises(RuntimeUnavailable):
        runtime.trigger_manual("backup.db")  # 尚未引导
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db")
    add_trigger(db_conn, "backup.db", "cron", "0 4 * * *")  # 没有手动触发器
    add_task(db_conn, "backup.storage", "backup.storage", enabled=False)
    add_trigger(db_conn, "backup.storage", "manual")
    assert runtime.bootstrap_once()
    with pytest.raises(TaskNotFound):
        runtime.trigger_manual("nope")
    with pytest.raises(ManualTriggerRejected):
        runtime.trigger_manual("backup.db")
    with pytest.raises(ManualTriggerRejected):
        runtime.trigger_manual("backup.storage")


def test_once_trigger_fires_once_and_is_not_reregistered(runtime, db_conn, fake_executors):
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db")
    soon = (datetime.now(SHANGHAI) + timedelta(seconds=2)).strftime("%Y-%m-%d %H:%M:%S")
    trigger_id = add_trigger(db_conn, "backup.db", "once", soon)
    key = f"t{trigger_id}"
    assert runtime.bootstrap_once()

    assert _wait_for(lambda: ledger.load_trigger_states().get(key, {}).get("last_result") == "success", timeout=10)
    assert [call[1] for call in fake_executors] == ["once"]

    add_trigger(db_conn, "backup.db", "manual")  # 改动配置 → 触发重登
    assert runtime.reload()["changed"] is True
    assert f"trigger:{key}" not in _job_ids(runtime)
    # 关键断言是「没有被重复执行」：过期的单次触发器若被重登，会在补跑宽限内立刻再跑一次
    time.sleep(1.5)
    assert [call[1] for call in fake_executors] == ["once"]


def test_cron_fire_hitting_the_lock_is_recorded_as_skipped(runtime, monkeypatch):
    assert runtime.bootstrap_once()

    def busy(params, *, trigger, task_key, run_id=None):
        raise LockBusyError("已有备份/恢复任务在执行")

    monkeypatch.setitem(executors.REGISTRY, "backup.db", replace(executors.REGISTRY["backup.db"], run=busy))
    runtime._fire("default:backup.db:cron", "backup.db", "cron")
    state = ledger.load_trigger_states()["default:backup.db:cron"]
    assert state["last_result"] == "skipped" and state["next_fire_at"] is not None


def test_bootstrap_recovers_stale_running_rows(runtime, db_conn):
    ledger.ensure_schema(db_conn)
    started = (datetime.now(SHANGHAI) - timedelta(hours=5)).strftime("%Y-%m-%d %H:%M:%S")
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ops_runs (kind, task_key, trigger_source, status, started_at) "
            "VALUES ('db', 'backup.db', 'cron', 'running', %s)",
            (started,),
        )
        stale_id = cur.lastrowid
    assert runtime.bootstrap_once()
    assert ledger.get_run(stale_id)["status"] == "failed"


def test_unreachable_database_degrades_without_crashing(runtime, monkeypatch):
    monkeypatch.setattr(config, "DB_PORT", 1)
    assert runtime.bootstrap_once() is False
    ok, body = runtime.health()
    assert ok is False and body["db"] is False and body["ready"] is False
    assert body["scheduler_jobs"] == [] and body["last_error"]


def test_missing_required_env_stays_degraded_and_never_starts_scheduler(runtime, monkeypatch):
    monkeypatch.setattr(config, "OPS_TOKEN", "")
    runtime.start()
    assert runtime.status.missing_env == ["OPS_TOKEN"]
    time.sleep(0.2)
    assert runtime.scheduler.state == STATE_STOPPED
    assert runtime.health()[0] is False
    assert "OPS_TOKEN" in runtime.unavailable_reason()
