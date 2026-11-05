"""Deterministic fake model (BANGJI_FAKE_MODEL=1): keyword matching against the excerpt."""
from __future__ import annotations

import re

from ..schemas import (Fact, FitCriterionResult, FitResult, QualificationResult, Requirement, SemanticCard)

INJECTION = re.compile(
    r"(무조건|통과시키|ignore (all |previous )|disregard|system prompt|시스템 지시|이전 지시|이력서에 없는|"
    r"합격 처리|pass this)", re.I)
REQ_HEADER = re.compile(r"자격\s*요건|필수|지원\s*자격|requirements?|qualifications?", re.I)
OTHER_HEADER = re.compile(r"우대|주요\s*업무|담당\s*업무|근무\s*조건|복리|혜택|전형|responsibilit|preferred", re.I)
INLINE_REQ = re.compile(r"^(필수|자격\s*요건|지원\s*자격)\s*[:：]\s*(.+)$")
OTHER_DOMAIN = re.compile(r"ios|swift|android|kotlin|디자이너|마케팅|영업|회계|인사", re.I)
STOP = {"있는", "있음", "경험", "이상", "가능", "및", "대한", "관련", "능숙", "필수", "자격", "요건", "the", "and", "with"}


def tokens(text: str) -> set[str]:
    return {t.lower() for t in re.findall(r"[0-9A-Za-z가-힣#+.]{2,}", text)} - STOP


def lines_of(excerpt: str) -> list[str]:
    return [l.strip() for l in excerpt.splitlines() if l.strip()]


def _bullet(line: str) -> str:
    return re.sub(r"^[\-\*•·▪●○\d.\)\s]+", "", line).strip()


def requirement_lines(excerpt: str) -> list[str]:
    out: list[str] = []
    in_section = False
    for line in lines_of(excerpt):
        inline = INLINE_REQ.match(line)
        if inline:
            in_section = False
            out.extend(p.strip() for p in re.split(r"[,，]", inline.group(2)) if len(p.strip()) >= 4)
            continue
        if OTHER_HEADER.match(line) and re.match(r"^[^:：]{1,12}[:：]", line):
            in_section = False
            continue
        if OTHER_HEADER.search(line) and len(line) <= 30:
            in_section = False
            continue
        if REQ_HEADER.search(line) and len(line) <= 30:
            in_section = True
            continue
        if in_section and len(_bullet(line)) >= 4:
            out.append(_bullet(line))
    return out[:6]


def _matching_facts(line: str, facts: list[Fact]) -> list[str]:
    lt = tokens(line)
    return [f.id for f in facts if lt & tokens(f.text)]


def qualification(excerpt: str, facts: list[Fact]) -> QualificationResult:
    reqs = []
    for i, line in enumerate(requirement_lines(excerpt), 1):
        ids = _matching_facts(line, facts)
        reqs.append(Requirement(id=f"R{i}", text=line[:120], quote=line, status="met" if ids else "unknown",
                                fact_ids=ids[:3]))
    return QualificationResult(requirements=reqs, injection_suspected=bool(INJECTION.search(excerpt)))


def fit(excerpt: str, facts: list[Fact], cards: list[SemanticCard]) -> FitResult:
    results = []
    for card in cards:
        ct = tokens(card.text)
        line = next((l for l in lines_of(excerpt) if ct & tokens(l)), "")
        ids = [f.id for f in facts if ct & tokens(f.text)]
        if line and ids and len(line.replace(" ", "")) >= 4:
            results.append(FitCriterionResult(id=card.id, status="met", quote=line, fact_ids=ids[:3]))
        elif ct and not (ct & tokens(excerpt)) and OTHER_DOMAIN.search(excerpt) and lines_of(excerpt):
            # 공고에 기준 키워드가 없고 다른 직군 표지가 있으면 위반으로 본다. 첫 줄을 근거로 인용한다.
            results.append(FitCriterionResult(id=card.id, status="not_met", quote=lines_of(excerpt)[0]))
        else:
            results.append(FitCriterionResult(id=card.id, status="unknown"))
    return FitResult(criteria=results, injection_suspected=bool(INJECTION.search(excerpt)))
