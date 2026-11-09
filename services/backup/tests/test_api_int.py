"""API 正常路径：引导后的异步触发全链路（HTTP → 预插台账 → 调度器线程池 → 台账收尾）与兼容端点。

不跑 lifespan、不碰全局单例：给 api 模块注入一个新建并已引导的运行时，测试结束即销毁，
其他依赖「未引导」状态的测试不受影响。
"""
import time

import pytest
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi.testclient import TestClient

from app import api, config, ledger
from app.main import app
from app.runtime import PipelineRuntime
from conftest import TEST_TOKEN

pytestmark = pytest.mark.db

HEADERS = {"x-ops-token": TEST_TOKEN}


@pytest.fixture
def ready_client(temp_db, fake_executors, monkeypatch):
    fresh = PipelineRuntime(BackgroundScheduler(timezone=config.TIMEZONE))
    assert fresh.bootstrap_once()
    monkeypatch.setattr(api, "runtime", fresh)
    try:
        yield TestClient(app)
    finally:
        fresh.shutdown()


def _wait_for(predicate, timeout: float = 6.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_health_is_200_once_bootstrapped(ready_client):
    response = ready_client.get("/health")
    assert response.status_code == 200
    assert sorted(response.json()["scheduler_jobs"]) == ["default:backup.db:cron", "default:backup.storage:cron"]


def test_async_manual_trigger_full_chain(ready_client):
    created = ready_client.post("/tasks/backup.db/runs", headers=HEADERS)
    assert created.status_code == 202
    run_id = created.json()["run_id"]

    assert _wait_for(lambda: ledger.get_run(run_id)["status"] == "success")
    fetched = ready_client.get(f"/runs/{run_id}", headers=HEADERS)
    assert fetched.status_code == 200 and fetched.json()["task_key"] == "backup.db"

    history = ready_client.get("/runs", params={"limit": 5}, headers=HEADERS)
    assert history.status_code == 200 and any(row["id"] == run_id for row in history.json())
    assert _wait_for(lambda: ledger.load_trigger_states()["default:backup.db:manual"]["last_run_id"] == run_id)


def test_async_trigger_rejections_map_to_status_codes(ready_client):
    assert ready_client.post("/tasks/nope/runs", headers=HEADERS).status_code == 404
    ledger.insert_run("restore", "manual", "restore")  # 同一互斥组忙碌
    assert ready_client.post("/tasks/backup.storage/runs", headers=HEADERS).status_code == 409


def test_config_reload_endpoint(ready_client):
    response = ready_client.post("/config/reload", headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True and body["changed"] is False and body["source"] == "default"


def test_tasks_endpoint_lists_defaults_with_trigger_states(ready_client):
    body = ready_client.get("/tasks", headers=HEADERS).json()
    assert body["source"] == "default"
    assert {task["key"] for task in body["tasks"]} == {"backup.db", "backup.storage"}
    db_task = next(task for task in body["tasks"] if task["key"] == "backup.db")
    assert {t["kind"] for t in db_task["triggers"]} == {"cron", "manual"}
    assert any(t["next_fire_at"] for t in db_task["triggers"])


def test_legacy_sync_endpoint_executes_and_ledgers(ready_client):
    response = ready_client.post("/runs", params={"kind": "storage"}, headers=HEADERS)
    assert response.status_code == 200
    row = ledger.get_run(response.json()["run_id"])
    assert row["status"] == "success" and row["task_key"] == "backup.storage"


def test_get_run_404(ready_client):
    assert ready_client.get("/runs/999999", headers=HEADERS).status_code == 404


def test_restore_endpoint_validates_before_executing(ready_client):
    bad = ready_client.post(
        "/restore", params={"run_id": 1, "target_db": "bad name", "confirm": "true"}, headers=HEADERS
    )
    assert bad.status_code == 400
    unconfirmed = ready_client.post("/restore", params={"run_id": 1, "target_db": "ops_scratch"}, headers=HEADERS)
    assert unconfirmed.status_code == 400
