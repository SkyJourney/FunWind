"""恢复执行器真链路：真实 mysqldump → 覆盖式恢复 → 数据核对（需要 mysqldump/mysql 客户端）。

本机没有客户端时跳过；在管线镜像里跑（官方 mysql:8.4 客户端 + Python 3.12，与生产同源）。
覆盖：恢复到新库（无现场可保护）、覆盖已有库（先做安全 dump）、覆盖业务库后台账重新演进、
导入失败（已 DROP 之后）时失败记录的兜底。
"""
import gzip
import shutil

import pytest

from app import backup, config, db, ledger, restore

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(
        shutil.which("mysqldump") is None or shutil.which("mysql") is None,
        reason="需要 mysqldump/mysql 客户端（在管线镜像内运行）",
    ),
]


@pytest.fixture
def scratch_db(temp_db):
    name = f"{temp_db}_scratch"
    yield name
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS `{name}`")
    finally:
        conn.close()


def _seed_notes(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(32) COLLATE utf8mb4_bin) "
            "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )
        cur.executemany("INSERT INTO notes VALUES (%s, %s)", [(1, "さくら"), (2, "サクラ"), (3, "青翼")])


def _notes_in(database: str) -> list[str]:
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT body FROM `{database}`.notes ORDER BY id")
            return [row[0] for row in cur.fetchall()]
    finally:
        conn.close()


def _broken_backup(tmp_path) -> int:
    broken = tmp_path / "broken.sql.gz"
    with gzip.open(broken, "wt") as fh:
        fh.write("THIS IS NOT SQL;\n")
    run_id = ledger.insert_run("db", "manual", "backup.db")
    ledger.finish_run(run_id, "success", path=str(broken))
    return run_id


def test_real_backup_then_restore_into_new_database(db_conn, scratch_db):
    ledger.ensure_schema(db_conn)
    _seed_notes(db_conn)
    backed = backup.run_db_backup("manual")

    result = restore.run_restore(backed["run_id"], scratch_db)

    assert "目标库原本不存在" in result["detail"]
    assert _notes_in(scratch_db) == ["さくら", "サクラ", "青翼"]  # 假名字节级无损（M13 恢复演练口径）
    row = ledger.get_run(result["run_id"])
    assert row["kind"] == "restore" and row["status"] == "success"


def test_restore_over_existing_database_takes_safety_dump_first(db_conn, scratch_db):
    ledger.ensure_schema(db_conn)
    _seed_notes(db_conn)
    backed = backup.run_db_backup("manual")
    restore.run_restore(backed["run_id"], scratch_db)

    again = restore.run_restore(backed["run_id"], scratch_db)

    assert "恢复前现场 dump" in again["detail"]
    pre_dumps = [p for p in (backup.Path(config.TARGET_DIR) / "db").iterdir() if "pre-restore" in p.name]
    assert len(pre_dumps) == 1
    assert _notes_in(scratch_db) == ["さくら", "サクラ", "青翼"]


def test_restore_into_business_database_reevolves_ledger(db_conn):
    ledger.ensure_schema(db_conn)
    _seed_notes(db_conn)
    backed = backup.run_db_backup("manual")

    result = restore.run_restore(backed["run_id"], config.DB_NAME)

    row = ledger.get_run(result["run_id"])
    assert row["kind"] == "restore" and row["status"] == "success"
    assert _notes_in(config.DB_NAME) == ["さくら", "サクラ", "青翼"]


def test_failed_import_into_new_database_is_recorded(db_conn, scratch_db, tmp_path):
    ledger.ensure_schema(db_conn)
    run_id = _broken_backup(tmp_path)
    with pytest.raises(RuntimeError, match="恢复导入失败"):
        restore.run_restore(run_id, scratch_db)
    newest = ledger.list_runs(1)[0]
    assert newest["kind"] == "restore" and newest["status"] == "failed"


def test_failed_import_into_business_database_still_leaves_a_failure_record(db_conn, tmp_path):
    """台账表随业务库被 DROP 之后导入失败：失败记录必须补记进重新演进出来的台账。"""
    ledger.ensure_schema(db_conn)
    run_id = _broken_backup(tmp_path)
    with pytest.raises(RuntimeError, match="恢复导入失败"):
        restore.run_restore(run_id, config.DB_NAME)
    rows = ledger.list_runs(5)
    assert rows[0]["kind"] == "restore" and rows[0]["status"] == "failed"
    assert "恢复导入失败" in rows[0]["error"]
