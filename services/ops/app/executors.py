"""执行器注册表（M14 §3.3）：executor 键 → 参数校验 + 执行函数 + 互斥组 + 台账类别。

新增一类任务 = 在这里登记一项。参数校验严格（未知字段拒绝），Step 2 起与 web 侧 zod 契约用同一组
JSON 夹具做双端测试。恢复（restore）需要逐次指定源备份与目标库，不是可调度任务，走专用 API/CLI，
不在注册表里。
"""
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from . import backup, holiday


class ParamsError(ValueError):
    """任务参数不合法（加载时跳过该任务并在健康状态里报告）。"""


@dataclass(frozen=True)
class ExecutorSpec:
    key: str
    label: str
    run_kind: str  # 台账 kind
    lock_group: str  # 互斥组：同组任务共用一把 GET_LOCK，串行执行
    validate: Callable[[Mapping[str, object]], dict]
    run: Callable[..., dict]  # run(params, *, trigger, task_key, run_id=None) → 结果摘要（含 run_id）


# 互斥组 → 台账类别（手动触发前按组预检 running；恢复与备份共用一把锁；
# 节日装扮是幂等的 create-if-absent HTTP 写，不与备份互斥、自身也无并发风险）
LOCK_GROUP_KINDS: dict[str, tuple[str, ...]] = {
    "backup": ("db", "storage", "restore", "drill"),
    "holiday": ("holiday",),
}


def _retention_params(raw: Mapping[str, object]) -> dict:
    """备份类参数：只有可选的 keep（保留份数，1–90）；缺省时按 site_settings / 环境默认解析。"""
    unknown = set(raw) - {"keep"}
    if unknown:
        raise ParamsError(f"未知参数：{', '.join(sorted(unknown))}")
    keep = raw.get("keep")
    if keep is None:
        return {}
    if isinstance(keep, bool) or not isinstance(keep, int) or not 1 <= keep <= 90:
        raise ParamsError(f"keep 须为 1–90 的整数：{keep!r}")
    return {"keep": keep}


def _holiday_params(raw: Mapping[str, object]) -> dict:
    """节日规则参数：结构校验（effect 集合/去重/日期范围），target 存在性由 SSR 写服务校验。"""
    try:
        return holiday.check_params(dict(raw))
    except holiday.RuleError as exc:
        raise ParamsError(str(exc)) from exc


def _run_db(params: Mapping[str, object], *, trigger: str, task_key: str, run_id: int | None = None, task_name: str = "") -> dict:
    return backup.run_db_backup(trigger, task_key=task_key, keep=params.get("keep"), run_id=run_id)


def _run_storage(params: Mapping[str, object], *, trigger: str, task_key: str, run_id: int | None = None, task_name: str = "") -> dict:
    return backup.run_storage_backup(trigger, task_key=task_key, keep=params.get("keep"), run_id=run_id)


def _run_holiday(params: Mapping[str, object], *, trigger: str, task_key: str, run_id: int | None = None, task_name: str = "") -> dict:
    # 失败收尾在 ensure 内部（校验前置：坏规则不产生台账行）
    return holiday.ensure_campaign_window(
        params, task_name, trigger=trigger, task_key=task_key, run_id=run_id
    )


REGISTRY: dict[str, ExecutorSpec] = {
    spec.key: spec
    for spec in (
        ExecutorSpec("backup.db", "数据库备份", "db", "backup", _retention_params, _run_db),
        ExecutorSpec("backup.storage", "存储备份", "storage", "backup", _retention_params, _run_storage),
        ExecutorSpec(
            "campaign.holiday",
            "节日装扮",
            "holiday",
            "holiday",
            _holiday_params,
            _run_holiday,
        ),
    )
}


def kinds_in_group(group: str) -> tuple[str, ...]:
    return LOCK_GROUP_KINDS.get(group, ())
