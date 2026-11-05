from __future__ import annotations

import json
from typing import Any, AsyncIterator

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from app.tailoring.graph import workflow_graph_info
from app.tailoring.schemas import FinalizeRequest, ResponsesRequest, TailoringRequest, VerifySentencesRequest
from app.tailoring.verifier import verify_sentences
from app.tailoring.workflow import run_finalize, run_responses, run_tailoring

router = APIRouter()


async def _sse(tid: str, events: AsyncIterator[tuple[str, dict[str, Any]]]):
    seq = 0
    async for name, data in events:
        seq += 1
        payload = {"runId": tid, "seq": seq, **data}
        yield {"id": f"{tid}:{seq}", "event": name, "data": json.dumps(payload, ensure_ascii=False)}


@router.post("/internal/tailorings")
async def create_tailoring(body: TailoringRequest):
    return EventSourceResponse(_sse(body.tailoringId, run_tailoring(body)))


@router.post("/internal/tailorings/{tid}/responses")
async def tailoring_responses(tid: str, body: ResponsesRequest):
    events = await run_responses(tid, body)
    if events is None:
        raise HTTPException(status_code=404, detail="pending_not_found")
    return EventSourceResponse(_sse(tid, events))


@router.post("/internal/tailorings/{tid}/finalize")
async def tailoring_finalize(tid: str, body: FinalizeRequest):
    return {"tailoringId": tid, "markdown": await run_finalize(tid, body)}


@router.post("/internal/verify-sentences")
async def verify(body: VerifySentencesRequest):
    return {"results": [v.model_dump() for v in verify_sentences(body.sentences, body)]}


@router.get("/internal/workflow-graph")
async def get_workflow_graph():
    return workflow_graph_info()
