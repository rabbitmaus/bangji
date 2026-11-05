from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

ChangeType = Literal["kept", "reordered", "rephrased", "summarized"]
Section = str


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Period(_Base):
    start: str | None = None
    end: str | None = None


class Fact(_Base):
    id: str
    category: str = "experience"
    text: str = ""
    org: str | None = None
    role: str | None = None
    period: Period | None = None
    skills: list[str] = Field(default_factory=list)
    numbers: list[str] = Field(default_factory=list)
    sourceSpan: str | None = None
    origin: str | None = None


class Requirement(_Base):
    id: str
    text: str = ""
    skills: list[str] = Field(default_factory=list)


class Posting(_Base):
    itemKey: str = ""
    title: str = ""
    company: str = ""
    url: str = ""
    excerpt: str = ""


class OriginalSentence(_Base):
    id: str
    text: str
    section: str | None = None


class Sentence(_Base):
    """Lenient sentence: used for verification, where bad shapes must yield reason codes."""

    sentenceId: str
    section: str = "summary"
    text: str
    sourceFactIds: list[str] = Field(default_factory=list)
    requirementIds: list[str] = Field(default_factory=list)
    changeType: ChangeType = "rephrased"
    originalRefs: list[str] = Field(default_factory=list)


class StrictSentence(Sentence):
    @model_validator(mode="after")
    def _check(self) -> "StrictSentence":
        if not self.sourceFactIds:
            raise ValueError("sourceFactIds must have at least one id")
        if not self.requirementIds and self.changeType != "kept":
            raise ValueError("requirementIds required unless changeType is kept")
        return self


class TailorOutput(_Base):
    sentences: list[StrictSentence]


class Verification(_Base):
    sentenceId: str
    status: Literal["verified", "unsupported"]
    reasons: list[str] = Field(default_factory=list)


class VerifyContext(_Base):
    facts: list[Fact] = Field(default_factory=list)
    requirements: list[Requirement] = Field(default_factory=list)
    companyNames: list[str] = Field(default_factory=list)


class TailoringRequest(_Base):
    tailoringId: str
    runId: str | None = None
    posting: Posting = Field(default_factory=Posting)
    requirements: list[Requirement] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    originalSentences: list[OriginalSentence] = Field(default_factory=list)
    companyNames: list[str] = Field(default_factory=list)


class Decision(_Base):
    changeId: str
    decision: Literal["accept", "reject"]


class Change(_Base):
    changeId: str
    kind: Literal["modified", "added", "removed", "reordered"]
    sentenceId: str | None = None
    originalRefs: list[str] = Field(default_factory=list)
    before: str | None = None
    after: str | None = None
    status: Literal["verified", "unsupported"] | None = None
    reasons: list[str] = Field(default_factory=list)
    requiresDecision: bool = True


class ResponsesRequest(_Base):
    decisions: list[Decision] = Field(default_factory=list)
    # optional user-edited sentences; they are re-verified before assembly
    sentences: list[Sentence] | None = None


class FinalizeRequest(TailoringRequest):
    sentences: list[Sentence]
    decisions: list[Decision] = Field(default_factory=list)


class VerifySentencesRequest(VerifyContext):
    sentences: list[Sentence]
