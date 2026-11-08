"""恢复执行器：覆盖式恢复 + 安全前置（恢复前先对当前库做一次现场 dump）。

已知引擎代差（实测）：旧库的 MRG_MYISAM 表（pw_merge_posts）在 MySQL 8.4 无法重建，
导入时报 1168——恢复器对该错误容忍跳过并在结果标注（该表不在迁移源清单，5.7 数据
目录文件为其终极兜底）。其余导入错误一律失败中止。
"""
import subprocess
from pathlib import Path

from . import backup, config, metadata

# 恢复时容忍跳过的错误码：1168 = MRG_MYISAM 引擎代差
TOLERABLE_ERRORS = {"1168"}

MYSQL_CLIENT_COMMON = f"-h{config.DB_HOST} -P{config.DB_PORT} -u{config.DB_USER} -p{config.DB_PASSWORD}"

def run_restore(run_id: int, target_db: str, trigger: str = "manual") -> dict:
    conn = metadata.connect()
    try:
        if not backup._acquire_lock(conn):
            raise backup.LockBusyError("已有备份/恢复任务在执行")

        # 1. 取源备份元数据并校验文件在位
        with conn.cursor() as cur:
            cur.execute("SELECT kind, path FROM backup_runs WHERE id=%s AND status='success'", (run_id,))
            row = cur.fetchone()
        if not row or not row[1]:
            raise RuntimeError(f"run #{run_id} 不存在或不是成功的备份")
        kind, path = row[0], row[1]
        src = Path(path)
        if not src.is_file():
            raise RuntimeError(f"备份文件缺失：{src}")

        action_id = metadata.insert_run("restore", trigger)
        try:
            # 2. 安全前置：恢复前对目标库做一次现场 dump（后路），不占保留份数语义（独立前缀，随目录保留）
            pre_target = Path(config.TARGET_DIR) / "db"
            pre_target.mkdir(parents=True, exist_ok=True)
            stamp = metadata.now().replace(" ", "-").replace(":", "")
            pre = pre_target / f"db-{target_db}-pre-restore-{stamp}.sql.gz"
            dump_cmd = (
                f"exec mysqldump {MYSQL_CLIENT_COMMON} --single-transaction --set-gtid-purged=OFF "
                f"--single-transaction --routines --triggers --events "
                f"--default-character-set=utf8mb4 {target_db} | gzip > '{pre}'"
            )
            pre_result = subprocess.run(["sh", "-c", dump_cmd], capture_output=True, text=True, timeout=600)
            if pre_result.returncode != 0:
                raise RuntimeError(f"恢复前的安全 dump 失败（已中止恢复）：{pre_result.stderr.strip()[:300]}")

            # 3. 覆盖式恢复：重建目标库（DROP/CREATE）→ 导入（1168 容忍跳过，其余失败中止）
            drop = (
                f"DROP DATABASE IF EXISTS \\`{target_db}\\`; "
                f"CREATE DATABASE \\`{target_db}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
            drop_result = subprocess.run(
                ["sh", "-c", f"mysql {MYSQL_CLIENT_COMMON} -e \"{drop}\""],
                capture_output=True, text=True, timeout=120,
            )
            if drop_result.returncode != 0:
                raise RuntimeError(f"重建目标库失败：{drop_result.stderr.strip()[:300]}")
            import_result = subprocess.run(
                ["sh", "-c",
                 f"{'zcat' if path.endswith('.gz') else 'cat'} '{src}' | "
                 f"mysql {MYSQL_CLIENT_COMMON} "
                 f"--default-character-set=utf8mb4 {target_db}"],
                capture_output=True, text=True, timeout=1800,
            )
            stderr = import_result.stderr or ""
            stderr_lines = [l for l in stderr.splitlines() if l.startswith("ERROR")]
            tolerated = [l for l in stderr_lines if any(code in l for code in TOLERABLE_ERRORS)]
            fatal = [l for l in stderr_lines if l not in tolerated]
            # 退出码非零必须失败——哪怕 stderr 无可解析 ERROR 行（如客户端缺库启动失败；此前假成功教训）
            if import_result.returncode != 0 or fatal:
                raise RuntimeError(
                    f"恢复导入失败（退出码 {import_result.returncode}）：{(fatal[0] if fatal else stderr)[:300]}"
                )

            detail = f"自 run #{run_id} 恢复 {kind} 备份到 {target_db}"
            if tolerated:
                detail += f"；容忍跳过 {len(tolerated)} 条引擎代差错误（MRG_MYISAM）"
            metadata.finish_run(action_id, "success", path=str(src),
                                detail=detail + "；恢复前现场 dump：" + str(pre))
            return {"run_id": action_id, "restored_from": run_id, "target_db": target_db, "detail": detail}
        except Exception as e:
            metadata.finish_run(action_id, "failed", error=str(e)[:1000])
            raise
    finally:
        backup._release_lock(conn)
        conn.close()
