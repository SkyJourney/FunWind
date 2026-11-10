"""节日装扮（campaign.holiday）：农历换算固定表、目标窗口语义、参数校验。

农历换算的期望值由 lunar_python（钉版）离线算出后固化——换算库升级导致日期漂移时这里变红。
需要真实 SSR 的写入链路在镜像内集成测试（test_holiday_tools_int.py）。
"""
from datetime import date

import pytest

from app.holiday import RuleError, check_params, compute_window, fest_date

# 固定日期表（lunar_python 1.4.9 离线算出；换库/升版先复核这里）
FEST_TABLE = [
    # (名称, calendar, year, month, day, 期望公历)
    ("春节 2026", "lunar", 2026, 1, 1, "2026-02-17"),
    ("春节 2027", "lunar", 2027, 1, 1, "2027-02-06"),
    ("春节 2028", "lunar", 2028, 1, 1, "2028-01-26"),
    ("端午 2026", "lunar", 2026, 5, 5, "2026-06-19"),
    ("端午 2027", "lunar", 2027, 5, 5, "2027-06-09"),
    ("中秋 2026", "lunar", 2026, 8, 15, "2026-09-25"),
    ("中秋 2027", "lunar", 2027, 8, 15, "2027-09-15"),
    ("中秋 2028（闰月年后）", "lunar", 2028, 8, 15, "2028-10-03"),
    ("除夕 2026（→2027 年初）", "lunar", 2026, 12, 0, "2027-02-05"),
    ("除夕 2027（→2028 年初）", "lunar", 2027, 12, 0, "2028-01-25"),
    ("除夕 2028（→2029 年初）", "lunar", 2028, 12, 0, "2029-02-12"),
    ("元宵 2027", "lunar", 2027, 1, 15, "2027-02-20"),
    ("七夕 2026", "lunar", 2026, 7, 7, "2026-08-19"),
    ("重阳 2026", "lunar", 2026, 9, 9, "2026-10-18"),
    ("腊八 2026（→2027 年初）", "lunar", 2026, 12, 8, "2027-01-15"),
    ("国庆 2026", "solar", 2026, 10, 1, "2026-10-01"),
    ("元旦 2027", "solar", 2027, 1, 1, "2027-01-01"),
]


@pytest.mark.parametrize("name,calendar,year,month,day,expected", FEST_TABLE, ids=[c[0] for c in FEST_TABLE])
def test_fest_date_fixed_table(name, calendar, year, month, day, expected):
    assert fest_date(calendar, year, month, day).isoformat() == expected


def _rule(**overrides):
    rule = {
        "calendar": "lunar",
        "month": 1,
        "day": 1,  # 春节
        "beforeDays": 0,
        "durationDays": 7,
        "items": [{"effect": "theme.pack", "target": "qy2010"}],
    }
    rule.update(overrides)
    return rule


def test_window_covers_fest_and_duration():
    window = compute_window(_rule(), date(2026, 6, 1))
    assert window["year"] == 2027
    # 春节 2027-02-06，窗口 [02-06, 02-13)
    assert (window["start"], window["end"]) == (date(2027, 2, 6), date(2027, 2, 13))


def test_window_before_days_shifts_start():
    window = compute_window(_rule(beforeDays=1), date(2026, 6, 1))
    assert (window["start"], window["end"]) == (date(2027, 2, 5), date(2027, 2, 12))


def test_window_stays_on_current_year_while_it_has_not_ended():
    # 春节 2026 窗口 [02-17, 02-24)：2 月 20 日还在窗口内 → 目标年 2026，不跳 2027
    window = compute_window(_rule(), date(2026, 2, 20))
    assert window["year"] == 2026
    assert window["start"] == date(2026, 2, 17)


def test_window_last_active_day_still_targets_current_year():
    # end 前一天（02-23）是最后一个生效日 → 目标年仍 2026
    window = compute_window(_rule(), date(2026, 2, 23))
    assert window["year"] == 2026 and window["start"] == date(2026, 2, 17)


def test_window_uses_next_year_after_current_window_has_ended():
    window = compute_window(_rule(), date(2026, 3, 1))
    assert window["year"] == 2027


