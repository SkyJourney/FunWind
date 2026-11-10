"""恢复演练执行器的纯函数部分（不需要数据库）。"""
from datetime import datetime as real_datetime

from app import drill
from app.restore import validate_target_db


class _FrozenDatetime(real_datetime):
    @classmethod
    def today(cls):
        return cls(2026, 11, 10, 14, 21, 5)


def test_scratch_name_carries_time_of_day_and_passes_restore_whitelist(monkeypatch):
    # 临时库名要带时分秒：同一天多次演练（手动 + 定时）不能撞同一个库名
    monkeypatch.setattr(drill, "datetime", _FrozenDatetime)
    name = drill._scratch_name()
    assert name == "ops_drill_20261110142105"
    assert validate_target_db(name) == name
