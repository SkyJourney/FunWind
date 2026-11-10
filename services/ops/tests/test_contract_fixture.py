"""双端契约夹具（tests/fixtures/ops-contract.json）：管线侧判定必须与夹具一致。

web 侧 apps/web/src/lib/ops/executors.test.ts 读同一份夹具——两端都对上夹具，即两端彼此一致。
"""
import json
from pathlib import Path

import pytest

from app.executors import REGISTRY, ParamsError
from app.triggers import TriggerConfigError, parse_once, validate_cron

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "ops-contract.json").read_text(encoding="utf-8"))


def test_registered_executors_match_fixture():
    assert sorted(REGISTRY) == sorted(FIXTURE["executors"])


@pytest.mark.parametrize("case", FIXTURE["params"], ids=lambda c: f"{c['executor']}:{json.dumps(c['params'])}")
def test_params_validation_matches_fixture(case):
    spec = REGISTRY[case["executor"]]
    try:
        spec.validate(case["params"])
        valid = True
    except ParamsError:
        valid = False
    assert valid is case["valid"]


@pytest.mark.parametrize("case", FIXTURE["cron"], ids=lambda c: repr(c["expr"]))
def test_cron_validation_matches_fixture(case):
    try:
        validate_cron(case["expr"])
        valid = True
    except TriggerConfigError:
        valid = False
    assert valid is case["valid"]


@pytest.mark.parametrize("case", FIXTURE["once"], ids=lambda c: repr(c["expr"]))
def test_once_validation_matches_fixture(case):
    try:
        parse_once(case["expr"])
        valid = True
    except TriggerConfigError:
        valid = False
    assert valid is case["valid"]
