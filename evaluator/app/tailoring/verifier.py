"""Pure-code fact verification (TRD 6.2). No model calls."""
from __future__ import annotations

import re

from .schemas import Fact, Requirement, Sentence, Verification, VerifyContext

DEFAULT_SKILLS = [
    "Java", "JavaScript", "TypeScript", "Python", "Kotlin", "Swift", "Rust", "Golang", "PHP", "Ruby",
    "C++", "C#", "Scala", "Node.js", "Express", "NestJS", "Spring", "Spring Boot", "Django", "FastAPI",
    "Flask", "React", "Vue", "Angular", "Next.js", "Redis", "MySQL", "PostgreSQL", "MongoDB",
    "Elasticsearch", "Kafka", "RabbitMQ", "Docker", "Kubernetes", "AWS", "Azure", "GCP", "Terraform",
    "Jenkins", "GitHub Actions", "GraphQL", "gRPC", "Linux", "Git", "SQL", "NoSQL", "Oracle", "MSA",
    "CI/CD", "Spark", "Hadoop", "Airflow", "TensorFlow", "PyTorch", "Flutter", "Unity",
]
TITLES = [
    "팀장", "파트장", "리드", "매니저", "CTO", "CEO", "VP", "시니어", "수석", "책임", "선임", "주임",
    "대리", "과장", "차장", "부장", "이사", "대표", "인턴", "주니어", "아키텍트", "Tech Lead",
]
CREDENTIALS = [
    "정보처리기사", "정보처리산업기사", "정보보안기사", "빅데이터분석기사", "리눅스마스터", "SQLD", "SQLP",
    "ADsP", "CKA", "CKAD", "PMP", "TOEIC", "TOEFL", "OPIc", "AWS Certified", "석사", "박사", "학사",
    "컴퓨터공학", "전산학",
]

_UNITS = r"(?:만원|개월|천만|퍼센트|%|년|월|명|건|배|원|억|만|ms|초|분|시간|일|주|개|회|k|K)"
_DATE = re.compile(r"(?<!\d)(\d{4})\s*(?:[.\-/]|년\s*)\s*(\d{1,2})\s*(?:월)?(?!\d)")
_NUM = re.compile(rf"(?<![A-Za-z\d.])(\d[\d,]*(?:\.\d+)?)\s*({_UNITS})?")


def _norm_num(n: str) -> str:
    n = n.replace(",", "")
    if "." in n:
        n = n.rstrip("0").rstrip(".")
    return n


def number_tokens(text: str) -> set[str]:
    tokens: set[str] = set()

    def date_sub(m: re.Match) -> str:
        y, mo = m.group(1), int(m.group(2))
        if 1 <= mo <= 12:
            tokens.update({f"{y}.{mo:02d}", y, f"{mo}월"})
            return " "
        return m.group(0)

    rest = _DATE.sub(date_sub, text)
    for m in _NUM.finditer(rest):
        unit = m.group(2) or ""
        if unit == "퍼센트":
            unit = "%"
        tokens.add(_norm_num(m.group(1)) + unit)
    return tokens


def _ym(s: str | None) -> tuple[int, int] | None:
    if not s:
        return None
    m = re.match(r"\s*(\d{4})\D+(\d{1,2})", s)
    return (int(m.group(1)), int(m.group(2))) if m else None


def derived_duration_tokens(facts: list[Fact]) -> set[str]:
    """Union of fact periods (overlaps counted once) -> year/month tokens."""
    spans = []
    for f in facts:
        if f.period:
            a, b = _ym(f.period.start), _ym(f.period.end)
            if a and b:
                spans.append((a[0] * 12 + a[1] - 1, b[0] * 12 + b[1] - 1))
    if not spans:
        return set()
    spans.sort()
    total, cur_s, cur_e = 0, *spans[0]
    for s, e in spans[1:]:
        if s <= cur_e + 1:
            cur_e = max(cur_e, e)
        else:
            total += cur_e - cur_s + 1
            cur_s, cur_e = s, e
    total += cur_e - cur_s + 1
    toks = {f"{total}개월", f"{total // 12}년", f"{round(total / 12)}년"}
    return toks


def _contains(text: str, name: str) -> bool:
    if not name.strip():
        return False
    pat = r"(?<![A-Za-z0-9])" + re.escape(name) + r"(?![A-Za-z0-9])" if re.match(r"[A-Za-z0-9]", name) else re.escape(name)
    return re.search(pat, text, re.IGNORECASE) is not None


def fact_evidence_text(f: Fact) -> str:
    parts = [f.text, f.org, f.role, f.sourceSpan, *f.skills, *f.numbers]
    if f.period:
        parts += [f.period.start, f.period.end]
    return "\n".join(p for p in parts if p)


def _number_ok(tok: str, evidence: set[str]) -> bool:
    if tok in evidence:
        return True
    m = re.match(r"([\d.]+)(.*)$", tok)
    if not m:
        return False
    num, unit = m.groups()
    for e in evidence:
        em = re.match(r"([\d.]+)(.*)$", e)
        if em and em.group(1) == num and (not unit or not em.group(2)):
            return True
    return False


def verify_sentence(s: Sentence, ctx: VerifyContext) -> Verification:
    reasons: list[str] = []
    facts_by_id = {f.id: f for f in ctx.facts}
    if not s.sourceFactIds:
        reasons.append("no_source")
    linked = [facts_by_id[i] for i in s.sourceFactIds if i in facts_by_id]
    if any(i not in facts_by_id for i in s.sourceFactIds):
        reasons.append("unknown_fact")
    req_ids = {r.id for r in ctx.requirements}
    if any(r not in req_ids for r in s.requirementIds):
        reasons.append("unknown_requirement")

    if linked:
        evidence = "\n".join(fact_evidence_text(f) for f in linked)
        ev_nums = number_tokens(evidence) | derived_duration_tokens(linked)
        if any(not _number_ok(t, ev_nums) for t in number_tokens(s.text)):
            reasons.append("number_not_in_source")

        entities = {f.org for f in ctx.facts if f.org} | {c for c in ctx.companyNames if c} | set(TITLES)
        if any(_contains(s.text, e) and not _contains(evidence, e) for e in entities):
            reasons.append("entity_not_in_source")

        if any(_contains(s.text, c) and not _contains(evidence, c) for c in CREDENTIALS):
            reasons.append("credential_not_in_source")

        skills = set(DEFAULT_SKILLS)
        for f in ctx.facts:
            skills.update(f.skills)
        for r in ctx.requirements:
            skills.update(r.skills)
        if any(_contains(s.text, k) and not _contains(evidence, k) for k in skills):
            reasons.append("skill_not_in_source")

    return Verification(
        sentenceId=s.sentenceId,
        status="unsupported" if reasons else "verified",
        reasons=reasons,
    )


def verify_sentences(sentences: list[Sentence], ctx: VerifyContext) -> list[Verification]:
    return [verify_sentence(s, ctx) for s in sentences]
