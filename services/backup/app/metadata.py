"""backup_runs 元数据访问（备份服务自治建表；web 侧只读查询，不进 drizzle schema）。"""
import datetime
import pymysql
from . import config

DDL = """
CREATE TABLE IF NOT EXISTS backup_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('db','storage','restore') NOT NULL,
  trigger_source ENUM('cron','manual') NOT NULL,
  status ENUM('running','success','failed') NOT NULL,
  path VARCHAR(255) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  detail TEXT NULL,
  error TEXT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  INDEX idx_started (started_at),
  INDEX idx_kind_status (kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

def connect(db: str | None = config.DB_NAME) -> pymysql.connections.Connection:
    """默认连接业务库（backup_runs 所在）；传空串/None 用于无库上下文（如建表前的 DDL）。"""
    return pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=db,
        charset="utf8mb4",
        autocommit=True,
    )

def ensure_table() -> None:
    conn = connect(db="")
    try:
        with conn.cursor() as cur:
            cur.execute(DDL.replace("backup_runs", f"`{config.DB_NAME}`.backup_runs", 1))
    finally:
        conn.close()

def now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def insert_run(kind: str, trigger: str) -> int:
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO backup_runs (kind, trigger_source, status, started_at) VALUES (%s,%s,'running',%s)",
                (kind, trigger, now()),
            )
            return int(cur.lastrowid)
    finally:
        conn.close()

def finish_run(run_id: int, status: str, *, path: str | None = None, size: int | None = None,
               detail: str | None = None, error: str | None = None) -> None:
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE backup_runs SET status=%s, path=%s, size_bytes=%s, detail=%s, error=%s, finished_at=%s WHERE id=%s",
                (status, path, size, detail, error, now(), run_id),
            )
    finally:
        conn.close()
