"""备份/恢复执行器编排——真实 MySQL（锁 + 台账 + 轮转 + 策略回落）。

mysqldump 以假命令替身（本机无客户端；真实 dump 在 docker 冒烟里验证），但 shell 管道、gzip、
完整性校验（gzip -t + 尾标）、option 文件、GET_LOCK 与台账都真跑。
"""
import gzip
import shlex
import tarfile
from pathlib import Path

import pytest

from app import backup, config, db, ledger, restore

pytestmark = pytest.mark.db


@pytest.fixture
def fake_dump(monkeypatch):
    """替身：产出带尾标的 gzip；记录收到的 option 文件路径（验证用完即删）。"""
    seen: list[str] = []

    def command(option_file: str, database: str, out: Path) -> str:
        seen.append(option_file)
        assert Path(option_file).is_file(), "执行期间 option 文件必须在位"
        return f"printf -- '-- fake dump of %s\\n-- Dump completed\\n' {shlex.quote(database)} | gzip > {shlex.quote(str(out))}"

    monkeypatch.setattr(backup, "dump_command", command)
    return seen


def test_db_backup_writes_artifact_and_ledger_then_rotates(db_conn, fake_dump):
    ledger.ensure_schema(db_conn)
    first = backup.run_db_backup("cron", keep=2)
    with gzip.open(first["path"], "rt") as fh:
        assert "Dump completed" in fh.read()
    assert not Path(fake_dump[0]).exists(), "option 文件必须在用完后删除"

    backup.run_db_backup("cron", keep=2)
    third = backup.run_db_backup("manual", keep=2)

    assert len(third["removed"]) == 1  # 第三份时轮转删掉一份
    assert len(list((Path(config.TARGET_DIR) / "db").iterdir())) == 2
    rows = ledger.list_runs(10)
    assert [r["status"] for r in rows] == ["success"] * 3
    assert {r["task_key"] for r in rows} == {"backup.db"}
    assert [r["trigger_source"] for r in rows] == ["manual", "cron", "cron"]


def test_db_backup_without_trailer_fails_and_is_recorded(db_conn, monkeypatch):
    ledger.ensure_schema(db_conn)
    monkeypatch.setattr(backup, "dump_command", lambda opt, database, out: f"printf 'half' | gzip > {shlex.quote(str(out))}")
    with pytest.raises(RuntimeError, match="完整性校验失败"):
        backup.run_db_backup("cron")
    assert ledger.list_runs(1)[0]["status"] == "failed"


def test_lock_busy_rejects_and_settles_pre_inserted_run(db_conn, fake_dump):
    ledger.ensure_schema(db_conn)
    holder = db.connect()
    try:
        assert backup.acquire_lock(holder)
        run_id = ledger.insert_run("db", "manual", "backup.db")
        with pytest.raises(backup.LockBusyError):
            backup.run_db_backup("manual", run_id=run_id)
        assert ledger.get_run(run_id)["status"] == "failed"
        with pytest.raises(backup.LockBusyError):
            backup.run_db_backup("cron")  # 定时撞锁：不插记录（本轮跳过）
        assert len(ledger.list_runs(10)) == 1
    finally:
        backup.release_lock(holder)
        holder.close()


def test_storage_backup_tars_source_excluding_regenerable_dirs(db_conn):
    ledger.ensure_schema(db_conn)
    source = Path(config.SOURCE_STORAGE_DIR)
    (source / "ab").mkdir(parents=True)
    (source / "ab" / "file.bin").write_bytes(b"x" * 16)
    (source / ".cache").mkdir()
    (source / ".cache" / "thumb.webp").write_text("可再生")
    (source / ".tmp").mkdir()
    (source / ".tmp" / "upload.part").write_text("半截")

    result = backup.run_storage_backup("cron")

    with tarfile.open(result["path"]) as archive:
        names = archive.getnames()
    assert any(name.endswith("ab/file.bin") for name in names)
    assert not any(".cache" in name or ".tmp" in name for name in names)
    assert ledger.get_run(result["run_id"])["task_key"] == "backup.storage"


def test_missing_storage_source_is_a_recorded_failure(db_conn):
    ledger.ensure_schema(db_conn)
    with pytest.raises(RuntimeError, match="源存储目录不存在"):
        backup.run_storage_backup("cron")
    assert ledger.list_runs(1)[0]["status"] == "failed"


def test_keep_falls_back_to_site_settings_policy(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("CREATE TABLE site_settings (`key` VARCHAR(64) PRIMARY KEY, value JSON NOT NULL)")
        cur.execute("""INSERT INTO site_settings VALUES ('ops.backup.policy', '{"keepDb": 4, "keepStorage": 99}')""")
    assert backup.resolve_keep("db", 14, None) == 4
    assert backup.resolve_keep("storage", 7, None) == 7  # 越界（99）回落环境默认
    assert backup.resolve_keep("db", 14, 2) == 2  # 任务参数优先


def test_restore_rejects_bad_sources_without_leaving_a_restore_row(db_conn):
    ledger.ensure_schema(db_conn)
    storage_id = ledger.insert_run("storage", "cron", "backup.storage")
    ledger.finish_run(storage_id, "success", path="/x.tgz")
    failed_id = ledger.insert_run("db", "cron", "backup.db")
    ledger.finish_run(failed_id, "failed", error="x")
    vanished_id = ledger.insert_run("db", "cron", "backup.db")
    ledger.finish_run(vanished_id, "success", path="/nonexistent/db.sql.gz")

    with pytest.raises(RuntimeError, match="只能从 db 备份恢复"):
        restore.run_restore(storage_id, "ops_scratch")
    with pytest.raises(RuntimeError, match="不存在或不是成功的备份"):
        restore.run_restore(failed_id, "ops_scratch")
    with pytest.raises(RuntimeError, match="备份文件缺失"):
        restore.run_restore(vanished_id, "ops_scratch")
    with pytest.raises(ValueError):
        restore.run_restore(storage_id, "x;DROP DATABASE y")
    assert all(row["kind"] != "restore" for row in ledger.list_runs(20))


def test_rapid_consecutive_backups_always_keep_the_newest(db_conn, fake_dump):
    """同一秒内连续完成多份备份（库小、执行快）：每份都成功，轮转后留下的恰是最新的那份。"""
    ledger.ensure_schema(db_conn)
    results = [backup.run_db_backup("manual", keep=1) for _ in range(4)]
    remaining = sorted(p.name for p in (Path(config.TARGET_DIR) / "db").iterdir())
    assert remaining == [Path(results[-1]["path"]).name]
    assert [r["status"] for r in ledger.list_runs(4)] == ["success"] * 4
