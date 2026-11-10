"""节日装扮执行器与 SSR 内部接口的编排（真台账 + mock SSR HTTP）：本地跑，无需网络。"""
import email.message
import io
import json

import pytest

from app import config, holiday, ledger
from app.executors import REGISTRY

pytestmark = pytest.mark.db


class FakeSSR:
    """urllib 打桩：记录请求，按脚本回放响应。"""

    def __init__(self, monkeypatch):
        self.requests: list[dict] = []
        self.responses: list[dict] = []  # 逐请求弹出；{"status":…, "body":…}
        self.fail_network = False
        self._orig = holiday.urllib.request.urlopen
        monkeypatch.setattr(holiday.urllib.request, "urlopen", self._open)

    def _open(self, request, timeout=0):
        body = json.loads(request.data.decode("utf-8"))
        self.requests.append(
            {
                "url": request.full_url,
                "token": request.headers.get("X-ops-token") or request.headers.get("x-ops-token"),
                "body": body,
            }
        )
        if self.fail_network:
            raise OSError("ECONNREFUSED")
        script = self.responses.pop(0)
        payload = json.dumps(script["body"]).encode("utf-8")
        if script["status"] >= 400:
            # HTTPError 的 fp 必须带 Content-Length 头（本机 Python 3.13 实测：裸 fp 的 read() 返回空）
            hdrs = email.message.Message()
            hdrs["Content-Length"] = str(len(payload))
            raise holiday.urllib.error.HTTPError(
                request.full_url, script["status"], "error", hdrs, io.BytesIO(payload)
            ) from None

        return io.BytesIO(payload)


@pytest.fixture
def fake_ssr(monkeypatch):
    fake = FakeSSR(monkeypatch)
    yield fake


RULE = {
    "calendar": "lunar",
    "month": 1,
    "day": 1,
    "beforeDays": 0,
    "durationDays": 7,
    "items": [
        {"effect": "theme.pack", "target": "qy2010"},
        {"effect": "site.logo", "target": "logo-abcd1234.png"},
    ],
}


def test_executor_creates_rows_for_both_items_and_records_window(db_conn, fake_ssr):
    ledger.ensure_schema(db_conn)
    fake_ssr.responses = [
        {"status": 200, "body": {"ok": True, "id": 101}},
        {"status": 200, "body": {"ok": True, "id": 102}},
    ]
    spec = REGISTRY["campaign.holiday"]
    outcome = spec.run(RULE, trigger="manual", task_key="campaign.holiday", run_id=None, task_name="节日装扮")

    assert outcome["created"] == 2
    assert len(fake_ssr.requests) == 2
    first = fake_ssr.requests[0]
    assert first["url"].endswith("/api/internal/campaigns/holiday")
    assert first["token"] == config.OPS_TOKEN
    assert first["body"]["name"] == "节日装扮·2027年"  # 测试当日（2026 下半年）→ 目标年 2027
    assert first["body"]["effect"] == "theme.pack"

    run = ledger.get_run(outcome["run_id"])
    assert run["kind"] == "holiday" and run["status"] == "success"
    assert "已生成（campaign id=101）" in run["detail"]
    assert "已存在" not in run["detail"]


def test_existing_campaigns_are_reported_but_not_resent(db_conn, fake_ssr):
    ledger.ensure_schema(db_conn)
    fake_ssr.responses = [{"status": 200, "body": {"ok": True, "existing": True, "id": 7}}]
    outcome = REGISTRY["campaign.holiday"].run(
        {"calendar": "lunar", "month": 1, "day": 1, "items": [{"effect": "theme.pack", "target": "qy2010"}]},
        trigger="cron",
        task_key="campaign.holiday",
        run_id=None,
        task_name="节日装扮",
    )
    assert outcome["existing"] == 1 and outcome["created"] == 0
    assert "已存在（campaign id=7）" in ledger.get_run(outcome["run_id"])["detail"]


def test_ssr_rejection_records_failure_with_server_reason(db_conn, fake_ssr):
    ledger.ensure_schema(db_conn)
    fake_ssr.responses = [{"status": 422, "body": {"error": "装扮目标不存在：qy2010（未导入或已停用）"}}]
    with pytest.raises(RuntimeError, match="装扮目标不存在"):
        REGISTRY["campaign.holiday"].run(RULE, trigger="manual", task_key="campaign.holiday", run_id=None, task_name="节日装扮")
    run = ledger.list_runs(1)[0]
    assert run["status"] == "failed" and "装扮目标不存在" in run["error"]


def test_ssr_unreachable_records_failure(db_conn, fake_ssr):
    ledger.ensure_schema(db_conn)
    fake_ssr.fail_network = True
    with pytest.raises(RuntimeError, match="SSR 不可达"):
        REGISTRY["campaign.holiday"].run(
            {k: v for k, v in RULE.items() if k != "beforeDays"} | {"items": RULE["items"][:1]},
            trigger="manual",
            task_key="campaign.holiday",
            run_id=None,
            task_name="节日装扮",
        )
    assert ledger.list_runs(1)[0]["status"] == "failed"


def test_bad_rule_is_rejected_before_any_ledger_or_http(db_conn, fake_ssr):
    ledger.ensure_schema(db_conn)
    with pytest.raises(Exception, match="durationDays"):
        REGISTRY["campaign.holiday"].validate({**RULE, "durationDays": 0})
    with pytest.raises(Exception, match="durationDays"):
        REGISTRY["campaign.holiday"].run({**RULE, "durationDays": 0}, trigger="manual", task_key="campaign.holiday", run_id=None, task_name="节日装扮")
    assert ledger.list_runs(1) == []
    assert fake_ssr.requests == []