def test_window_boundary_today_is_exclusive_end_jumps_to_next_year():
    # end 当天 = 右开边界已过期 → 明年
    window = compute_window(_rule(), date(2026, 2, 24))
    assert window["year"] == 2027


def test_solar_window():
    window = compute_window(_rule(calendar="solar", month=10, day=1), date(2026, 6, 1))
    assert (window["year"], window["start"], window["end"]) == (
        2026,
        date(2026, 10, 1),
        date(2026, 10, 8),
    )


def test_window_lunar_day30_skips_short_month_year():
    # 农历 2026/2 只有 29 天（无 30 日）；2027/2 是大月（30 日 = 公历 2027-04-06）
    # → 从 2026-05-01 看（今年窗口若存在也已过期）落到 2027 年
    window = compute_window(_rule(month=2, day=30), date(2026, 5, 1))
    assert window["year"] == 2027
    assert (window["start"], window["end"]) == (date(2027, 4, 6), date(2027, 4, 13))


def test_window_lunar_day30_both_years_short_fails_clearly():
    # 农历 2026/5 与 2027/5 都只有 29 天 → 两年都算不出 30 日，报可读错误而不是库的英文异常
    with pytest.raises(RuleError, match="今年与明年都算不出"):
        compute_window(_rule(month=5, day=30), date(2026, 3, 1))


def test_fest_date_solar_invalid_month_day_is_rule_error():
    # 防御：绕过 check_params 的调用也不该拿到 ValueError 库异常
    with pytest.raises(RuleError, match="公历 2 月没有 31 日"):
        fest_date("solar", 2026, 2, 31)


def test_lunar_year_boundary_chuxi_targets_next_gregorian_year():
    # 农历 2026 年腊月末（除夕）= 公历 2027-02-05：2026 年 6 月看，目标年 2026（农历年锚定），落在公历 2027
    window = compute_window(_rule(month=12, day=0, durationDays=1), date(2026, 6, 1))
    assert window["year"] == 2026
    assert window["start"] == date(2027, 2, 5)
    assert window["end"] == date(2027, 2, 6)


def test_check_params_applies_defaults_and_normalizes():
    params = check_params(_rule(beforeDays=None, durationDays=None))
    assert params["beforeDays"] == 0 and params["durationDays"] == 7


@pytest.mark.parametrize(
    "overrides,fragment",
    [
        ({"calendar": "lunisolar"}, "calendar"),
        ({"month": 0}, "month"),
        ({"month": 13}, "month"),
        ({"day": 31, "calendar": "lunar"}, "day"),  # 农历没有 31 日
        ({"day": 0, "calendar": "solar"}, "day"),  # 月末约定仅农历
        ({"calendar": "solar", "month": 2, "day": 31}, "公历 2 月没有 31 日"),  # 真实日历（R-20）
        ({"calendar": "solar", "month": 4, "day": 31}, "公历 4 月没有 31 日"),
        ({"calendar": "solar", "month": 2, "day": 29}, "闰日"),  # 闰日不在候选年循环里
        ({"beforeDays": 31}, "beforeDays"),
        ({"durationDays": 0}, "durationDays"),
        ({"durationDays": 91}, "durationDays"),
        ({"items": []}, "items"),
        ({"items": [{"effect": "theme.pack", "target": "x"}] * 7}, "items"),
        ({"items": [{"effect": "points.boost", "target": "x"}]}, "未知的装扮效果"),
        (
            {"items": [{"effect": "theme.pack", "target": "a"}, {"effect": "theme.pack", "target": "b"}]},
            "重复",
        ),
        ({"extra": 1}, "未知参数"),
    ],
)
def test_check_params_rejects(overrides, fragment):
    with pytest.raises(RuleError, match=fragment):
        check_params(_rule(**overrides))


def test_check_params_requires_exact_item_shape():
    with pytest.raises(RuleError, match="effect, target"):
        check_params(_rule(items=[{"effect": "theme.pack"}]))
    with pytest.raises(RuleError, match="effect, target"):
        check_params(_rule(items=[{"effect": "theme.pack", "target": "x", "priority": 1}]))
