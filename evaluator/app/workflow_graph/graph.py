"""Mermaid derived from the real constructed workflow (WorkflowViz), plus the tailoring stages."""
TAILORING_MERMAID = """
    subgraph TL["맞춤 이력서 워크플로 · 선택 공고마다"]
        TL_tailor["tailor · AI"] --> TL_fv["fact_verifier · 코드"] --> TL_ap["approval · HITL"] --> TL_as["assemble · 코드"]
    end
    finalize --> TL_tailor
"""


def derive_mermaid() -> str:
    """Raises if the SDK or WorkflowViz is unavailable; caller falls back to the constant."""
    from agent_framework import WorkflowViz

    from .evaluation_flow import build_evaluation_workflow

    text = WorkflowViz(build_evaluation_workflow()).to_mermaid()
    if not text.strip():
        raise ValueError("empty mermaid")
    return text.rstrip() + "\n" + TAILORING_MERMAID
