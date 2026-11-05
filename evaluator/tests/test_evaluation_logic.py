from datetime import datetime

from app.evaluation.aggregate import aggregate, apply_review, mark_disagreements
from app.evaluation.gate import (KST, eval_employment, eval_experience, eval_region, parse_deadline)
from app.evaluation.text import sha256_hex, verify_quote
from app.schemas import Criterion

NOW = datetime(2026, 11, 5, 12, 0, tzinfo=KST)


def test_deadline():
    assert parse_deadline("2026.11.20", NOW) == "met"
    assert parse_deadline("2026-11-04", NOW) == "not_met"
    assert parse_deadline("11/20(목)", NOW) == "met"
    assert parse_deadline("D-3", NOW) == "met"
    assert parse_deadline("상시", NOW) == "met"
    assert parse_deadline("", NOW) == "unknown"
    assert parse_deadline("곧 마감", NOW) == "unknown"


def test_experience():
    assert eval_experience("3~5년", 7) == "met"
    assert eval_experience("3년 이상", 2) == "not_met"
    assert eval_experience("경력 무관", 0) == "met"
    assert eval_experience("신입", 1) == "met"
    assert eval_experience("협의", 3) == "unknown"
    assert eval_experience("3년 이상", None) == "unknown"


def test_region_and_employment():
    assert eval_region("판교", ["경기"]) == "met"
    assert eval_region("서울 강남", ["경기"]) == "not_met"
    assert eval_region("재택근무", ["경기"]) == "met"
    assert eval_region("", ["경기"]) == "unknown"
    assert eval_employment("정규직", ["정규직", "계약직"]) == "met"
    assert eval_employment("인턴", ["정규직"]) == "not_met"
    assert eval_employment("", ["정규직"]) == "unknown"


def c(status, verified=True, required=True, **kw):
    return Criterion(id=kw.pop("id", "x"), label="l", status=status, verified=verified, required=required, **kw)


def test_aggregate():
    assert aggregate([c("met")], True, []) == ("hold", ["injection_suspected"])
    assert aggregate([c("met"), c("not_met", id="y")], False, [])[0] == "reject"
    assert aggregate([c("met")], False, [])[0] == "pass"
    assert aggregate([c("met")], False, ["input_truncated"]) == ("hold", ["input_truncated"])
    assert aggregate([c("not_met", verified=False, hold_reasons=["quote_mismatch"])], False, [])[0] == "hold"
    assert aggregate([c("met", required=False)], False, [])[0] == "hold"
    assert aggregate([], False, [])[0] == "hold"


def test_review_only_conservative():
    assert apply_review("pass", "hold") == ("hold", ["review_hold"])
    assert apply_review("reject", "hold") == ("hold", ["review_hold"])
    assert apply_review("hold", "pass") == ("hold", [])
    assert apply_review("pass", "reject") == ("pass", [])


def test_disagreement():
    rule = c("met", source="rule", relates_to="experience")
    ai = c("not_met", source="ai", relates_to="experience", id="a")
    mark_disagreements([rule, ai])
    assert not rule.verified and not ai.verified
    assert aggregate([rule, ai], False, [])[0] == "hold"


def test_quote_verification():
    ex = "자격 요건\n- Python 3년 이상 경험\u00a0 필수  “API”"
    assert verify_quote("Python 3년  이상 경험", ex)
    assert verify_quote('필수 "API"', ex)
    assert not verify_quote("Java 경험", ex)
    assert not verify_quote("필수", ex)  # shorter than 4 chars
    assert len(sha256_hex(ex)) == 64
