"""APScheduler 调度器实例（运行时与 API 共用；生命周期由运行时管理）。"""
from apscheduler.schedulers.background import BackgroundScheduler

from . import config

scheduler = BackgroundScheduler(timezone=config.TIMEZONE)
