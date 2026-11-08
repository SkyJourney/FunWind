"""备份执行器：DB（mysqldump→gzip）与 storage（tar→gzip），含 GET_LOCK 互斥与保留份数轮转。

执行体全部是子进程（mysqldump / tar），本模块只负责编排、锁、元数据与轮转；
备份与恢复共用同一把 MySQL 命名锁（服务崩溃自动释放），互斥保证同一时刻只有一个
备份/恢复任务在执行。
"""
import gzip
import logging
import os
import subprocess
from pathlib import Path

from . import config, metadata

log = logging.getLogger("backup")

class LockBusyError(RuntimeError):
    """已有备份/恢复任务在执行。"""

# 客户端 = 官方 mysql:8.4 镜像内的 mysqldump/mysql（镜像内 COPY，与生产服务端完全同源同版本）；
# TLS 默认 PREFERRED 模式：自签证书不做 CA 校验即可用，无需禁用 TLS。
MYSQL_CLIENT_COMMON = f"-h{config.DB_HOST} -P{config.DB_PORT} -u{config.DB_USER} -p{config.DB_PASSWORD}"

def _acquire_lock(conn) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT GET_LOCK(%s, 0)", (config.LOCK_NAME,))
        return bool(cur.fetchone()[0])

def _release_lock(conn) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT RELEASE_LOCK(%s)", (config.LOCK_NAME,))

def _keep_latest(directory: Path, prefix: str, keep: int) -> list[str]:
    """按份数轮转：保留最新 keep 份（文件名时间戳+随机后缀，字典序≈时间序），返回被删除的文件名。

    实现 note：用 os.listdir + fnmatch 而非 Path.glob——Python 3.12 的 pathlib.glob 在本容器
    （named volume 目录）对带具体前缀的模式出现过稳定复现的 0 命中（同进程 `*.gz` 却能全量
    命中），fnmatch 对同样文件名单测为 True；换 listdir+fnmatch 后行为可预期。"""
    import fnmatch
    names = sorted(
        n for n in os.listdir(directory)
        if fnmatch.fnmatch(n, f"{prefix}*.gz") and (directory / n).is_file()
    )

    removed = []
    for name in names[:-keep] if len(names) > keep else []:
        (directory / name).unlink(missing_ok=True)
        removed.append(name)
    return removed

def run_db_backup(trigger: str) -> dict:
    """mysqldump 全量（--single-transaction 一致性快照，不锁写）→ gzip。"""
    target = Path(config.TARGET_DIR) / "db"
    target.mkdir(parents=True, exist_ok=True)
    import secrets
    stamp = metadata.now().replace(" ", "-").replace(":", "")
    out = target / f"db-{config.DB_NAME}-{stamp}-{secrets.token_hex(3)}.sql.gz"

    conn = metadata.connect()
    try:
        if not _acquire_lock(conn):
            raise LockBusyError("已有备份/恢复任务在执行")
        run_id = metadata.insert_run("db", trigger)
        try:
            dump_cmd = (
                f"exec mysqldump {MYSQL_CLIENT_COMMON} "
                f"--single-transaction --set-gtid-purged=OFF --routines --triggers --events "
                f"--default-character-set=utf8mb4 {config.DB_NAME}"
            )
            # shell 管道：mysqldump | gzip（口令只出现在容器内进程参数，容器隔离保护）
            result = subprocess.run(
                ["sh", "-c", f"{dump_cmd} | gzip > '{out}'"],
                capture_output=True, text=True, timeout=600,
            )
            if result.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                raise RuntimeError(f"mysqldump 失败：{result.stderr.strip()[:500]}")
            # 完整性：gzip 可解 + 尾标在（防管道中断产出半截文件）
            check = subprocess.run(
                ["sh", "-c", f"gzip -t '{out}' && gzip -dc '{out}' | tail -c 200 | grep -q 'Dump completed'"],
                capture_output=True, text=True, timeout=120,
            )
            if check.returncode != 0:
                raise RuntimeError("备份完整性校验失败（gzip/尾标）")

            removed = _keep_latest(target, f"db-{config.DB_NAME}-", config.KEEP_DB)
            size = out.stat().st_size
            detail = f"轮转删除 {len(removed)} 份" if removed else None
            metadata.finish_run(run_id, "success", path=str(out), size=size, detail=detail)
            log.info("db 备份完成：%s（%d B，轮转删除 %s 份）", out, size, len(removed))
            return {"run_id": run_id, "path": str(out), "size": size, "removed": removed}
        except Exception as e:
            metadata.finish_run(run_id, "failed", error=str(e)[:1000])
            raise
    finally:
        _release_lock(conn)
        conn.close()

def run_storage_backup(trigger: str) -> dict:
    """源存储目录 tar+gzip 全量（排除 .cache/.tmp 可再生内容）→ 保留 KEEP_STORAGE 份。"""
    source = Path(config.SOURCE_STORAGE_DIR)
    if not source.is_dir():
        raise RuntimeError(f"源存储目录不存在（只读挂载）：{source}")
    target = Path(config.TARGET_DIR) / "storage"
    target.mkdir(parents=True, exist_ok=True)
    import secrets
    stamp = metadata.now().replace(" ", "-").replace(":", "")
    out = target / f"storage-{stamp}-{secrets.token_hex(3)}.tgz"

    conn = metadata.connect()
    try:
        if not _acquire_lock(conn):
            raise LockBusyError("已有备份/恢复任务在执行")
        run_id = metadata.insert_run("storage", trigger)
        try:
            result = subprocess.run(
                ["tar", "czf", str(out), "--exclude=.cache", "--exclude=.tmp", "-C", str(source), "."],
                capture_output=True, text=True, timeout=1800,
            )
            if result.returncode != 0 or not out.exists():
                raise RuntimeError(f"tar 失败：{result.stderr.strip()[:500]}")
            check = subprocess.run(["gzip", "-t", str(out)], capture_output=True, text=True, timeout=300)
            if check.returncode != 0:
                raise RuntimeError("备份完整性校验失败（gzip）")

            removed = _keep_latest(target, "storage-", config.KEEP_STORAGE)
            size = out.stat().st_size
            detail = f"轮转删除 {len(removed)} 份" if removed else None
            metadata.finish_run(run_id, "success", path=str(out), size=size, detail=detail)
            log.info("storage 备份完成：%s（%d B，轮转删除 %s 份）", out, size, len(removed))
            return {"run_id": run_id, "path": str(out), "size": size, "removed": removed}
        except Exception as e:
            metadata.finish_run(run_id, "failed", error=str(e)[:1000])
            raise
    finally:
        _release_lock(conn)
        conn.close()
