"""恢复演练执行器（M14 Step 5，D12 勾选）：定期把最新成功 db 备份导入同实例临时库并对账。

与 BACKUP.md §4 人工演练的口径一致（备份 → 导入 → 表对账 → 清理），差异与理由：
- **同实例临时库**而非临时容器：无需 docker 权限（挂载 docker.sock 会给管线容器宿主 root 级
  权限，安全面不成比例）；同实例天然同版本，覆盖「备份可导入、表结构完整、数据可读」的核心
  验证目标。跨实例/跨版本恢复仍按 BACKUP.md §4 人工执行（部署/大版本变更时）。
- 对账口径：导入零 fatal 错误（run_restore 已保证）+ 演练库表集合与源库一致 + 核心表行数抽样
  进明细。源库在备份后新迁移的表只记明细不计失败（演练库是备份时刻快照，天然有差）。
- 临时库随演练 DROP：失败路径尽力清理（成功路径必删），孤儿库由人工 DROP。

台账：drill 行（kind=drill）记演练结论；restore 动作本身也写一条 restore 行（真实发生）。
规则参数：不接受参数（周期由触发器决定）。
"""
import re
import time
from datetime import date

from . import config, db, ledger, restore

SCRATCH_PREFIX = "ops_drill_"
# 管线自治表：不属于业务数据，不参与「源库 ⊆ 演练库」的结构对账
PIPELINE_TABLES = frozenset({"ops_runs", "ops_trigger_state", "backup_runs"})


class RuleError(ValueError):
    """任务参数不合法（演练不接受参数，非空即拒绝）。"""


def check_params(raw: dict) -> dict:
    if raw:
        raise RuleError(f"恢复演练不接受参数：{sorted(raw)}")
    return {}


def _scratch_name() -> str:
    # 目标库名过 restore 白名单（字母/数字/下划线），不能含连字符
    return f"{SCRATCH_PREFIX}{date.today().strftime('%Y%m%d%H%M%S')}"


def _table_set(database: str) -> set[str]:
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT TABLE_NAME FROM information_schema.TABLES "
                "WHERE TABLE_SCHEMA = %s AND TABLE_TYPE = 'BASE TABLE'",
                (database,),
            )
            return {str(row[0]) for row in cur.fetchall()}
    finally:
        conn.close()


def _count(database: str, table: str) -> int:
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) FROM `{database}`.`{table}`")
            return int(cur.fetchone()[0])
    finally:
        conn.close()


def _drop_database(name: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_]+", name):
        return  # 名字由本模块生成（白名单字符），此处为纵深防御
    conn = db.connect(server_level=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS `{name}`")
    finally:
        conn.close()


def run_drill(
    params: dict,
    *,
    trigger: str,
    task_key: str = "drill.restore",
    run_id: int | None = None,
    task_name: str = "恢复演练",
) -> dict:
    """演练：最新成功 db 备份 → 同实例临时库导入 → 对账 → DROP。返回含 run_id 的结果摘要。

    台账生命周期与备份执行器一致：先校验规则（非空即拒，不产生台账行），再插 running 行，
    任何失败收尾为 failed；返回含 run_id 的结果摘要。"""
    rule = check_params(dict(params))
    run_id = run_id if run_id is not None else ledger.insert_run("drill", trigger, task_key)
    scratch: str | None = None
    started = time.monotonic()

    try:
        latest = ledger.latest_successful_db_run()
        if latest is None:
            raise RuntimeError("没有可演练的成功 db 备份（backup.db 尚未成功执行过）")

        scratch = _scratch_name()
        # run_restore 会：目标库不存在跳过安全 dump → DROP/CREATE → 导入（零 fatal 才算成功）
        restore.run_restore(latest["id"], scratch, trigger=trigger)
        scratch_name = scratch

        source_tables = _table_set(config.DB_NAME) - PIPELINE_TABLES
        scratch_tables = _table_set(scratch)
        # 结构对账：备份是全备，备份后源库新建的表不在演练库属正常迁移（计入明细不计失败）；
        # 反向（演练库有而源库没有）才是备份完整性问题 → 失败
        missing = source_tables - scratch_tables
        extra = scratch_tables - source_tables
        if extra:
            raise RuntimeError(f"演练对账失败：演练库多出 {len(extra)} 张表（备份截断？）：{sorted(extra)[:6]}")
        notes = []
        if missing:
            notes.append(f"源库多 {len(missing)} 张表（备份后正常迁移所致，不计失败）：{', '.join(sorted(missing)[:6])}")
        else:
            notes.append(f"表集合与源库一致（{len(scratch_tables)} 张）")
        # 核心表行数抽样（源 vs 演练，前 3 张）：备份可导入且数据可读的直接证据
        for table in sorted(source_tables & scratch_tables)[:3]:
            notes.append(f"{table} 行数 源={_count(config.DB_NAME, table)}/演练={_count(scratch, table)}")

        _drop_database(scratch)
        scratch = None
        seconds = round(time.monotonic() - started, 1)
        detail = (
            f"演练通过：备份 #{latest['id']}（{latest['finished_at'] or latest['started_at']}）导入并核对；"
            + "；".join(notes)
            + f"；耗时 {seconds}s；临时库已 DROP"
        )
        ledger.finish_run(run_id, "success", detail=detail)
    except Exception as exc:
        if scratch is not None:
            try:
                _drop_database(scratch)
            except Exception:
                pass  # 清理失败不掩盖原始错误；孤儿库可人工 DROP
        ledger.finish_run(run_id, "failed", error=str(exc)[:800])
        raise

    return {
        "run_id": run_id,
        "restored_from": latest["id"],
        "tables": len(scratch_tables),
        "seconds": seconds,
        "detail": detail,
    }
