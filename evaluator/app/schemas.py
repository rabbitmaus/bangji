"""Pydantic models for the evaluator's request, response and agent outputs (TRD 4, 8.2, 8.3)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Status = Literal["met", "not_met", "unknown"]
Decision = Literal["pass", "reject", "hold"]
RuleKind = Literal["deadline", "experience", "region", "employment"]

HOLD_REASONS = (
    "unknown", "quote_mismatch", "disagreement", "schema_failure", "input_truncated",
    "detail_missing", "injection_suspected", "review_hold", "timeout", "limit_reached",
)


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


# ---------- request ----------
class RuleCard(CamelModel):
    id: str | None = None
    kind: RuleKind
    required: bool = True
    # region/employment: allowed values. Ignored for deadline/experience.
    allowed: list[str] = Field(default_factory=list)
    # experience: user range in years (None = unspecified). region: allow_remote=False disables remote auto-pass.
    min_years: float | None = None
    max_years: float | None = None
    allow_remote: bool | None = None


class SemanticCard(CamelModel):
    id: str
    text: str
    required: bool = True


class Conditions(CamelModel):
    rules: list[RuleCard] = Field(default_factory=list)
    semantic: list[SemanticCard] = Field(default_factory=list)
    # The default criterion "the resume facts satisfy the posting's required qualifications".
    default_qualification_required: bool = True


class Fact(CamelModel):
    id: str
    text: str


class PostingItem(CamelModel):
    item_key: str
    fields: dict[str, str] = Field(default_factory=dict)
    excerpt: str = ""
    excerpt_sha256: str | None = None
    truncated: bool = False
    detail_missing: bool = False
    injection_suspected: bool = False
    url: str | None = None


class Limits(CamelModel):
    model_calls: int = 40
    run_seconds: int = 180
    item_seconds: int = 90
    agent_seconds: int = 60
    concurrency: int = 3


class EvaluationRequest(CamelModel):
    run_id: str
    items: list[PostingItem]
    conditions: Conditions = Field(default_factory=Conditions)
    facts: list[Fact] = Field(default_factory=list)
    experience_years: float | None = None
    limits: Limits = Field(default_factory=Limits)


# ---------- agent outputs (4.2) ----------
class Requirement(CamelModel):
    id: str  # R1, R2, ...
    text: str
    quote: str = ""
    status: Status
    fact_ids: list[str] = Field(default_factory=list)
    # Set when the requirement is about deadline/experience/region/employment (used for disagreement checks).
    relates_to: RuleKind | None = None


class QualificationResult(CamelModel):
    requirements: list[Requirement] = Field(default_factory=list)
    injection_suspected: bool = False


class FitCriterionResult(CamelModel):
    id: str  # semantic card id
    status: Status
    quote: str = ""
    fact_ids: list[str] = Field(default_factory=list)


class FitResult(CamelModel):
    criteria: list[FitCriterionResult] = Field(default_factory=list)
    injection_suspected: bool = False


class ReviewResult(CamelModel):
    proposed: Literal["keep", "hold"] = "keep"
    reason: str = ""


# ---------- internal / response ----------
class Criterion(CamelModel):
    id: str
    label: str
    required: bool = True
    status: Status = "unknown"
    verified: bool = False
    source: Literal["rule", "ai"] = "rule"
    quote: str = ""
    quote_verified: bool = False
    fact_ids: list[str] = Field(default_factory=list)
    hold_reasons: list[str] = Field(default_factory=list)
    relates_to: RuleKind | None = None


class VerdictFinal(CamelModel):
    item_key: str
    decision: Decision
    source: Literal["rule", "ai", "review"]
    criteria: list[Criterion]
    hold_reasons: list[str]
    injection_suspected: bool = False
    excerpt_sha256: str
    excerpt_sha256_matches: bool = True
