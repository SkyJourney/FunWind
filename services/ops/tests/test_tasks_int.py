"""任务定义加载：配置表 → 内置默认回落（零表韧性）与逐项校验——真实 MySQL 临时库。"""
import pytest

from app import tasks
from contract import add_task, add_trigger, create_config_tables

pytestmark = pytest.mark.db


def test_missing_config_tables_fall_back_to_builtin_defaults(db_conn):
    loaded = tasks.load_tasks(db_conn)
    assert loaded.source == "default" and loaded.problems == []
    assert [t.key for t in loaded.tasks] == ["backup.db", "backup.storage"]
    db_task = loaded.tasks[0]
    assert [(t.kind, t.expr) for t in db_task.triggers] == [("cron", "10 3 * * *"), ("manual", None)]
    assert db_task.manual_trigger().key == "default:backup.db:manual"


def test_empty_config_table_falls_back_and_reports(db_conn):
    create_config_tables(db_conn)
    loaded = tasks.load_tasks(db_conn)
    assert loaded.source == "default"
    assert any("为空" in problem for problem in loaded.problems)


def test_config_rows_are_loaded_and_bad_items_skipped_with_problems(db_conn):
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db", '{"keep": 5}')
    good_cron = add_trigger(db_conn, "backup.db", "cron", "0 4 * * mon")
    add_trigger(db_conn, "backup.db", "cron", "0 4 * * 1")  # 数字星期 → 只跳过这一个触发器
    manual = add_trigger(db_conn, "backup.db", "manual")
    add_task(db_conn, "mystery", "unknown.exec")  # 未注册执行器 → 跳过整个任务
    add_task(db_conn, "backup.storage", "backup.storage", '{"keep": 0}')  # 参数非法 → 跳过整个任务
    add_task(db_conn, "listy", "backup.db", "[1, 2]")  # params 不是对象 → 跳过整个任务
    add_trigger(db_conn, "ghost", "cron", "0 1 * * *")  # 孤儿触发器

    loaded = tasks.load_tasks(db_conn)

    assert loaded.source == "config"
    assert [t.key for t in loaded.tasks] == ["backup.db"]
    task = loaded.tasks[0]
    assert task.params == {"keep": 5}
    assert [(t.key, t.kind, t.expr) for t in task.triggers] == [
        (f"t{good_cron}", "cron", "0 4 * * mon"),
        (f"t{manual}", "manual", None),
    ]
    problems = "\n".join(loaded.problems)
    for fragment in ("星期字段须用名称", "未注册的执行器", "keep 须为", "不是 JSON 对象", "不存在的任务 ghost"):
        assert fragment in problems


def test_disabled_task_and_trigger_are_loaded_but_flagged(db_conn):
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db", enabled=False)
    add_trigger(db_conn, "backup.db", "manual", enabled=False)
    task = tasks.load_tasks(db_conn).tasks[0]
    assert task.enabled is False
    assert task.manual_trigger() is None


def test_fingerprint_tracks_content_changes(db_conn):
    first = tasks.fingerprint(tasks.load_tasks(db_conn).tasks)
    assert tasks.fingerprint(tasks.load_tasks(db_conn).tasks) == first
    create_config_tables(db_conn)
    add_task(db_conn, "backup.db", "backup.db")
    add_trigger(db_conn, "backup.db", "cron", "0 5 * * *")
    assert tasks.fingerprint(tasks.load_tasks(db_conn).tasks) != first
