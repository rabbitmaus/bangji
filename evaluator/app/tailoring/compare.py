"""Comparison, decisions and assembly (TRD 6.3, 6.4)."""
from __future__ import annotations

from datetime import datetime, timezone

from .schemas import Change, Decision, OriginalSentence, Posting, Sentence, Verification

SECTION_TITLES = {
    "summary": "요약", "experience": "경력", "project": "프로젝트", "skill": "기술",
    "education": "학력", "certification": "자격증",
}
DISCLAIMER = "AI가 작성하고 사용자가 확인한 맞춤 이력서 초안"


def build_changes(
    originals: list[OriginalSentence],
    sentences: list[Sentence],
    verifications: dict[str, Verification],
) -> list[Change]:
    orig = {o.id: o for o in originals}
    changes: list[Change] = []
    referenced: set[str] = set()
    for s in sentences:
        referenced.update(s.originalRefs)
        v = verifications.get(s.sentenceId)
        status = v.status if v else None
        reasons = v.reasons if v else []
        before = "\n".join(orig[r].text for r in s.originalRefs if r in orig) or None
        if not s.originalRefs:
            changes.append(Change(changeId=f"C-{s.sentenceId}", kind="added", sentenceId=s.sentenceId,
                                  after=s.text, status=status, reasons=reasons))
        elif s.changeType == "reordered":
            changes.append(Change(changeId=f"C-{s.sentenceId}", kind="reordered", sentenceId=s.sentenceId,
                                  originalRefs=s.originalRefs, before=before, after=s.text,
                                  status=status, reasons=reasons, requiresDecision=False))
        elif s.changeType != "kept" and (before or "").strip() != s.text.strip():
            changes.append(Change(changeId=f"C-{s.sentenceId}", kind="modified", sentenceId=s.sentenceId,
                                  originalRefs=s.originalRefs, before=before, after=s.text,
                                  status=status, reasons=reasons))
    for o in originals:
        if o.id not in referenced:
            changes.append(Change(changeId=f"C-{o.id}", kind="removed", originalRefs=[o.id], before=o.text))
    return changes


def _sort_key(ref: str) -> int:
    digits = "".join(c for c in ref if c.isdigit())
    return int(digits) if digits else 0


def assemble_items(
    originals: list[OriginalSentence],
    sentences: list[Sentence],
    verifications: dict[str, Verification],
    decisions: list[Decision],
) -> list[tuple[str, str]]:
    """Return (section, text) pairs. Undecided changes count as rejected."""
    accepted = {d.changeId for d in decisions if d.decision == "accept"}
    orig = {o.id: o for o in originals}
    changes = {c.changeId: c for c in build_changes(originals, sentences, verifications)}
    # entries: (min original index or None, section, text)
    out: list[tuple[int | None, str, str]] = []
    used_originals: set[str] = set()

    def idx(refs: list[str]) -> int | None:
        return min((_sort_key(r) for r in refs), default=None) if refs else None

    for s in sentences:
        v = verifications.get(s.sentenceId)
        verified = v is not None and v.status == "verified"
        cid = f"C-{s.sentenceId}"
        ch = changes.get(cid)
        if ch is None:  # kept
            refs = [r for r in s.originalRefs if r in orig]
            if refs:
                for r in refs:
                    if r not in used_originals:
                        used_originals.add(r)
                        out.append((_sort_key(r), orig[r].section or s.section, orig[r].text))
            elif verified:
                out.append((None, s.section, s.text))
            continue
        if ch.kind == "reordered":
            if verified:
                out.append((idx(s.originalRefs), s.section, s.text))
            else:
                for r in s.originalRefs:
                    if r in orig and r not in used_originals:
                        used_originals.add(r)
                        out.append((_sort_key(r), orig[r].section or s.section, orig[r].text))
            continue
        if cid in accepted and verified:
            used_originals.update(s.originalRefs)
            out.append((idx(s.originalRefs), s.section, s.text))
        elif ch.kind == "modified":
            for r in s.originalRefs:
                if r in orig and r not in used_originals:
                    used_originals.add(r)
                    out.append((_sort_key(r), orig[r].section or s.section, orig[r].text))
    for o in originals:
        cid = f"C-{o.id}"
        if cid in changes and changes[cid].kind == "removed" and cid not in accepted and o.id not in used_originals:
            used_originals.add(o.id)
            pos = _sort_key(o.id)
            at = next((i for i, e in enumerate(out) if e[0] is not None and e[0] > pos), len(out))
            out.insert(at, (pos, o.section or "experience", o.text))
    return [(sec, text) for _, sec, text in out]


def render_markdown(posting: Posting, items: list[tuple[str, str]], now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    lines = [f"# 맞춤 이력서 — {posting.title or '공고'}", ""]
    lines.append(f"- 회사: {posting.company}")
    if posting.url:
        lines.append(f"- 공고 URL: {posting.url}")
    lines.append(f"- 생성 시각: {now.strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append(f"- {DISCLAIMER}")
    lines.append("")
    order: list[str] = []
    for sec, _ in items:
        if sec not in order:
            order.append(sec)
    for sec in order:
        lines.append(f"## {SECTION_TITLES.get(sec, sec)}")
        lines.extend(f"- {t}" for s, t in items if s == sec)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
