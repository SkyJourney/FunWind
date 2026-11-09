"""API 鉴权（C3 常量时间比较）与降级语义（F23：/health 如实 503，不崩溃）。

这里不启动 lifespan：运行时停留在「未引导」，正好用来验证降级下的对外行为。
"""
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from conftest import TEST_TOKEN

client = TestClient(app)


@pytest.mark.parametrize("headers", [{}, {"x-ops-token": "wrong"}, {"x-ops-token": TEST_TOKEN + "x"}])
def test_management_api_rejects_bad_token(headers):
    assert client.get("/tasks", headers=headers).status_code == 401
    assert client.post("/tasks/backup.db/runs", headers=headers).status_code == 401
    assert client.post("/config/reload", headers=headers).status_code == 401


def test_empty_configured_token_rejects_everything(monkeypatch):
    monkeypatch.setattr(config, "OPS_TOKEN", "")
    assert client.get("/tasks", headers={"x-ops-token": ""}).status_code == 401


def test_valid_token_reaches_handler_but_degraded_runtime_answers_503():
    response = client.get("/tasks", headers={"x-ops-token": TEST_TOKEN})
    assert response.status_code == 503
    assert "服务降级" in response.json()["detail"]
    assert client.post("/tasks/backup.db/runs", headers={"x-ops-token": TEST_TOKEN}).status_code == 503


def test_health_reports_degraded_with_503_and_keeps_web_contract():
    """web 侧只解析 JSON 里的 ok 与 scheduler_jobs（字符串数组），降级时两者都必须在。"""
    response = client.get("/health")
    assert response.status_code == 503
    body = response.json()
    assert body["ok"] is False
    assert body["scheduler_jobs"] == []


def test_restore_validates_target_db_before_anything_else():
    headers = {"x-ops-token": TEST_TOKEN}
    bad = client.post("/restore", params={"run_id": 1, "target_db": "a;b", "confirm": "true"}, headers=headers)
    assert bad.status_code == 400
    assert "字母、数字、下划线" in bad.json()["detail"]
    unconfirmed = client.post("/restore", params={"run_id": 1, "target_db": "qingyisub"}, headers=headers)
    assert unconfirmed.status_code == 400


def test_legacy_runs_endpoint_rejects_unknown_kind():
    response = client.post("/runs", params={"kind": "logs"}, headers={"x-ops-token": TEST_TOKEN})
    assert response.status_code == 400
