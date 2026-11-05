from datetime import datetime

from app.evaluation.gate import KST, run_rule_gate
from app.schemas import RuleCard

NOW = datetime(2026, 11, 5, 12, 0, tzinfo=KST)


def _status(card, fields, years=None):
    return run_rule_gate([card], fields, years, NOW)[0].status


def test_experience_user_range():
    card = RuleCard.model_validate({"kind": "experience", "minYears": 3, "maxYears": 5})
    assert _status(card, {"경력": "신입"}, 4) == "met"
    assert _status(card, {"경력": "신입"}, 2) == "not_met"
    assert _status(card, {"경력": "신입"}, 7) == "not_met"
    assert _status(card, {"경력": "신입"}, None) == "unknown"


def test_experience_default_unchanged():
    card = RuleCard.model_validate({"kind": "experience"})
    assert _status(card, {"경력": "3년 이상"}, 2) == "not_met"


def test_region_allow_remote_false():
    fields = {"지역": "재택근무"}
    assert _status(RuleCard.model_validate({"kind": "region", "allowed": ["서울"]}), fields) == "met"
    off = RuleCard.model_validate({"kind": "region", "allowed": ["서울"], "allowRemote": False})
    assert _status(off, fields) == "unknown"
