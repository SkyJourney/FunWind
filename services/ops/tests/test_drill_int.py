"""恢复演练执行器（drill.restore）：备份 → 同实例临时库导入 → 对账 → 清理。

需要 mysqldump/mysql 客户端（管线镜像内运行，与 restore_tools_int 同口径）。
"""
import gzip
import os

import pytest

from app import config, db, ledger

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(
        __import__("shutil").which("mysqldump") is None or __import__("shutil").which("mysql") is None,
        reason="需要 mysqldump/mysql 客户端（在管线镜像内运行）",
    ),
]


def _seed_notes(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(32) COLLATE utf8mb4_bin) "
            "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
        )
        cur.executemany("INSERT INTO notes VALUES (%s, %s)", [(1, "さくら"), (2, "サクラ")])


def test_drill_happy_path_restores_into_scratch_and_cleans_up(db_conn):
    ledger.ensure_schema(db_conn)
    _seed_notes(db_conn)
    backed = ledger.insert_run("db", "cron", "backup.db")
    path = f"{config.TARGET_DIR}/db/drill-src.sql.gz"
    os.makedirs(f"{config.TARGET_DIR}/db", exist_ok=True)
    with gzip.open(path, "wt") as fh:
        # 真实 SQL（模拟 mysqldump 产物：建表 + 数据 + mysqldump 尾标）
        fh.write(
            "CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(32));\n"
            "INSERT INTO notes VALUES (1, 'さくら');\n"
            "-- Dump completed\n"
        )
    ledger.finish_run(backed, "success", path=path)

    # 用真实恢复链路（restore.run_restore 由 run_drill 内部调用）
    from app.executors import REGISTRY

    outcome = REGISTRY["drill.restore"].run({}, trigger="manual", task_key="drill.restore", run_id=None, task_name="恢复演练")

    assert outcome["restored_from"] == backed
    assert outcome["tables"] >= 1
    assert "演练通过" in outcome["detail"]
    assert "行数 源=" in outcome["detail"]  # 核心表行数抽样进明细
    # 台账：drill 成功行 + restore 行（真实发生）
    kinds = [r["kind"] for r in ledger.list_runs(10)]
    assert "drill" in kinds and "restore" in kinds
    # 临时库已 DROP
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'ops_drill_%'"
            )
            assert cur.fetchone()[0] == 0
    finally:
        conn.close()


def test_drill_without_any_backup_fails_cleanly(db_conn):
    ledger.ensure_schema(db_conn)
    from app.executors import REGISTRY

    with pytest.raises(RuntimeError, match="没有可演练的成功 db 备份"):
        REGISTRY["drill.restore"].run({}, trigger="cron", task_key="drill.restore", run_id=None, task_name="恢复演练")
    assert ledger.list_runs(5)[0]["status"] == "failed"
