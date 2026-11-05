"""Rule gate parsing (TRD 4.5). Dates use Asia/Seoul."""
from __future__ import annotations

import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

from ..schemas import Criterion, RuleCard, RuleKind, Status

KST = ZoneInfo("Asia/Seoul")

FIELD_KEYS: dict[str, tuple[str, ...]] = {
    "deadline": ("deadline", "마감일", "마감", "접수마감"),
    "experience": ("experience", "경력", "경력연수", "경력 연수"),
    "region": ("region", "location", "지역", "근무지", "근무지역"),
    "employment": ("employment", "employmentType", "고용형태", "채용형태"),
}
LABELS: dict[str, str] = {
    "deadline": "마감일", "experience": "경력 연수", "region": "지역", "employment": "고용형태",
}

PROVINCES = {
    "서울": "서울", "경기": "경기", "인천": "인천", "부산": "부산", "대구": "대구", "광주": "광주",
    "대전": "대전", "울산": "울산", "세종": "세종", "강원": "강원", "충북": "충북", "충남": "충남",
    "전북": "전북", "전남": "전남", "경북": "경북", "경남": "경남", "제주": "제주",
}
CITY_TO_PROVINCE = {
    "판교": "경기", "성남": "경기", "수원": "경기", "용인": "경기", "고양": "경기", "안양": "경기",
    "부천": "경기", "화성": "경기", "평택": "경기", "하남": "경기", "분당": "경기", "일산": "경기",
    "강남": "서울", "역삼": "서울", "삼성": "서울", "여의도": "서울", "마포": "서울", "성수": "서울",
    "송파": "서울", "구로": "서울", "가산": "서울", "종로": "서울", "서초": "서울",
    "송도": "인천", "해운대": "부산", "청주": "충북", "천안": "충남", "아산": "충남",
    "전주": "전북", "포항": "경북", "구미": "경북", "창원": "경남", "김해": "경남", "춘천": "강원",
    "원주": "강원", "강릉": "강원",
}
PROVINCE_ALIASES = {
    "서울특별시": "서울", "경기도": "경기", "인천광역시": "인천", "부산광역시": "부산", "대구광역시": "대구",
    "광주광역시": "광주", "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종",
    "강원도": "강원", "강원특별자치도": "강원", "충청북도": "충북", "충청남도": "충남",
    "전라북도": "전북", "전북특별자치도": "전북", "전라남도": "전남", "경상북도": "경북",
    "경상남도": "경남", "제주특별자치도": "제주", "제주도": "제주",
}
REMOTE_WORDS = ("원격", "재택", "리모트", "remote")
EMPLOYMENT_TYPES = ("정규직", "계약직", "인턴", "프리랜서")


def get_field(fields: dict[str, str], kind: str) -> str:
    lowered = {k.strip().lower(): v for k, v in fields.items()}
    for key in FIELD_KEYS[kind]:
        v = lowered.get(key.lower())
        if v and v.strip():
            return v.strip()
    return ""


def now_kst() -> datetime:
    return datetime.now(KST)


def parse_deadline(value: str, now: datetime) -> Status:
    v = value.strip()
    if not v:
        return "unknown"
    today = now.astimezone(KST).date()
    if "상시" in v or "채용 시 마감" in v or "채용시 마감" in v:
        return "met"
    if re.search(r"(?<![A-Za-z])D\s*-\s*(\d+|day)", v, re.I):
        return "met"  # D-n means the deadline has not passed
    d: date | None = None
    m = re.search(r"(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})", v)
    try:
        if m:
            d = date(int(m[1]), int(m[2]), int(m[3]))
        else:
            m = re.search(r"(?<!\d)(\d{1,2})\s*[/.]\s*(\d{1,2})(?!\d)", v) or re.search(
                r"(\d{1,2})\s*월\s*(\d{1,2})\s*일", v)
            if m:
                d = date(today.year, int(m[1]), int(m[2]))
    except ValueError:
        return "unknown"
    if d is None:
        return "unknown"
    return "met" if d >= today else "not_met"


def parse_experience_min(value: str) -> int | None:
    v = value.strip()
    if not v:
        return None
    if "무관" in v or "신입" in v:
        return 0
    m = re.search(r"(\d+)\s*[~\-–]\s*(\d+)\s*년", v) or re.search(r"(\d+)\s*년", v)
    return int(m[1]) if m else None


def eval_experience(value: str, my_years: float | None) -> Status:
    minimum = parse_experience_min(value)
    if minimum is None or my_years is None:
        return "unknown"
    return "met" if my_years >= minimum else "not_met"


def eval_experience_range(value: str, my_years: float | None, min_years: float | None,
                          max_years: float | None) -> Status:
    if min_years is None and max_years is None:
        return eval_experience(value, my_years)
    if my_years is None:
        return "unknown"
    if min_years is not None and my_years < min_years:
        return "not_met"
    if max_years is not None and my_years > max_years:
        return "not_met"
    return "met"


def _province(token: str) -> str | None:
    t = token.strip()
    if t in PROVINCE_ALIASES:
        return PROVINCE_ALIASES[t]
    for name, prov in CITY_TO_PROVINCE.items():
        if name in t:
            return prov
    for name, prov in PROVINCES.items():
        if t.startswith(name) or name in t:
            return prov
    return None


def regions_in(value: str) -> set[str]:
    found: set[str] = set()
    for alias, prov in PROVINCE_ALIASES.items():
        if alias in value:
            found.add(prov)
    for name, prov in CITY_TO_PROVINCE.items():
        if name in value:
            found.add(prov)
    for name, prov in PROVINCES.items():
        if name in value:
            found.add(prov)
    return found


def eval_region(value: str, allowed: list[str], allow_remote: bool = True) -> Status:
    v = value.strip()
    if not v:
        return "unknown"
    if allow_remote and any(w in v.lower() for w in REMOTE_WORDS):
        return "met"
    found = regions_in(v)
    if not found:
        return "unknown"
    allowed_set = {p for a in allowed if (p := _province(a))}
    return "met" if found & allowed_set else "not_met"


def eval_employment(value: str, allowed: list[str]) -> Status:
    found = {t for t in EMPLOYMENT_TYPES if t in value}
    if not found:
        return "unknown"
    return "met" if found & {t for t in EMPLOYMENT_TYPES if any(t in a for a in allowed)} else "not_met"


def evaluate_rule(card: RuleCard, fields: dict[str, str], my_years: float | None, now: datetime) -> Criterion:
    kind: RuleKind = card.kind
    value = get_field(fields, kind)
    if kind == "deadline":
        status = parse_deadline(value, now)
    elif kind == "experience":
        status = eval_experience_range(value, my_years, card.min_years, card.max_years)
    elif kind == "region":
        status = eval_region(value, card.allowed, card.allow_remote is not False)
    else:
        status = eval_employment(value, card.allowed)
    return Criterion(
        id=card.id or f"rule:{kind}", label=LABELS[kind], required=card.required, status=status,
        verified=status in ("met", "not_met"), source="rule", quote=value, quote_verified=bool(value),
        relates_to=kind, hold_reasons=["unknown"] if status == "unknown" else [],
    )


def run_rule_gate(cards: list[RuleCard], fields: dict[str, str], my_years: float | None,
                  now: datetime | None = None) -> list[Criterion]:
    now = now or now_kst()
    return [evaluate_rule(c, fields, my_years, now) for c in cards]
