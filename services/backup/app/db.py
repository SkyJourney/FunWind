"""数据库连接与库内元信息查询。

所有连接在建立时设置会话时区 +08:00（硬约定 4，M14 清账 C4）：库内 DATETIME 一律北京墙面时间，
NOW() 若跟随容器 UTC，台账的时间比较（如残留 running 回收）会整体偏 8 小时。
"""
import datetime
from zoneinfo import ZoneInfo

import pymysql

from . import config

SESSION_TIME_ZONE = "+08:00"


def connect(*, server_level: bool = False) -> pymysql.connections.Connection:
    """建立连接：默认连接业务库；server_level=True 时不选库（建库、跨库操作用）。"""
    return pymysql.connect(
        host=config.DB_HOST,
        port=config.DB_PORT,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=None if server_level else config.DB_NAME,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=5,
        init_command=f"SET time_zone='{SESSION_TIME_ZONE}'",
    )


def now() -> str:
    """北京墙面时间字符串（与库内 DATETIME 同口径，不依赖容器 TZ）。"""
    return datetime.datetime.now(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m-%d %H:%M:%S")


def wall_time(moment: datetime.datetime | None) -> str | None:
    """把带时区的时刻换算成北京墙面时间字符串；None 原样返回（如调度器尚未算出下次触发）。"""
    if moment is None:
        return None
    return moment.astimezone(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m-%d %H:%M:%S")


def table_exists(conn, table: str) -> bool:
    """业务库内是否存在该表。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s",
            (config.DB_NAME, table),
        )
        return cur.fetchone()[0] > 0


def column_type(conn, table: str, column: str) -> str | None:
    """列的完整类型（如 `enum('a','b')`）；表或列不存在返回 None。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT COLUMN_TYPE FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s AND COLUMN_NAME = %s",
            (config.DB_NAME, table, column),
        )
        row = cur.fetchone()
        return str(row[0]) if row else None
