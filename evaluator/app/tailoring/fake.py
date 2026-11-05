"""Deterministic drafting for BANGJI_FAKE_MODEL=1: only reuses verified fact text."""
from __future__ import annotations

from .schemas import Sentence, TailoringRequest, TailorOutput


def fake_tailor(req: TailoringRequest) -> TailorOutput:
    out: list[Sentence] = []
    n = 0
    for f in req.facts:
        fskills = {k.lower() for k in f.skills}
        reqs = [
            r.id for r in req.requirements
            if fskills & {k.lower() for k in r.skills} or any(k.lower() in r.text.lower() for k in f.skills)
        ]
        refs = [
            o.id for o in req.originalSentences
            if (f.sourceSpan and f.sourceSpan in o.text) or (f.text and f.text in o.text) or (f.text and o.text in f.text)
        ]
        if not reqs and not refs:
            continue
        n += 1
        section = f.category if f.category in ("summary", "experience", "project", "skill", "education", "certification") else "experience"
        if reqs:
            out.append(Sentence(sentenceId=f"S{n}", section=section, text=f.text, sourceFactIds=[f.id],
                                requirementIds=reqs, changeType="rephrased", originalRefs=refs))
        else:
            orig = next(o for o in req.originalSentences if o.id == refs[0])
            out.append(Sentence(sentenceId=f"S{n}", section=section, text=orig.text, sourceFactIds=[f.id],
                                requirementIds=[], changeType="kept", originalRefs=refs[:1]))
    return TailorOutput.model_construct(sentences=out)
