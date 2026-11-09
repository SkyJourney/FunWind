"""测试夹具：在导入 app 之前注入环境变量；集成测试用真实 MySQL 临时库。

连接参数优先读 OPS_TEST_DB_*，其次读仓库根 .env 的 NEW_DB_*（本地开发库实例——只建删随机名
临时库，绝不碰开发库本身）；拿不到口令、连不上或 SKIP_DB_TESTS=1 时跳过集成测试
（与 web / db 包的约定一致）。
"""
import os
import secrets
import sys
from pathlib import Path

import pymysql
import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
# 仓库内是 services/backup → 仓库根；镜像内测试挂在 /srv/tests，没有仓库根（只靠 OPS_TEST_DB_* 环境变量）
REPO_ROOT = SERVICE_ROOT.parents[1] if len(SERVICE_ROOT.parents) > 1 else SERVICE_ROOT
sys.path.insert(0, str(SERVICE_ROOT))


def _read_root_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = REPO_ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


_ROOT_ENV = _read_root_env()
TEST_DB = {
    "host": os.environ.get("OPS_TEST_DB_HOST") or _ROOT_ENV.get("NEW_DB_HOST", "127.0.0.1"),
    "port": int(os.environ.get("OPS_TEST_DB_PORT") or _ROOT_ENV.get("NEW_DB_PORT", "3306")),
    "user": os.environ.get("OPS_TEST_DB_USER") or _ROOT_ENV.get("NEW_DB_USER", "root"),
    "password": os.environ.get("OPS_TEST_DB_PASSWORD") or _ROOT_ENV.get("NEW_DB_PASSWORD", ""),
}
TEST_TOKEN = "unit-test-ops-token"

# config 在 import 期读取环境：必须先于任何 `import app.*` 设置
os.environ["BACKUP_DB_HOST"] = TEST_DB["host"]
os.environ["BACKUP_DB_PORT"] = str(TEST_DB["port"])
os.environ["BACKUP_DB_USER"] = TEST_DB["user"]
os.environ["BACKUP_DB_PASSWORD"] = TEST_DB["password"] or "unset-test-password"
os.environ["BACKUP_DB_NAME"] = "ops_test_unset"
os.environ["OPS_TOKEN"] = TEST_TOKEN


def _server_connection():
    return pymysql.connect(
        host=TEST_DB["host"],
        port=TEST_DB["port"],
        user=TEST_DB["user"],
        password=TEST_DB["password"],
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=3,
    )


_SKIP_REASON: list[str | None] = []


def _db_skip_reason() -> str | None:
    if _SKIP_REASON:
        return _SKIP_REASON[0]
    reason = None
    if os.environ.get("SKIP_DB_TESTS") == "1":
        reason = "SKIP_DB_TESTS=1"
    elif not TEST_DB["password"]:
        reason = "未配置测试库口令（OPS_TEST_DB_PASSWORD 或仓库根 .env 的 NEW_DB_PASSWORD）"
    else:
        try:
            _server_connection().close()
        except Exception as exc:  # noqa: BLE001 —— 任何连接失败都只是「跳过」的理由
            reason = f"测试库不可达：{exc}"
    _SKIP_REASON.append(reason)
    return reason


@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    """随机名临时库 + 指向它的 config；测试结束 DROP。备份产物/源目录也指向临时目录。"""
    reason = _db_skip_reason()
    if reason:
        pytest.skip(reason)
    from app import config

    name = f"ops_test_{secrets.token_hex(4)}"
    conn = _server_connection()
    with conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    monkeypatch.setattr(config, "DB_NAME", name)
    monkeypatch.setattr(config, "DB_HOST", TEST_DB["host"])
    monkeypatch.setattr(config, "DB_PORT", TEST_DB["port"])
    monkeypatch.setattr(config, "DB_USER", TEST_DB["user"])
    monkeypatch.setattr(config, "DB_PASSWORD", TEST_DB["password"])
    monkeypatch.setattr(config, "TARGET_DIR", str(tmp_path / "backups"))
    monkeypatch.setattr(config, "SOURCE_STORAGE_DIR", str(tmp_path / "storage"))
    # GET_LOCK 是服务器级的：锁名随临时库走，与本机其他进程（含真实管线）互不干扰
    monkeypatch.setattr(config, "LOCK_NAME", f"{name}-lock")
    try:
        yield name
    finally:
        with conn.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS `{name}`")
        conn.close()


@pytest.fixture
def db_conn(temp_db):
    """指向临时库的连接（经 app.db.connect，自带会话时区 +08:00）。"""
    from app import db

    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture
def fake_executors(monkeypatch):
    """执行器替身：沿用（或自行插入）run 记录并收尾 success，记录每次调用 (task_key, trigger, run_id, params)。"""
    from dataclasses import replace

    from app import executors, ledger

    calls: list[tuple] = []

    def make(run_kind: str):
        def run(params, *, trigger, task_key, run_id=None):
            run_id = run_id if run_id is not None else ledger.insert_run(run_kind, trigger, task_key)
            calls.append((task_key, trigger, run_id, dict(params)))
            ledger.finish_run(run_id, "success", detail="fake")
            return {"run_id": run_id}

        return run

    for key, spec in list(executors.REGISTRY.items()):
        monkeypatch.setitem(executors.REGISTRY, key, replace(spec, run=make(spec.run_kind)))
    return calls
