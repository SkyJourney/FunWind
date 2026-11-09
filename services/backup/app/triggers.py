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
_ONCE_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")

# cron 各字段的严格语法（与 web 侧 apps/web/src/lib/ops/executors.ts 同一套规则，双端契约夹具守护）：
# 逗号分隔的若干项，每项为 `*` / `*/步长` / `值` / `值-值` / `值-值/步长`；步长为正整数；区间不得倒置。
# APScheduler 自身的解析偏宽（如悬空区间 `mon-` 会被放行），所以先过这层，再交给它做最终解析。
MONTH_NAMES = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
WEEKDAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_CRON_FIELDS = (
    ("分", 0, 59, None),
    ("时", 0, 23, None),
    ("日", 1, 31, None),
    ("月", 1, 12, MONTH_NAMES),
    ("星期", None, None, WEEKDAY_NAMES),
)
_ITEM_RE = re.compile(r"(\*|[0-9a-z]+(?:-[0-9a-z]+)?)(?:/([0-9]+))?")


class TriggerConfigError(ValueError):
    """触发器配置不合法（加载时跳过该触发器并在健康状态里报告）。"""


def _field_value(token: str, low: int | None, high: int | None, names: tuple[str, ...] | None) -> int | None:
    """字段里的一个取值 → 序号；名称按表内位置换算到与数字同一基准（月份 jan=1，星期 mon=0）。
    不合法返回 None。"""
    if token.isdigit() and low is not None:
        value = int(token)
        return value if low <= value <= high else None
    if names is not None and token in names:
        return names.index(token) + (low or 0)
    return None


def _check_cron_field(field: str, spec: tuple) -> bool:
    """单个字段的严格语法：步长为正整数且不超过区间跨度（`*` 取字段全幅；APScheduler 对名称区间
    如 `jan-dec/13` 不校验步长，这里统一收紧）；区间不得倒置。"""
    label, low, high, names = spec
    for item in field.split(","):
        match = _ITEM_RE.fullmatch(item)
        if not match:
            return False
        body, step = match.group(1), match.group(2)
        if step is not None and int(step) < 1:
            return False
        if body == "*":
            if step is not None and (low is None or int(step) > high - low):
                return False
            continue
        if step is not None and "-" not in body:
            return False  # `值/步长` 不是标准写法，不收
        bounds = [_field_value(part, low, high, names) for part in body.split("-")]
        if any(value is None for value in bounds) or (len(bounds) == 2 and bounds[0] > bounds[1]):
            return False
        if step is not None and int(step) > bounds[1] - bounds[0]:
            return False
    return True


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
    for field, spec in zip(fields, _CRON_FIELDS):
        if not _check_cron_field(field.lower(), spec):
            raise TriggerConfigError(f"cron 的{spec[0]}字段不合法：{field!r}（完整表达式 {expr!r}）")
    normalized = " ".join(fields).lower()
    try:
        CronTrigger.from_crontab(normalized, timezone=config.TIMEZONE)
    except ValueError as exc:
        raise TriggerConfigError(f"cron 表达式无效：{expr!r}（{exc}）") from exc
    return normalized


def parse_once(expr: str) -> datetime:
    """单次触发时刻（北京墙面时间）→ 带时区的 datetime；不合法抛 TriggerConfigError。

    各段位数写死（strptime 会接受单位数月份，与 web 侧校验不一致）。
    """
    text = expr.strip()
    try:
        if not _ONCE_RE.fullmatch(text):
            raise ValueError("format")
        naive = datetime.strptime(text, ONCE_FORMAT)
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
