"""Mermaid text for the two workflows (TRD 4.1). Combined diagram of both workflows."""
from __future__ import annotations

FALLBACK_MERMAID = """flowchart TD
    subgraph EV["평가 워크플로 · 공고마다"]
        INP["공고 발췌·조건·사실"] --> RG["rule_gate · 코드"]
        RG -->|"검증된 위반"| FN["finalize · 코드"]
        RG -->|"그 밖"| QA["qualification · AI"]
        RG -->|"그 밖"| FA["fit · AI"]
        QA --> AG["aggregate · 코드"]
        FA --> AG
        AG --> RV["review · AI"]
        RV --> FN
    end
    FN --> SEL["사용자가 pass 공고 선택"]
    subgraph TL["맞춤 이력서 워크플로 · 선택 공고마다"]
        TA["tailor · AI"] --> FV["fact_verifier · 코드"] --> HU["approval · HITL"] --> AS["assemble · 코드"]
    end
    SEL --> TA
"""


def workflow_graph_info() -> dict:
    """Evaluation part derived from the real workflow object; tailoring stages are appended statically
    because run_tailoring is an async generator, not a framework Workflow."""
    try:
        from app.workflow_graph.graph import derive_mermaid

        return {"mermaid": derive_mermaid(), "derived": True}
    except Exception:  # noqa: BLE001
        return {"mermaid": FALLBACK_MERMAID, "derived": False}


def workflow_graph() -> str:
    return workflow_graph_info()["mermaid"]
