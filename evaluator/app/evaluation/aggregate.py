"""Aggregation (TRD 4.3) and conservative review application."""
from __future__ import annotations

from ..schemas import (Criterion, FitResult, QualificationResult, ReviewResult, SemanticCard, Fact)
from .text import verify_quote

ALLOWED_REVIEW = {("pass", "hold"), ("reject", "hold")}


def _dedupe(seq):
    return list(dict.fromkeys(seq))


def criterion_reasons(c: Criterion) -> list[str]:
    if c.verified and c.status == "met":
        return []
    reasons = list(c.hold_reasons)
    if not reasons:
        reasons.append("unknown" if c.status == "unknown" else "quote_mismatch")
    return reasons


def aggregate(criteria: list[Criterion], injection_suspected: bool, hold_reasons: list[str]):
    """Returns (verdict, hold_reasons)."""
    if injection_suspected:
        return "hold", ["injection_suspected"]
    required = [c for c in criteria if c.required]
    if any(c.status == "not_met" and c.verified for c in required):
        return "reject", []
    if required and all(c.status == "met" and c.verified for c in required) and not hold_reasons:
        return "pass", []
    reasons = list(hold_reasons)
    if not required:
        reasons.append("unknown")
    for c in required:
        reasons.extend(criterion_reasons(c))
    return "hold", _dedupe(reasons) or ["unknown"]


def apply_review(verdict: str, proposed: str | None):
    if proposed and (verdict, proposed) in ALLOWED_REVIEW:
        return proposed, ["review_hold"]
    return verdict, []


def mark_disagreements(criteria: list[Criterion]) -> None:
    """Rule gate vs AI judgments of the same criterion kind that differ are unverified."""
    rules = [c for c in criteria if c.source == "rule" and c.relates_to]
    for ai in (c for c in criteria if c.source == "ai" and c.relates_to):
        for r in rules:
            if r.relates_to == ai.relates_to and "unknown" not in (r.status, ai.status) and r.status != ai.status:
                for c in (r, ai):
                    c.verified = False
                    if "disagreement" not in c.hold_reasons:
                        c.hold_reasons.append("disagreement")


def _check(status: str, quote: str, fact_ids: list[str], excerpt: str, known_facts: set[str]):
    """Returns (verified, quote_verified, reasons)."""
    if status == "unknown":
        return False, False, ["unknown"]
    qv = verify_quote(quote, excerpt)
    reasons: list[str] = []
    if not qv:
        reasons.append("quote_mismatch")
    if status == "met" and (not fact_ids or any(f not in known_facts for f in fact_ids)):
        reasons.append("unknown")
    return not reasons, qv, reasons


def qualification_to_criteria(res: QualificationResult | None, excerpt: str, facts: list[Fact],
                              required: bool) -> list[Criterion]:
    known = {f.id for f in facts}
    if res is None:
        return [Criterion(id="qual:default", label="필수 자격 요건", required=required, source="ai",
                          hold_reasons=["schema_failure"])]
    out = []
    for r in res.requirements:
        ok, qv, reasons = _check(r.status, r.quote, r.fact_ids, excerpt, known)
        out.append(Criterion(id=f"qual:{r.id}", label=r.text, required=required, status=r.status, verified=ok,
                             source="ai", quote=r.quote, quote_verified=qv, fact_ids=r.fact_ids,
                             hold_reasons=reasons, relates_to=r.relates_to))
    if not out:
        out.append(Criterion(id="qual:default", label="필수 자격 요건", required=required, source="ai",
                             hold_reasons=["unknown"]))
    return out


def fit_to_criteria(res: FitResult | None, cards: list[SemanticCard], excerpt: str,
                    facts: list[Fact]) -> list[Criterion]:
    known = {f.id for f in facts}
    by_id = {r.id: r for r in (res.criteria if res else [])}
    out = []
    for card in cards:
        r = by_id.get(card.id)
        if r is None:
            out.append(Criterion(id=f"sem:{card.id}", label=card.text, required=card.required, source="ai",
                                 hold_reasons=["schema_failure" if res is None else "unknown"]))
            continue
        ok, qv, reasons = _check(r.status, r.quote, r.fact_ids, excerpt, known)
        out.append(Criterion(id=f"sem:{card.id}", label=card.text, required=card.required, status=r.status,
                             verified=ok, source="ai", quote=r.quote, quote_verified=qv, fact_ids=r.fact_ids,
                             hold_reasons=reasons))
    return out


def review_proposal(res: ReviewResult | None) -> str | None:
    return res.proposed if res and res.proposed == "hold" else None
