#!/usr/bin/env python3
"""备份服务 CLI（容器内执行）：docker exec funwind-backup python cli.py <命令>

命令：
  status                      服务与调度状态
  runs [N]                    最近 N 条备份/恢复记录（默认 20）
  backup db|storage           立即执行一次备份（manual 触发）
  restore <run_id> [--target-db X] [--dry-run] [--yes]
                              覆盖式恢复：默认目标库 qingyisub；必须 --yes 才会真正执行
"""
import argparse
import json
import sys

from app import config, metadata
from app.backup import run_db_backup, run_storage_backup
from app.restore import run_restore

def cmd_status() -> int:
    conn = metadata.connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, kind, trigger_source, status, started_at FROM backup_runs ORDER BY id DESC LIMIT 5")
            rows = cur.fetchall()
    finally:
        conn.close()
    print(f"DB: {config.DB_HOST}:{config.DB_PORT}/{config.DB_NAME}｜保留 DB {config.KEEP_DB} 份 / storage {config.KEEP_STORAGE} 份")
    print(f"cron: db={config.DB_CRON} storage={config.STORAGE_CRON}")
    print("最近 5 条：")
    for r in rows:
        print(f"  #{r[0]} {r[1]}/{r[2]} {r[3]} @ {r[4]}")
    return 0

def cmd_runs(limit: int) -> int:
    conn = metadata.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, kind, trigger_source, status, size_bytes, error, started_at, finished_at "
                "FROM backup_runs ORDER BY id DESC LIMIT %s", (limit,)
            )
            for r in cur.fetchall():
                print(json.dumps(dict(zip(
                    ["id", "kind", "trigger", "status", "size", "error", "started", "finished"], r,
                )), ensure_ascii=False, default=str))
    finally:
        conn.close()
    return 0

def cmd_backup(kind: str) -> int:
    fn = run_db_backup if kind == "db" else run_storage_backup
    result = fn("manual")
    print(f"✔ 备份完成：{result['path']}（{result['size']} B）")
    return 0

def cmd_restore(run_id: int, target_db: str, dry_run: bool, yes: bool) -> int:
    if dry_run:
        conn = metadata.connect()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT kind, path, size_bytes, finished_at FROM backup_runs WHERE id=%s AND status='success'", (run_id,))
                row = cur.fetchone()
        finally:
            conn.close()
        if not row:
            print(f"✘ run #{run_id} 不存在或不是成功的备份")
            return 1
        print(f"[dry-run] 将恢复 run #{run_id}：{row[0]} 备份 {row[1]}（{row[2]} B，{row[3]}）→ 目标库 {target_db}")
        print("[dry-run] 实际执行会：先对目标库做安全 dump → DROP/重建目标库 → 导入（MRG_MYISAM 容忍跳过）")
        return 0
    if not yes:
        print("✘ 覆盖式恢复会 DROP 并重建目标库：确认无误请追加 --yes")
        return 1
    result = run_restore(run_id, target_db)
    print(f"✔ 恢复完成（新记录 #{result['run_id']}）：{result['detail']}")
    return 0

def main() -> int:
    parser = argparse.ArgumentParser(description="FunWind 备份服务 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    p_runs = sub.add_parser("runs"); p_runs.add_argument("limit", nargs="?", type=int, default=20)
    p_backup = sub.add_parser("backup"); p_backup.add_argument("kind", choices=["db", "storage"])
    p_restore = sub.add_parser("restore")
    p_restore.add_argument("run_id", type=int)
    p_restore.add_argument("--target-db", default=config.DB_NAME)
    p_restore.add_argument("--dry-run", action="store_true")
    p_restore.add_argument("--yes", action="store_true")
    args = parser.parse_args()
    if args.cmd == "status":
        return cmd_status()
    if args.cmd == "runs":
        return cmd_runs(args.limit)
    if args.cmd == "backup":
        return cmd_backup(args.kind)
    if args.cmd == "restore":
        return cmd_restore(args.run_id, args.target_db, args.dry_run, args.yes)
    return 1

if __name__ == "__main__":
    sys.exit(main())
