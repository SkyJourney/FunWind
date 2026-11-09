"""触发器模型与 cron 写法约定（M14 §3.4）。

APScheduler 3.x 的星期字段 0 = 周一（标准 crontab 的 0 = 周日），且 from_crontab() 不做转换
（官方文档称之为 historical mistake，M14 F8）。cron 一旦后台可编辑，数字星期会静默错位一天——
所以统一约定：星期字段只认名称 mon…sun，出现数字一律拒绝，不猜语义。
"""
import re
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from . import config

TriggerKind = Literal["cron", "once", "manual"]
TRIGGER_KINDS: tuple[str, ...] = ("cron", "once", "manual")

# 单次触发时刻的写法：北京墙面时间
ONCE_FORMAT = "%Y-%m-%d %H:%M:%S"


class TriggerConfigError(ValueError):
    """触发器配置不合法（加载时跳过该触发器并在健康状态里报告）。"""


def validate_cron(expr: str) -> str:
    """校验并规范化 5 段 cron（多余空白折叠）；不合法抛 TriggerConfigError。"""
    fields = expr.split()
    if len(fields) != 5:
        raise TriggerConfigError(f"cron 须为 5 段（分 时 日 月 星期）：{expr!r}")
    if re.search(r"\d", fields[4]):
        raise TriggerConfigError(
            f"星期字段须用名称 mon…sun，不接受数字：{expr!r}"
            "（APScheduler 的 0 是周一而 crontab 的 0 是周日，数字写法会静默错位一天）"
        )
    normalized = " ".join(fields)
    try:
        CronTrigger.from_crontab(normalized, timezone=config.TIMEZONE)
    except ValueError as exc:
        raise TriggerConfigError(f"cron 表达式无效：{expr!r}（{exc}）") from exc
    return normalized


def parse_once(expr: str) -> datetime:
    """单次触发时刻（北京墙面时间）→ 带时区的 datetime；不合法抛 TriggerConfigError。"""
    try:
        naive = datetime.strptime(expr.strip(), ONCE_FORMAT)
    except ValueError as exc:
        raise TriggerConfigError(f"单次触发时刻须为「YYYY-MM-DD HH:MM:SS」北京时间：{expr!r}") from exc
    return naive.replace(tzinfo=ZoneInfo(config.TIMEZONE))


@dataclass(frozen=True)
class TriggerDef:
    """一个触发器。key 是状态表主键：配置表里的触发器为 `t{id}`，内置默认为 `default:{task}:{kind}`。"""

    key: str
    task_key: str
    kind: str
    expr: str | None
    enabled: bool = True

    def validated(self) -> "TriggerDef":
        """返回规范化后的副本；不合法抛 TriggerConfigError。"""
        if self.kind not in TRIGGER_KINDS:
            raise TriggerConfigError(f"未知触发器类型：{self.kind!r}")
        if self.kind == "cron":
            return replace(self, expr=validate_cron(self.expr or ""))
        if self.kind == "once":
            parse_once(self.expr or "")
            return replace(self, expr=(self.expr or "").strip())
        return replace(self, expr=None)


def build_schedule(trigger: TriggerDef) -> CronTrigger | DateTrigger | None:
    """翻译成 APScheduler 触发器；手动触发器不进调度器，返回 None。"""
    if trigger.kind == "cron":
        return CronTrigger.from_crontab(trigger.expr or "", timezone=config.TIMEZONE)
    if trigger.kind == "once":
        return DateTrigger(run_date=parse_once(trigger.expr or ""), timezone=config.TIMEZONE)
    return None
