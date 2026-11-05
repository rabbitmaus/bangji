from app.tailoring.compare import assemble_items, build_changes
from app.tailoring.schemas import (
    Decision, Fact, OriginalSentence, Period, Requirement, Sentence, VerifyContext,
)
from app.tailoring.verifier import verify_sentence, verify_sentences

F1 = Fact(id="F1", text="가상회사A에서 백엔드 개발자로 2022.03~2025.02 근무", org="가상회사A",
          role="백엔드 개발자", period=Period(start="2022-03", end="2025-02"), skills=["Node.js"])
F2 = Fact(id="F2", text="주문 API 응답 시간을 40% 줄임", org="가상회사A", skills=["Node.js", "Redis"], numbers=["40%"])
CTX = VerifyContext(facts=[F1, F2], requirements=[Requirement(id="R1", text="Kubernetes 경험", skills=["Kubernetes"])])


def s(text, facts=("F2",), reqs=("R1",), **kw):
    return Sentence(sentenceId=kw.pop("sid", "S1"), text=text, sourceFactIds=list(facts), requirementIds=list(reqs), **kw)


def reasons(sent):
    return verify_sentence(sent, CTX).reasons


def test_verified():
    assert verify_sentence(s("Redis로 주문 API 응답 시간을 40% 줄였습니다."), CTX).status == "verified"


def test_numbers_and_derived_duration():
    assert "number_not_in_source" in reasons(s("응답 시간을 60% 줄였습니다."))
    assert reasons(s("Node.js 경력 3년", facts=("F1",))) == []
    assert "number_not_in_source" in reasons(s("경력 7년", facts=("F1",)))
    assert reasons(s("2022년 3월부터 근무", facts=("F1",))) == []


def test_requirement_skill_not_claimed():
    assert "skill_not_in_source" in reasons(s("Kubernetes 운영 경험"))


def test_entity_credential_title_and_ids():
    assert "entity_not_in_source" in reasons(s("팀장으로 응답 시간을 40% 줄였습니다."))
    assert "credential_not_in_source" in reasons(s("정보처리기사 보유", facts=("F1",)))
    assert "unknown_fact" in reasons(s("x", facts=("F9",)))
    assert "no_source" in reasons(s("x", facts=()))
    assert "unknown_requirement" in reasons(s("x", reqs=("R9",)))


def test_changes_and_assembly():
    originals = [OriginalSentence(id="O1", text="원본1", section="experience"),
                 OriginalSentence(id="O2", text="원본2", section="experience"),
                 OriginalSentence(id="O3", text="원본3", section="experience")]
    sents = [
        s("Redis로 주문 API 응답 시간을 40% 줄였습니다.", sid="S1", changeType="rephrased", originalRefs=["O1"]),
        s("Node.js 경력 3년", facts=("F1",), sid="S2", changeType="summarized", originalRefs=["O2"]),
        s("Kubernetes 전문가", sid="S3", changeType="rephrased", originalRefs=[]),
    ]
    vmap = {v.sentenceId: v for v in verify_sentences(sents, CTX)}
    changes = {c.changeId: c for c in build_changes(originals, sents, vmap)}
    assert changes["C-S1"].kind == "modified" and changes["C-S3"].kind == "added"
    assert changes["C-O3"].kind == "removed" and changes["C-S3"].status == "unsupported"

    decisions = [Decision(changeId="C-S1", decision="accept"), Decision(changeId="C-S3", decision="accept"),
                 Decision(changeId="C-O3", decision="accept")]
    texts = [t for _, t in assemble_items(originals, sents, vmap, decisions)]
    assert texts == ["Redis로 주문 API 응답 시간을 40% 줄였습니다.", "원본2"]  # S2 undecided -> original; S3 unsupported; O3 removed
