"""Tailoring workflow: tailor -> fact_verifier -> approval (HITL pause) -> assemble."""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, AsyncIterator

from . import state
from .compare import assemble_items, build_changes, render_markdown
from .schemas import (
    Decision, FinalizeRequest, ResponsesRequest, Sentence, TailoringRequest, Verification, VerifyContext,
)
from .verifier import verify_sentences

Event = tuple[str, dict[str, Any]]


def fake_mode() -> bool:
    return os.environ.get("BANGJI_FAKE_MODEL") == "1"


def ctx_of(req: TailoringRequest) -> VerifyContext:
    names = list(req.companyNames)
    if req.posting.company:
        names.append(req.posting.company)
    return VerifyContext(facts=req.facts, requirements=req.requirements, companyNames=names)


async def _draft(req: TailoringRequest, sink=None) -> list[Sentence]:
    if fake_mode():
        from .fake import fake_tailor

        return fake_tailor(req).sentences
    from .agents import run_tailor_agent
    from ..copilot_client import delta_sink

    last: Exception | None = None
    for attempt in range(2):  # one retry on agent or schema failure (TRD 4.10)
        token = delta_sink.set(sink if attempt == 0 else None)
        try:
            return (await run_tailor_agent(req)).sentences
        except Exception as e:  # noqa: BLE001
            last = e
        finally:
            delta_sink.reset(token)
    raise RuntimeError("schema_failure") from last


async def run_tailoring(req: TailoringRequest) -> AsyncIterator[Event]:
    tid = req.tailoringId
    yield "tailoring.started", {"tailoringId": tid, "posting": req.posting.model_dump()}
    t0 = time.monotonic()
    yield "executor.started", {"executor": "tailor", "itemKey": req.posting.itemKey}
    deltas: asyncio.Queue = asyncio.Queue()

    async def sink(chunk: str) -> None:
        await deltas.put(chunk)

    draft_task = asyncio.create_task(_draft(req, sink))
    streamed = False
    try:
        while not draft_task.done() or not deltas.empty():
            try:
                chunk = await asyncio.wait_for(deltas.get(), 0.2)
            except asyncio.TimeoutError:
                continue
            streamed = True
            yield "draft.delta", {"tailoringId": tid, "text": chunk}
        sentences = await draft_task
    except Exception as e:  # noqa: BLE001
        code = "schema_failure" if "schema" in str(e) else "tailor_failed"
        yield "tailoring.failed", {"tailoringId": tid, "code": code}
        return
    finally:
        if not draft_task.done():
            draft_task.cancel()
    if not streamed:
        yield "draft.delta", {"tailoringId": tid, "text": "\n".join(s.text for s in sentences)}
    yield "draft.completed", {"tailoringId": tid, "sentences": [s.model_dump() for s in sentences]}
    yield "executor.completed", {"executor": "tailor", "itemKey": req.posting.itemKey,
                                 "durationMs": int((time.monotonic() - t0) * 1000)}

    t1 = time.monotonic()
    yield "executor.started", {"executor": "fact_verifier", "itemKey": req.posting.itemKey}
    vs = verify_sentences(sentences, ctx_of(req))
    vmap = {v.sentenceId: v for v in vs}
    yield "verification.result", {"tailoringId": tid, "results": [v.model_dump() for v in vs]}
    yield "executor.completed", {"executor": "fact_verifier", "itemKey": req.posting.itemKey,
                                 "durationMs": int((time.monotonic() - t1) * 1000)}

    changes = build_changes(req.originalSentences, sentences, vmap)
    state.put(tid, state.Pending(request=req, sentences=sentences, verifications=vmap))
    yield "executor.started", {"executor": "approval", "itemKey": req.posting.itemKey}
    yield "approval.requested", {
        "tailoringId": tid,
        "changes": [c.model_dump() for c in changes],
        "sentences": [s.model_dump() for s in sentences],
        "verifications": [v.model_dump() for v in vs],
    }


def assemble(req: TailoringRequest, sentences: list[Sentence], decisions: list[Decision]) -> str:
    # Always re-verify in code; assembly never trusts client-supplied status.
    vmap = {v.sentenceId: v for v in verify_sentences(sentences, ctx_of(req))}
    items = assemble_items(req.originalSentences, sentences, vmap, decisions)
    return render_markdown(req.posting, items)


async def run_responses(tid: str, body: ResponsesRequest) -> AsyncIterator[Event] | None:
    p = state.pop(tid)
    if p is None:
        return None

    async def gen() -> AsyncIterator[Event]:
        yield "executor.completed", {"executor": "approval", "itemKey": p.request.posting.itemKey}
        yield "executor.started", {"executor": "assemble", "itemKey": p.request.posting.itemKey}
        sentences = body.sentences if body.sentences is not None else p.sentences
        md = assemble(p.request, sentences, body.decisions)
        yield "executor.completed", {"executor": "assemble", "itemKey": p.request.posting.itemKey}
        yield "tailoring.completed", {"tailoringId": tid, "markdown": md}

    return gen()


async def run_finalize(tid: str, body: FinalizeRequest) -> str:
    await asyncio.sleep(0)
    state.pop(tid)
    return assemble(body, body.sentences, body.decisions)
