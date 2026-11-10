#!/usr/bin/env python3
"""运维任务管线 CLI（容器内执行）：docker exec funwind-ops python cli.py <命令>

命令：
  status                      配置来源、任务与触发器（含下次运行）、最近 5 条台账
  tasks                       任务与触发器清单（JSON）
  runs [N]                    最近 N 条台账（默认 20）
  run <task_key>              立即同步执行一个任务（manual 触发，与后台手动触发同一执行器）
  backup db|storage           同 run backup.db / backup.storage（v1 兼容写法）
  restore <run_id> [--target-db X] [--dry-run] [--yes]
                              覆盖式恢复：默认目标库为业务库；必须 --yes 才会真正执行
"""
import argparse
import json
import sys
from dataclasses import asdict

from app import config, db, ledger
from app.restore import run_restore, validate_target_db
from app.runtime import run_now
from app.tasks import LoadResult, load_tasks


def _prepare() -> LoadResult:
    """台账幂等演进（与服务启动同一逻辑）+ 加载任务配置。"""
    conn = db.connect()
    try:
        ledger.ensure_schema(conn)
        return load_tasks(conn)
    finally:
        conn.close()


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def cmd_status() -> int:
    loaded = _prepare()
    states = ledger.load_trigger_states()
    print(f"DB: {config.DB_HOST}:{config.DB_PORT}/{config.DB_NAME}｜配置来源：{loaded.source}")
    for problem in loaded.problems:
        print(f"  ⚠ {problem}")
    print("任务：")
    for task in loaded.tasks:
        flag = "启用" if task.enabled else "停用"
        print(f"  {task.key}（{task.name}，{flag}，参数 {_dump(task.params)}）")
        for trigger in task.triggers:
            state = states.get(trigger.key, {})
            print(
                f"    - {trigger.kind} {trigger.expr or ''}｜下次 {state.get('next_fire_at') or '—'}｜"
                f"上次 {state.get('last_fired_at') or '—'} {state.get('last_result') or ''}"
            )
    print("最近 5 条台账：")
    for run in ledger.list_runs(5):
        print(f"  #{run['id']} {run['task_key']}/{run['trigger_source']} {run['status']} @ {run['started_at']}")
    return 0


def cmd_tasks() -> int:
    loaded = _prepare()
    tasks = [asdict(task) for task in loaded.tasks]
    print(_dump({"source": loaded.source, "problems": loaded.problems, "tasks": tasks}))
    return 0


def cmd_runs(limit: int) -> int:
    _prepare()
    for run in ledger.list_runs(limit):
        print(_dump(run))
    return 0


def cmd_run(task_key: str) -> int:
    loaded = _prepare()
    task = next((t for t in loaded.tasks if t.key == task_key), None)
    if task is None:
        print(f"✘ 任务不存在：{task_key}（配置来源：{loaded.source}）")
        return 1
    result = run_now(task)
    print(f"✔ {task_key} 完成（run #{result['run_id']}）：{result.get('path', '')}（{result.get('size', '')} B）")
    return 0


def cmd_restore(run_id: int, target_db: str, dry_run: bool, yes: bool) -> int:
    try:
        validate_target_db(target_db)
    except ValueError as exc:
        print(f"✘ {exc}")
        return 1
    _prepare()
    if dry_run:
        run = ledger.get_run(run_id)
        if not run or run["status"] != "success" or run["kind"] != "db":
            print(f"✘ run #{run_id} 不存在或不是成功的 db 备份")
            return 1
        print(f"[dry-run] 将恢复 run #{run_id}：{run['path']}（{run['size_bytes']} B，{run['finished_at']}）→ 目标库 {target_db}")
        print("[dry-run] 实际执行会：目标库存在则先做安全 dump → DROP/重建目标库 → 导入（MRG_MYISAM 容忍跳过）")
        return 0
    if not yes:
        print("✘ 覆盖式恢复会 DROP 并重建目标库：确认无误请追加 --yes")
        return 1
    result = run_restore(run_id, target_db)
    print(f"✔ 恢复完成（新记录 #{result['run_id']}）：{result['detail']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="FunWind 运维任务管线 CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("tasks")
    p_runs = sub.add_parser("runs")
    p_runs.add_argument("limit", nargs="?", type=int, default=20)
    p_run = sub.add_parser("run")
    p_run.add_argument("task_key")
    p_backup = sub.add_parser("backup")
    p_backup.add_argument("kind", choices=["db", "storage"])
    p_restore = sub.add_parser("restore")
    p_restore.add_argument("run_id", type=int)
    p_restore.add_argument("--target-db", default=config.DB_NAME)
    p_restore.add_argument("--dry-run", action="store_true")
    p_restore.add_argument("--yes", action="store_true")
    args = parser.parse_args()

    if not config.DB_PASSWORD:
        print("✘ 缺少环境变量 BACKUP_DB_PASSWORD")
        return 2
    if args.cmd == "status":
        return cmd_status()
    if args.cmd == "tasks":
        return cmd_tasks()
    if args.cmd == "runs":
        return cmd_runs(args.limit)
    if args.cmd == "run":
        return cmd_run(args.task_key)
    if args.cmd == "backup":
        return cmd_run("backup.db" if args.kind == "db" else "backup.storage")
    if args.cmd == "restore":
        return cmd_restore(args.run_id, args.target_db, args.dry_run, args.yes)
    return 1


if __name__ == "__main__":
    sys.exit(main())
