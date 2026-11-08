"""APScheduler 调度器实例（main 与 api 共用；生命周期由 main 的 lifespan 管理）。"""
from apscheduler.schedulers.background import BackgroundScheduler

scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
