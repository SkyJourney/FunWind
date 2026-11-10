"""恢复执行器：覆盖式恢复 + 安全前置（恢复前先对目标库做一次现场 dump）。

已知引擎代差（实测）：旧库的 MRG_MYISAM 表（pw_merge_posts）在 MySQL 8.4 无法重建，导入时报 1168——
恢复器对该错误容忍跳过并在结果标注（该表不在迁移源清单，5.7 数据目录文件为其终极兜底）。
其余导入错误一律失败中止。

目标库名必须先过白名单才进入任何 SQL 或命令（M14 清账 C1：v1 直接把 API 入参拼进 shell 与
DROP DATABASE）；DROP/CREATE 改走参数化连接，不再经 shell 拼 `mysql -e` 字符串。
"""
import logging
import re
import shlex
import subprocess
from pathlib import Path

from . import backup, config, db, ledger

log = logging.getLogger("ops.restore")

# 恢复时容忍跳过的错误码：1168 = MRG_MYISAM 引擎代差
TOLERABLE_ERRORS = {"1168"}

_DB_NAME_RE = re.compile(r"[A-Za-z0-9_]{1,64}")
RESERVED_DATABASES = frozenset({"mysql", "sys", "information_schema", "performance_schema"})


def validate_target_db(name: str) -> str:
    """目标库名白名单：只允许字母、数字、下划线（1–64 位），且不得是系统库。"""
    if not isinstance(name, str) or not _DB_NAME_RE.fullmatch(name):
        raise ValueError("目标库名只允许字母、数字、下划线（1–64 位）")
    if name.lower() in RESERVED_DATABASES:
        raise ValueError(f"不允许恢复到系统库：{name}")
    return name


def _database_exists(name: str) -> bool:
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s", (name,))
            return cur.fetchone()[0] > 0
    finally:
        conn.close()


def _recreate_database(name: str) -> None:
    """DROP + CREATE 目标库（库名已过白名单，反引号包裹不可能被逃逸）。"""
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS `{name}`")
            cur.execute(f"CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    finally:
        conn.close()


def _source_backup(run_id: int) -> Path:
    """取成功的 db 备份产物路径；storage 备份不是 SQL，不能走这条恢复路径。"""
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT kind, path FROM `{ledger.LEDGER_TABLE}` WHERE id=%s AND status='success'",
                (run_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    if not row or not row[1]:
        raise RuntimeError(f"run #{run_id} 不存在或不是成功的备份")
    if row[0] != "db":
        raise RuntimeError(f"run #{run_id} 是 {row[0]} 备份，只能从 db 备份恢复数据库")
    src = Path(row[1])
    if not src.is_file():
        raise RuntimeError(f"备份文件缺失：{src}")
    return src


def _reevolve_and_insert(trigger: str) -> int:
    """覆盖了业务库之后：台账被换回备份时刻的版本（旧备份还可能是演进前的 backup_runs 结构），
    先重新演进，再插入一条新的恢复记录。"""
    conn = db.connect()
    try:
        ledger.ensure_schema(conn)
    finally:
        conn.close()
    return ledger.insert_run("restore", trigger, "restore")


def _record_failure(action_id: int, trigger: str, message: str) -> None:
    """恢复失败的台账收尾。覆盖业务库中途失败时台账表可能已随库被 DROP，原记录无处可写——
    此时重新演进并补记一条失败记录；台账本身也写不进去只记日志，绝不掩盖原始异常。"""
    try:
        if ledger.finish_run(action_id, "failed", error=message):
            return
    except Exception:
        pass
    try:
        new_id = _reevolve_and_insert(trigger)
        ledger.finish_run(new_id, "failed", error=message)
    except Exception:
        log.exception("恢复失败记录写入台账失败（原始错误：%s）", message)


def run_restore(run_id: int, target_db: str, trigger: str = "manual") -> dict:
    target_db = validate_target_db(target_db)
    conn = db.connect()
    try:
        if not backup.acquire_lock(conn):
            raise backup.LockBusyError("已有备份/恢复任务在执行")
        src = _source_backup(run_id)
        action_id = ledger.insert_run("restore", trigger, "restore")
        try:
            notes = []
            with backup.client_option_file() as option_file:
                # 1. 安全前置：目标库存在才有现场可保护；恢复前 dump 一份作为后路（独立前缀，不占保留份数）
                if _database_exists(target_db):
                    pre_dir = Path(config.TARGET_DIR) / "db"
                    pre_dir.mkdir(parents=True, exist_ok=True)
                    pre = pre_dir / f"db-{target_db}-pre-restore-{backup.file_stamp()}.sql.gz"
                    pre_result = subprocess.run(
                        ["sh", "-c", backup.dump_command(option_file, target_db, pre)],
                        capture_output=True,
                        text=True,
                        timeout=600,
                    )
                    if pre_result.returncode != 0:
                        raise RuntimeError(f"恢复前的安全 dump 失败（已中止恢复）：{pre_result.stderr.strip()[:300]}")
                    notes.append(f"恢复前现场 dump：{pre}")
                else:
                    notes.append("目标库原本不存在，无现场可保护，跳过安全 dump")

                # 2. 覆盖式恢复：重建目标库 → 导入（1168 容忍跳过，其余失败中止）
                _recreate_database(target_db)
                reader = "zcat" if src.name.endswith(".gz") else "cat"
                import_result = subprocess.run(
                    ["sh", "-c",
                     f"{reader} {shlex.quote(str(src))} | mysql --defaults-extra-file={shlex.quote(option_file)} "
                     f"--default-character-set=utf8mb4 {shlex.quote(target_db)}"],
                    capture_output=True,
                    text=True,
                    timeout=1800,
                )
            stderr = import_result.stderr or ""
            error_lines = [line for line in stderr.splitlines() if line.startswith("ERROR")]
            tolerated = [line for line in error_lines if any(code in line for code in TOLERABLE_ERRORS)]
            fatal = [line for line in error_lines if line not in tolerated]
            # 退出码非零必须失败——哪怕 stderr 无可解析的 ERROR 行（v1 曾有假成功教训）
            if import_result.returncode != 0 or fatal:
                raise RuntimeError(
                    f"恢复导入失败（退出码 {import_result.returncode}）：{(fatal[0] if fatal else stderr)[:300]}"
                )

            detail = f"自 run #{run_id} 恢复 db 备份到 {target_db}"
            if tolerated:
                detail += f"；容忍跳过 {len(tolerated)} 条引擎代差错误（MRG_MYISAM）"
            detail += "；" + "；".join(notes)

            if target_db == config.DB_NAME:
                # 开头插入的那条记录已随业务库被换掉：重新演进后补记一条完整记录
                action_id = _reevolve_and_insert(trigger)
            ledger.finish_run(action_id, "success", path=str(src), detail=detail)
            return {"run_id": action_id, "restored_from": run_id, "target_db": target_db, "detail": detail}
        except Exception as exc:
            _record_failure(action_id, trigger, str(exc)[:1000])
            raise
    finally:
        backup.release_lock(conn)
        conn.close()
