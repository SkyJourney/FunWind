"""配置表的列契约（Step 2 由 drizzle 迁移建表，列名/类型必须与此一致）。

Step 1 时配置表尚不存在，测试按这里的 DDL 自建；Step 2 起改由 `pnpm db:bootstrap` 建出的真实
schema 跑同一组测试（契约测试），两端漂移会直接变红。
"""

OPS_TASKS_DDL = """
CREATE TABLE ops_tasks (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_key VARCHAR(64) NOT NULL,
  name VARCHAR(60) NOT NULL,
  executor VARCHAR(32) NOT NULL,
  params JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_ops_task_key (task_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

OPS_TRIGGERS_DDL = """
CREATE TABLE ops_triggers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_key VARCHAR(64) NOT NULL,
  kind ENUM('cron','once','manual') NOT NULL,
  expr VARCHAR(64) NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_ops_trigger_task (task_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

# v1 备份服务建的旧台账（用于验证 D7 演进）
LEGACY_BACKUP_RUNS_DDL = """
CREATE TABLE backup_runs (
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


def create_config_tables(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(OPS_TASKS_DDL)
        cur.execute(OPS_TRIGGERS_DDL)


def add_task(conn, task_key: str, executor: str, params: str = "{}", enabled: bool = True, name: str = "测试任务") -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ops_tasks (task_key, name, executor, params, enabled, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, NOW(), NOW())",
            (task_key, name, executor, params, enabled),
        )


def add_trigger(conn, task_key: str, kind: str, expr: str | None = None, enabled: bool = True) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ops_triggers (task_key, kind, expr, enabled, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, NOW(), NOW())",
            (task_key, kind, expr, enabled),
        )
        return int(cur.lastrowid)
