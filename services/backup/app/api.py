"""管理 API：X-OPS-Token 鉴权 + 健康 / 任务 / 触发 / 台账 / 恢复。web 后台与 CLI 是主要消费者。

鉴权用常量时间比较（M14 清账 C3）；口令未配置时管理类 API 一律拒绝（服务处于降级模式）。
旧端点 `POST /runs?kind=` 保持同步语义：web 侧切到异步端点之前的兼容期（Step 6 移除）。
"""
import hmac

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import JSONResponse

from . import config, ledger
from .backup import LockBusyError
from .restore import run_restore, validate_target_db
from .runtime import (
    ManualTriggerRejected,
    RuntimeUnavailable,
    TaskBusy,
    TaskNotFound,
    run_now,
    runtime,
)

router = APIRouter()

# 兼容期：v1 的 kind 写法映射到任务键
LEGACY_KINDS = {"db": "backup.db", "storage": "backup.storage"}


def require_token(x_ops_token: str = Header(default="")) -> None:
    expected = config.OPS_TOKEN
    if not expected or not hmac.compare_digest(x_ops_token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="X-OPS-Token 无效")


def _require_ready() -> None:
    if not runtime.status.ready:
        raise HTTPException(status_code=503, detail=runtime.unavailable_reason())


@router.get("/health")
def health():
    """无需鉴权（compose healthcheck 用）：健康 200，降级 503，正文如实报告原因。"""
    ok, body = runtime.health()
    return JSONResponse(status_code=200 if ok else 503, content=body)


@router.get("/tasks", dependencies=[Depends(require_token)])
def list_tasks():
    _require_ready()
    return runtime.describe_tasks()


@router.post("/tasks/{task_key}/runs", status_code=202, dependencies=[Depends(require_token)])
def trigger_task(task_key: str):
    """异步手动触发：立即返回 run_id，执行进度查 GET /runs/{run_id}。"""
    try:
        run_id = runtime.trigger_manual(task_key)
    except RuntimeUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except TaskNotFound:
        raise HTTPException(status_code=404, detail=f"任务不存在：{task_key}")
    except ManualTriggerRejected as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except TaskBusy as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"ok": True, "run_id": run_id}


@router.post("/config/reload", dependencies=[Depends(require_token)])
def reload_config():
    """热加载通知（web 保存配置后调用）；失败无妨，周期对账会兜底。"""
    _require_ready()
    try:
        return {"ok": True, **runtime.reload()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"配置重载失败：{str(exc)[:300]}")


@router.get("/runs", dependencies=[Depends(require_token)])
def list_runs(limit: int = 50):
    _require_ready()
    return ledger.list_runs(limit)


@router.get("/runs/{run_id}", dependencies=[Depends(require_token)])
def get_run(run_id: int):
    _require_ready()
    row = ledger.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"运行记录不存在：#{run_id}")
    return row


@router.post("/runs", dependencies=[Depends(require_token)])
def trigger_run_sync(kind: str):
    """兼容期的同步触发（v1 语义：执行完才返回）。"""
    task_key = LEGACY_KINDS.get(kind)
    if task_key is None:
        raise HTTPException(status_code=400, detail="kind 必须是 db 或 storage")
    _require_ready()
    task = runtime.task(task_key)
    if task is None:
        raise HTTPException(status_code=404, detail=f"任务不存在：{task_key}")
    try:
        return {"ok": True, **run_now(task)}
    except LockBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:500])


@router.post("/restore", dependencies=[Depends(require_token)])
def trigger_restore(run_id: int, target_db: str, confirm: bool = False):
    """覆盖式恢复：必须 OPS_TOKEN + confirm=true 双确认；目标库名先过白名单（C1）。"""
    if not confirm:
        raise HTTPException(status_code=400, detail="覆盖式恢复必须显式 confirm=true")
    try:
        validate_target_db(target_db)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _require_ready()
    try:
        return {"ok": True, **run_restore(run_id, target_db, trigger="manual")}
    except LockBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:500])
