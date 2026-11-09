"""执行器注册表、恢复目标库白名单（C1）与客户端凭据传递（C2）。"""
import os
import stat
from pathlib import Path

import pytest

from app import backup, config
from app.executors import REGISTRY, ParamsError, kinds_in_group
from app.restore import validate_target_db


def test_registry_keys_and_lock_groups():
    assert set(REGISTRY) == {"backup.db", "backup.storage", "campaign.holiday"}
    assert {spec.run_kind for spec in REGISTRY.values()} == {"db", "storage", "holiday"}
    backup = {k for k, s in REGISTRY.items() if s.lock_group == "backup"}
    assert backup == {"backup.db", "backup.storage"}


def test_backup_group_covers_restore_and_drill():
    """恢复与备份共用一把锁：手动触发的忙碌预检必须把 restore/drill 也算进去。"""
    assert set(kinds_in_group("backup")) == {"db", "storage", "restore", "drill"}
    assert kinds_in_group("unknown") == ()


@pytest.mark.parametrize("raw, expected", [({}, {}), ({"keep": 1}, {"keep": 1}), ({"keep": 90}, {"keep": 90})])
def test_retention_params_accepts(raw, expected):
    assert REGISTRY["backup.db"].validate(raw) == expected


@pytest.mark.parametrize("raw", [{"keep": 0}, {"keep": 91}, {"keep": True}, {"keep": "7"}, {"keep": 7.0}, {"keepDb": 7}])
def test_retention_params_rejects(raw):
    with pytest.raises(ParamsError):
        REGISTRY["backup.storage"].validate(raw)


@pytest.mark.parametrize("name", ["qingyisub", "ops_test_1", "A_b9", "x" * 64])
def test_validate_target_db_accepts(name):
    assert validate_target_db(name) == name


@pytest.mark.parametrize(
    "name",
    ["", "a;b", "x`y", "db name", "a-b", "../x", "x" * 65, "mysql", "SYS", "information_schema", "performance_schema"],
)
def test_validate_target_db_rejects(name):
    with pytest.raises(ValueError):
        validate_target_db(name)


def test_client_option_file_escapes_and_is_private(monkeypatch):
    monkeypatch.setattr(config, "DB_HOST", "funwind-mysql")
    monkeypatch.setattr(config, "DB_PORT", 3306)
    monkeypatch.setattr(config, "DB_USER", "root")
    monkeypatch.setattr(config, "DB_PASSWORD", 'p"a\\ss#1 x')
    with backup.client_option_file() as path:
        content = Path(path).read_text(encoding="utf-8")
        mode = stat.S_IMODE(os.stat(path).st_mode)
    assert content.splitlines()[0] == "[client]"
    assert 'password="p\\"a\\\\ss#1 x"' in content
    assert mode == 0o600
    assert not Path(path).exists(), "option 文件必须在用完后删除"


def test_dump_command_passes_credentials_by_file_not_argv(tmp_path):
    command = backup.dump_command("/tmp/opt file.cnf", "qingyisub", tmp_path / "out.sql.gz")
    assert command.startswith("exec mysqldump --defaults-extra-file='/tmp/opt file.cnf' ")
    assert " -p" not in command and "--password" not in command


def test_keep_latest_removes_oldest_matching_only(tmp_path):
    for name in ["db-x-1.sql.gz", "db-x-2.sql.gz", "db-x-3.sql.gz", "storage-1.tgz", "db-x-notes.txt"]:
        (tmp_path / name).write_text("x")
    removed = backup.keep_latest(tmp_path, "db-x-", 2)
    assert removed == ["db-x-1.sql.gz"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["db-x-2.sql.gz", "db-x-3.sql.gz", "db-x-notes.txt", "storage-1.tgz"]


def test_keep_latest_ignores_pre_restore_safety_dumps(tmp_path):
    """恢复前的安全 dump 不参与轮转：既不被删，也不挤占保留份数（v1 缺陷回归钉子）。"""
    names = [
        "db-x-2026-11-01-031000-aaaaaa.sql.gz",
        "db-x-2026-11-02-031000-bbbbbb.sql.gz",
        "db-x-2026-11-03-031000-cccccc.sql.gz",
        "db-x-pre-restore-2026-11-02-120000.sql.gz",
    ]
    for name in names:
        (tmp_path / name).write_text("x")
    removed = backup.keep_latest(tmp_path, "db-x-", 2)
    assert removed == ["db-x-2026-11-01-031000-aaaaaa.sql.gz"]
    assert (tmp_path / "db-x-pre-restore-2026-11-02-120000.sql.gz").exists()
    assert (tmp_path / "db-x-2026-11-02-031000-bbbbbb.sql.gz").exists()


def test_resolve_keep_prefers_task_param_without_touching_db(monkeypatch):
    def explode():
        raise AssertionError("有任务参数时不应读库")

    monkeypatch.setattr(backup.db, "connect", explode)
    assert backup.resolve_keep("db", 14, 3) == 3


def test_resolve_keep_falls_back_to_env_default_when_db_fails(monkeypatch):
    def broken():
        raise RuntimeError("库不可达")

    monkeypatch.setattr(backup.db, "connect", broken)
    assert backup.resolve_keep("storage", 7, None) == 7


def test_reject_busy_settles_pre_inserted_run_only(monkeypatch):
    settled: list[tuple] = []

    def fake_finish(run_id, status, **kwargs):
        settled.append((run_id, status))
        return True

    monkeypatch.setattr(backup.ledger, "finish_run", fake_finish)
    with pytest.raises(backup.LockBusyError):
        backup.reject_busy(None)
    with pytest.raises(backup.LockBusyError):
        backup.reject_busy(7)
    assert settled == [(7, "failed")]


def test_keep_latest_never_removes_the_protected_current_file(tmp_path):
    """当前文件即便字典序最小（时间戳回拨、同刻随机后缀排在前面）也不删：它计入保留份数，
    删掉的是其余文件里最旧的那些。"""
    names = ["db-x-2026-11-09-120000-000001-ffffff.sql.gz", "db-x-2026-11-09-120000-000002-bbbbbb.sql.gz"]
    for name in names:
        (tmp_path / name).write_text("x")
    current = "db-x-2026-11-09-120000-000000-aaaaaa.sql.gz"
    (tmp_path / current).write_text("x")
    assert backup.keep_latest(tmp_path, "db-x-", 2, protect=current) == [names[0]]
    assert sorted(p.name for p in tmp_path.iterdir()) == [current, names[1]]
    assert backup.keep_latest(tmp_path, "db-x-", 1, protect=current) == [names[1]]
    assert [p.name for p in tmp_path.iterdir()] == [current]


def test_file_stamp_is_fixed_width_and_time_ordered():
    first = backup.file_stamp()
    second = backup.file_stamp()
    assert len(first) == len("2026-11-09-120000-123456")
    assert first <= second
