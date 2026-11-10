"""运维任务管线入口：FastAPI（管理 API）+ APScheduler（任务调度）。

启动不阻塞也不崩溃：引导（台账演进、加载配置、登记触发器）在运行时的后台线程里完成，
缺必需配置或库不通时服务以降级模式存活，/health 如实返回 503（M14 F23）。
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .api import router
from .runtime import runtime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    runtime.start()
    yield
    runtime.shutdown()


app = FastAPI(title="FunWind Ops Pipeline", lifespan=lifespan)
app.include_router(router)
