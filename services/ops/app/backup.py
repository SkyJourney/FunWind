"""备份执行器：DB（mysqldump→gzip）与 storage（tar→gzip），含 GET_LOCK 互斥与保留份数轮转。

执行体全部是子进程（mysqldump / tar），本模块负责编排、锁、台账与轮转；备份与恢复共用同一把
MySQL 命名锁（连接断开自动释放），保证同一时刻只有一个备份/恢复任务在执行。
数据库口令经临时 option 文件（--defaults-extra-file，0600，用完即删）交给客户端，不出现在进程
参数里（M14 清账 C2：v1 的 `-p口令` 可被同容器内的 ps 读到）。
"""
import fnmatch
import json
import logging
import os
import secrets
import shlex
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config, db, ledger

log = logging.getLogger("ops.backup")


class LockBusyError(RuntimeError):
    """已有备份/恢复任务在执行。"""


def acquire_lock(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT GET_LOCK(%s, 0)", (config.LOCK_NAME,))
        return bool(cur.fetchone()[0])


def release_lock(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT RELEASE_LOCK(%s)", (config.LOCK_NAME,))


def reject_busy(run_id: int | None) -> None:
    """抢锁失败：预先插入的 running 记录（异步手动触发）收尾为 failed，再抛忙碌。"""
    if run_id is not None:
        ledger.finish_run(run_id, "failed", error="已有备份/恢复任务在执行")
    raise LockBusyError("已有备份/恢复任务在执行")


def _option_value(raw: str) -> str:
    """option 文件里的值一律加双引号，转义反斜杠与双引号（MySQL option 文件的转义规则）。"""
    return '"' + raw.replace("\\", "\\\\").replace('"', '\\"') + '"'


@contextmanager
def client_option_file() -> Iterator[str]:
    """临时 [client] option 文件（0600），交给 mysqldump/mysql 的 --defaults-extra-file，退出即删除。"""
    fd, path = tempfile.mkstemp(prefix="ops-client-", suffix=".cnf")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("[client]\n")
            fh.write(f"host={_option_value(config.DB_HOST)}\n")
            fh.write(f"port={config.DB_PORT}\n")
            fh.write(f"user={_option_value(config.DB_USER)}\n")
            fh.write(f"password={_option_value(config.DB_PASSWORD)}\n")
        os.chmod(path, 0o600)
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def dump_command(option_file: str, database: str, out: Path) -> str:
    """mysqldump | gzip 的 shell 管道（--defaults-extra-file 必须是第一个选项）。"""
    return (
        f"exec mysqldump --defaults-extra-file={shlex.quote(option_file)} "
        "--single-transaction --set-gtid-purged=OFF --routines --triggers --events "
        f"--default-character-set=utf8mb4 {shlex.quote(database)} | gzip > {shlex.quote(str(out))}"
    )


def resolve_keep(kind: str, env_default: int, override: int | None) -> int:
    """保留份数：任务参数 > site_settings("ops.backup.policy")（后台旧设置区）> 环境默认。

    读取失败静默回落环境默认（轮转不该因配置读取挂掉）。
    """
    if override is not None:
        return override
    try:
        conn = db.connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM site_settings WHERE `key` = %s LIMIT 1", ("ops.backup.policy",))
                row = cur.fetchone()
        finally:
            conn.close()
        raw = row[0] if row else None
        parsed = json.loads(raw) if isinstance(raw, (str, bytes)) else (raw or {})
        n = int(parsed.get("keepDb" if kind == "db" else "keepStorage", env_default))
        return n if 1 <= n <= 90 else env_default
    except Exception as exc:
        log.warning("保留策略读取失败，使用默认 %d：%s", env_default, exc)
        return env_default


def keep_latest(directory: Path, prefix: str, keep: int, protect: str | None = None) -> list[str]:
    """按份数轮转：保留最新 keep 份（文件名时间戳精确到微秒，字典序即时间序），返回被删除的文件名。

    只匹配「前缀后紧跟时间戳数字」的常规备份：恢复前的安全 dump（`db-{库}-pre-restore-…`）同样以
    `db-{库}-` 开头，若一并参与，`p` 字典序排在数字之后会被当成「最新」永远保留并挤占保留份数，
    真实备份反被多删（v1 缺陷，M14 Step 1 修正）。
    protect = 本次刚生成的文件名，任何情况下都不删（时间戳回拨等极端情况的最后防线）。
    实现 note：用 os.listdir + fnmatch 而非 Path.glob——Python 3.12 的 pathlib.glob 在容器
    （named volume 目录）对带具体前缀的模式出现过稳定复现的 0 命中，fnmatch 行为可预期。
    """
    names = sorted(
        n
        for n in os.listdir(directory)
        if fnmatch.fnmatch(n, f"{prefix}[0-9]*.gz") and (directory / n).is_file()
    )
    candidates = [n for n in names if n != protect]
    surplus = len(names) - keep
    removed = []
    for name in candidates[:surplus] if surplus > 0 else []:
        (directory / name).unlink(missing_ok=True)
        removed.append(name)
    return removed


def file_stamp() -> str:
    """备份文件名里的时间戳：北京墙面时间精确到微秒（定宽，字典序即时间序）。

    v1 只精确到秒：同一秒内连续完成的几份备份只能靠随机后缀排序，轮转可能把刚生成的那份当成
    最旧的删掉（M14 Step 2 暴露并修正）。
    """
    return datetime.now(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m-%d-%H%M%S-%f")


def run_db_backup(
    trigger: str,
    *,
    task_key: str = "backup.db",
    keep: int | None = None,
    run_id: int | None = None,
    task_name: str = "",  # 统一签名：备份执行器不使用
) -> dict:
    """mysqldump 全量（--single-transaction 一致性快照，不锁写）→ gzip → 完整性校验 → 轮转。

    run_id 由异步手动触发预先插入时传入；定时与同步调用由本函数自行插入台账记录。
    """
    target = Path(config.TARGET_DIR) / "db"
    target.mkdir(parents=True, exist_ok=True)
    out = target / f"db-{config.DB_NAME}-{file_stamp()}-{secrets.token_hex(3)}.sql.gz"

    conn = db.connect()
    try:
        if not acquire_lock(conn):
            reject_busy(run_id)
        run_id = run_id if run_id is not None else ledger.insert_run("db", trigger, task_key)
        try:
            with client_option_file() as option_file:
                result = subprocess.run(
                    ["sh", "-c", dump_command(option_file, config.DB_NAME, out)],
                    capture_output=True,
                    text=True,
                    timeout=600,
                )
            if result.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                raise RuntimeError(f"mysqldump 失败：{result.stderr.strip()[:500]}")
            # 完整性：gzip 可解 + 尾标在（防管道中断产出半截文件）
            check = subprocess.run(
                ["sh", "-c", f"gzip -t {shlex.quote(str(out))} && gzip -dc {shlex.quote(str(out))} "
                 "| tail -c 200 | grep -q 'Dump completed'"],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if check.returncode != 0:
                raise RuntimeError("备份完整性校验失败（gzip/尾标）")

            removed = keep_latest(
                target, f"db-{config.DB_NAME}-", resolve_keep("db", config.KEEP_DB, keep), protect=out.name
            )
            size = out.stat().st_size
            detail = f"轮转删除 {len(removed)} 份" if removed else None
            ledger.finish_run(run_id, "success", path=str(out), size=size, detail=detail)
            log.info("db 备份完成：%s（%d B，轮转删除 %d 份）", out, size, len(removed))
            return {"run_id": run_id, "path": str(out), "size": size, "removed": removed}
        except Exception as exc:
            ledger.finish_run(run_id, "failed", error=str(exc)[:1000])
            raise
    finally:
        release_lock(conn)
        conn.close()


def run_storage_backup(
    trigger: str,
    *,
    task_key: str = "backup.storage",
    keep: int | None = None,
    run_id: int | None = None,
    task_name: str = "",  # 统一签名：备份执行器不使用
) -> dict:
    """源存储目录 tar+gzip 全量（排除 .cache/.tmp 可再生内容）→ 完整性校验 → 轮转。"""
    source = Path(config.SOURCE_STORAGE_DIR)
    target = Path(config.TARGET_DIR) / "storage"
    target.mkdir(parents=True, exist_ok=True)
    out = target / f"storage-{file_stamp()}-{secrets.token_hex(3)}.tgz"

    conn = db.connect()
    try:
        if not acquire_lock(conn):
            reject_busy(run_id)
        run_id = run_id if run_id is not None else ledger.insert_run("storage", trigger, task_key)
        try:
            if not source.is_dir():
                raise RuntimeError(f"源存储目录不存在（只读挂载）：{source}")
            result = subprocess.run(
                ["tar", "czf", str(out), "--exclude=.cache", "--exclude=.tmp", "-C", str(source), "."],
                capture_output=True,
                text=True,
                timeout=1800,
            )
            if result.returncode != 0 or not out.exists():
                raise RuntimeError(f"tar 失败：{result.stderr.strip()[:500]}")
            check = subprocess.run(["gzip", "-t", str(out)], capture_output=True, text=True, timeout=300)
            if check.returncode != 0:
                raise RuntimeError("备份完整性校验失败（gzip）")

            removed = keep_latest(
                target, "storage-", resolve_keep("storage", config.KEEP_STORAGE, keep), protect=out.name
            )
            size = out.stat().st_size
            detail = f"轮转删除 {len(removed)} 份" if removed else None
            ledger.finish_run(run_id, "success", path=str(out), size=size, detail=detail)
            log.info("storage 备份完成：%s（%d B，轮转删除 %d 份）", out, size, len(removed))
            return {"run_id": run_id, "path": str(out), "size": size, "removed": removed}
        except Exception as exc:
            ledger.finish_run(run_id, "failed", error=str(exc)[:1000])
            raise
    finally:
        release_lock(conn)
        conn.close()
