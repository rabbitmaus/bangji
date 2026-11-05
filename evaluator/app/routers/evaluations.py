import json

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from ..evaluation import run_evaluation
from ..schemas import EvaluationRequest

router = APIRouter()


@router.post("/internal/evaluations")
async def evaluations(req: EvaluationRequest):
    async def stream():
        async for name, data in run_evaluation(req):
            yield {"id": f"{req.run_id}:{data['seq']}", "event": name,
                   "data": json.dumps(data, ensure_ascii=False)}

    return EventSourceResponse(stream())
