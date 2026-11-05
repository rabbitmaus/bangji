from app.tailoring.graph import workflow_graph_info


def test_graph_response_shape():
    info = workflow_graph_info()
    assert isinstance(info["mermaid"], str) and "flowchart" in info["mermaid"]
    assert isinstance(info["derived"], bool)
