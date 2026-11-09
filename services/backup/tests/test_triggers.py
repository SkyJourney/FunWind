"""触发器与 cron 写法约定（M14 §3.4 / F8）。"""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.triggers import TriggerConfigError, TriggerDef, build_schedule, parse_once, validate_cron

SHANGHAI = ZoneInfo("Asia/Shanghai")


@pytest.mark.parametrize(
    "expr, normalized",
    [
        ("10 3 * * *", "10 3 * * *"),
        ("10  3 *   * *", "10 3 * * *"),
        ("0 2 * * fri", "0 2 * * fri"),
        ("0 9 * * mon-fri", "0 9 * * mon-fri"),
        ("*/15 * * * *", "*/15 * * * *"),
    ],
)
def test_validate_cron_accepts_and_normalizes(expr, normalized):
    assert validate_cron(expr) == normalized


@pytest.mark.parametrize("expr", ["0 0 * * 0", "0 0 * * 1-5", "0 0 * * */2", "0 0 * * mon,3"])
def test_validate_cron_rejects_numeric_weekday(expr):
    with pytest.raises(TriggerConfigError, match="星期字段须用名称"):
        validate_cron(expr)


@pytest.mark.parametrize("expr", ["", "* * * *", "0 0 * * * *", "61 * * * *", "0 25 * * *", "0 0 * * funday"])
def test_validate_cron_rejects_malformed(expr):
    with pytest.raises(TriggerConfigError):
        validate_cron(expr)


@pytest.mark.parametrize("day, weekday", [("mon", 0), ("fri", 4), ("sun", 6)])
def test_weekday_names_fire_on_the_named_day(day, weekday):
    """语义钉子：名称写法下「每周五」必须真的落在周五（数字写法在 APScheduler 会错位一天）。"""
    schedule = build_schedule(TriggerDef("k", "t", "cron", validate_cron(f"0 2 * * {day}")))
    now = datetime(2026, 11, 9, 12, 0, tzinfo=SHANGHAI)  # 周一
    fire = schedule.get_next_fire_time(None, now)
    assert fire.astimezone(SHANGHAI).weekday() == weekday
    assert (fire.astimezone(SHANGHAI).hour, fire.astimezone(SHANGHAI).minute) == (2, 0)


def test_cron_fires_in_beijing_wall_time():
    schedule = build_schedule(TriggerDef("k", "t", "cron", "10 3 * * *"))
    fire = schedule.get_next_fire_time(None, datetime(2026, 11, 9, 12, 0, tzinfo=SHANGHAI))
    assert fire.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M") == "2026-11-10 03:10"


def test_parse_once_is_beijing_wall_time():
    moment = parse_once(" 2027-02-16 00:00:00 ")
    assert moment.tzinfo is not None
    assert moment.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M:%S") == "2027-02-16 00:00:00"


@pytest.mark.parametrize("expr", ["", "2027-02-16", "2027/02/16 00:00:00", "2027-02-30 00:00:00"])
def test_parse_once_rejects_bad_format(expr):
    with pytest.raises(TriggerConfigError):
        parse_once(expr)


def test_trigger_validated_normalizes_by_kind():
    assert TriggerDef("k", "t", "manual", "anything").validated().expr is None
    assert TriggerDef("k", "t", "cron", "10  3 * * *").validated().expr == "10 3 * * *"
    assert TriggerDef("k", "t", "once", " 2027-02-16 00:00:00 ").validated().expr == "2027-02-16 00:00:00"
    with pytest.raises(TriggerConfigError, match="未知触发器类型"):
        TriggerDef("k", "t", "hourly", None).validated()


def test_manual_trigger_has_no_schedule():
    assert build_schedule(TriggerDef("k", "t", "manual", None)) is None
