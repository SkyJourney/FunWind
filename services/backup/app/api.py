"""管理 API：token 鉴权（X-OPS-Token）+ 触发/状态/历史。后台与 CLI 是主要消费者。"""
from fastapi import APIRouter, Header, HTTPException

from . import backup, config, metadata
from .scheduler import scheduler
from .restore import run_restore

router = APIRouter()

def require_token(x_ops_token: str = Header(default="")) -> None:
    if not config.OPS_TOKEN or x_ops_token != config.OPS_TOKEN:
        raise HTTPException(status_code=401, detail="X-OPS-Token 无效")

@router.get("/health")
def health():
    try:
        conn = metadata.connect()
        conn.close()
        db_ok = True
    except Exception:
        db_ok = False
    return {"ok": db_ok, "scheduler_jobs": [j.id for j in scheduler.get_jobs()]}

@router.get("/runs")
def list_runs(limit: int = 50, x_ops_token: str = Header(default="")):
    require_token(x_ops_token)
    conn = metadata.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, kind, trigger_source, status, path, size_bytes, detail, error, started_at, finished_at "
                "FROM backup_runs ORDER BY id DESC LIMIT %s", (min(limit, 200),)
            )
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        conn.close()

@router.post("/runs")
def trigger_run(kind: str, x_ops_token: str = Header(default="")):
    require_token(x_ops_token)
    if kind not in ("db", "storage"):
        raise HTTPException(status_code=400, detail="kind 必须是 db 或 storage")
    try:
        fn = backup.run_db_backup if kind == "db" else backup.run_storage_backup
        return {"ok": True, **fn("manual")}
    except backup.LockBusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:500])

@router.post("/restore")
def trigger_restore(run_id: int, target_db: str, confirm: bool = False,
                    x_ops_token: str = Header(default="")):
    """覆盖式恢复：必须 OPS_TOKEN + confirm=true 双确认；恢复前自动对当前库做安全 dump。"""
    require_token(x_ops_token)
    if not confirm:
        raise HTTPException(status_code=400, detail="覆盖式恢复必须显式 confirm=true")
    try:
        return {"ok": True, **run_restore(run_id, target_db, trigger="manual")}
    except backup.LockBusyError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)[:500])
