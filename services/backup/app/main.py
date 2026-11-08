"""备份服务入口：FastAPI（管理 API）+ APScheduler（cron 定时）。

启动时自治建表（backup_runs）；备份/恢复的执行与编排都在 backup.py / restore.py，
API 层只做鉴权、触发与状态暴露。
"""
import logging
from contextlib import asynccontextmanager

from apscheduler.triggers.cron import CronTrigger
from fastapi import FastAPI

from . import backup, config, metadata
from .api import router
from .scheduler import scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    metadata.ensure_table()
    scheduler.add_job(
        backup.run_db_backup, CronTrigger.from_crontab(config.DB_CRON),
        args=["cron"], id="backup-db", coalesce=True, misfire_grace_time=3600,
    )
    scheduler.add_job(
        backup.run_storage_backup, CronTrigger.from_crontab(config.STORAGE_CRON),
        args=["cron"], id="backup-storage", coalesce=True, misfire_grace_time=3600,
    )
    scheduler.start()
    log.info("备份服务就绪：DB cron=%s｜storage cron=%s｜保留 DB %d 份 / storage %d 份",
             config.DB_CRON, config.STORAGE_CRON, config.KEEP_DB, config.KEEP_STORAGE)
    yield
    scheduler.shutdown(wait=False)

app = FastAPI(title="FunWind Backup Service", lifespan=lifespan)
app.include_router(router)
