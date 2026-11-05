"""Evaluation workflow runner: per-item rule gate -> qualification/fit -> aggregate -> review -> finalize.

Emits (event_name, data) per TRD 8.3 as an async generator. Items run concurrently (limit 3).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import AsyncIterator

from ..schemas import (Criterion, EvaluationRequest, PostingItem, QualificationResult, FitResult, VerdictFinal)
from . import agents, fake
from .aggregate import (aggregate, apply_review, fit_to_criteria, mark_disagreements,
                        qualification_to_criteria, review_proposal)
from .gate import now_kst, run_rule_gate
from .text import MAX_EXCERPT_CHARS, sha256_hex

log = logging.getLogger("bangji.evaluation")
HEARTBEAT_SECONDS = 15


class LimitReached(Exception):
    pass


class Budget:
    def __init__(self, max_calls: int):
        self.max_calls, self.used = max_calls, 0

    def use(self) -> None:
        if self.used >= self.max_calls:
            raise LimitReached()
        self.used += 1

    @property
    def exhausted(self) -> bool:
        return self.used >= self.max_calls


def fake_mode() -> bool:
    return os.environ.get("BANGJI_FAKE_MODEL") == "1"


def _final(item: PostingItem, decision: str, source: str, criteria: list[Criterion], reasons: list[str],
           injection: bool, excerpt: str) -> dict:
    digest = sha256_hex(excerpt)
    v = VerdictFinal(
        item_key=item.item_key, decision=decision, source=source, criteria=criteria, hold_reasons=reasons,
        injection_suspected=injection, excerpt_sha256=digest,
        excerpt_sha256_matches=(item.excerpt_sha256 is None or item.excerpt_sha256.lower() == digest),
    )
    return v.model_dump(by_alias=True)


async def _timed(emit, item_key: str, name: str, coro):
    start = time.monotonic()
    await emit("executor.started", {"itemKey": item_key, "executor": name})
    try:
        return await coro
    finally:
        await emit("executor.completed", {
            "itemKey": item_key, "executor": name, "durationMs": int((time.monotonic() - start) * 1000)})


async def _agent_call(real_fn, fake_fn):
    if fake_mode():
        return fake_fn()
    try:
        return await real_fn()
    except (LimitReached, asyncio.CancelledError):
        raise
    except Exception as e:  # schema or call failure after retry (4.10)
        log.warning("agent call failed: %s", type(e).__name__)
        return None


async def evaluate_item(req: EvaluationRequest, item: PostingItem, budget: Budget, emit) -> dict:
    """Agent Framework workflow when the SDK is importable; sequential legacy path otherwise."""
    try:
        from ..workflow_graph.evaluation_flow import ItemState, run_item_workflow
    except ImportError:
        return await _evaluate_item_legacy(req, item, budget, emit)
    state = ItemState(req=req, item=item, budget=budget, emit=emit, limit_exc=LimitReached,
                      fake=fake_mode(), final_fn=_final)
    final = await run_item_workflow(state)
    if state.limit_hit:
        final = _timeout_final(item, "limit_reached")
    return final


async def _evaluate_item_legacy(req: EvaluationRequest, item: PostingItem, budget: Budget, emit) -> dict:
    key = item.item_key
    excerpt = item.excerpt
    truncated = item.truncated
    if len(excerpt) > MAX_EXCERPT_CHARS:
        excerpt, truncated = excerpt[:MAX_EXCERPT_CHARS], True
    item_reasons = ["input_truncated"] if truncated else []
    injection = item.injection_suspected
    cond = req.conditions

    rules = await _timed(emit, key, "rule_gate", _async(
        lambda: run_rule_gate(cond.rules, item.fields, req.experience_years, now_kst())))
    criteria: list[Criterion] = list(rules)
    verdict, reasons = aggregate(criteria, injection, item_reasons + (["detail_missing"] if item.detail_missing else []))
    source = "rule"

    skip_ai = injection or item.detail_missing or verdict == "reject"
    if not skip_ai:
        on_call = budget.use
        agent_t = req.limits.agent_seconds

        async def qual():
            r = await _agent_call(
                lambda: asyncio.wait_for(agents.qualification(excerpt, req.facts, on_call), agent_t),
                lambda: fake.qualification(excerpt, req.facts))
            return r

        async def fit():
            if not cond.semantic:
                return "skipped"
            return await _agent_call(
                lambda: asyncio.wait_for(agents.fit(excerpt, req.facts, cond.semantic, on_call), agent_t),
                lambda: fake.fit(excerpt, req.facts, cond.semantic))

        q_res, f_res = await asyncio.gather(
            _timed(emit, key, "qualification", qual()), _timed(emit, key, "fit", fit()))
        q_res: QualificationResult | None
        criteria += qualification_to_criteria(q_res, excerpt, req.facts, cond.default_qualification_required)
        if f_res != "skipped":
            criteria += fit_to_criteria(f_res, cond.semantic, excerpt, req.facts)
        injection = injection or bool(q_res and q_res.injection_suspected) or bool(
            isinstance(f_res, FitResult) and f_res.injection_suspected)
        mark_disagreements(criteria)
        source = "ai"
        schema_failed = q_res is None or f_res is None
        item_reasons_ai = item_reasons + (["schema_failure"] if schema_failed else [])
        verdict, reasons = await _timed(emit, key, "aggregate", _async(
            lambda: aggregate(criteria, injection, item_reasons_ai)))
        await emit("verdict.partial", {"itemKey": key, "decision": verdict, "holdReasons": reasons})
    else:
        await emit("verdict.partial", {"itemKey": key, "decision": verdict, "holdReasons": reasons})

    if source == "ai" and verdict in ("pass", "reject"):
        crit_json = json.dumps([c.model_dump(by_alias=True) for c in criteria], ensure_ascii=False)

        async def rev():
            if fake_mode():
                return None
            try:
                return await asyncio.wait_for(
                    agents.review(excerpt, verdict, crit_json, budget.use), req.limits.agent_seconds)
            except LimitReached:
                raise
            except Exception as e:
                log.warning("review failed: %s", type(e).__name__)
                return None  # review is optional; verdict stays

        res = await _timed(emit, key, "review", rev())
        new, extra = apply_review(verdict, review_proposal(res))
        if new != verdict:
            await emit("review.changed", {"itemKey": key, "before": verdict, "after": new,
                                          "reason": res.reason if res else ""})
            verdict, reasons, source = new, extra, "review"

    return await _timed(emit, key, "finalize", _async(
        lambda: _final(item, verdict, source, criteria, reasons, injection, excerpt)))


async def _async(fn):
    return fn()


def _needs_ai(req: EvaluationRequest, item: PostingItem) -> bool:
    return not (item.injection_suspected or item.detail_missing)


def _timeout_final(item: PostingItem, code: str) -> dict:
    return _final(item, "hold", "rule", [], [code], item.injection_suspected, item.excerpt)


async def run_evaluation(req: EvaluationRequest) -> AsyncIterator[tuple[str, dict]]:
    queue: asyncio.Queue = asyncio.Queue()
    budget = Budget(req.limits.model_calls)
    started = time.monotonic()
    deadline = started + req.limits.run_seconds
    sem = asyncio.Semaphore(max(1, req.limits.concurrency))
    counts = {"pass": 0, "reject": 0, "hold": 0}

    async def emit(name: str, data: dict):
        await queue.put((name, data))

    async def worker(item: PostingItem):
        async with sem:
            remaining = deadline - time.monotonic()
            try:
                if remaining <= 0:
                    final = _timeout_final(item, "timeout")
                elif budget.exhausted and not fake_mode() and _needs_ai(req, item):
                    final = _timeout_final(item, "limit_reached")
                else:
                    final = await asyncio.wait_for(
                        evaluate_item(req, item, budget, emit), min(req.limits.item_seconds, remaining))
            except asyncio.TimeoutError:
                final = _timeout_final(item, "timeout")
            except LimitReached:
                final = _timeout_final(item, "limit_reached")
            except Exception as e:
                log.exception("item %s failed: %s", item.item_key, type(e).__name__)
                final = _timeout_final(item, "schema_failure")
            counts[final["decision"]] += 1
            await emit("verdict.final", final)

    seq = 0

    def stamp(name: str, data: dict) -> tuple[str, dict]:
        nonlocal seq
        seq += 1
        return name, {"runId": req.run_id, "seq": seq, **data}

    yield stamp("run.started", {"limits": req.limits.model_dump(by_alias=True), "itemCount": len(req.items)})
    yield stamp("stage.changed", {"stage": "evaluating"})

    async def main():
        try:
            await asyncio.gather(*(worker(i) for i in req.items))
        finally:
            await queue.put(None)

    task = asyncio.create_task(main())
    try:
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield stamp("heartbeat", {})
                continue
            if ev is None:
                break
            yield stamp(*ev)
        await task
        yield stamp("stage.changed", {"stage": "completed"})
        yield stamp("run.completed", {"verdictCount": sum(counts.values()), "counts": counts})
    except Exception as e:
        log.exception("run failed")
        yield stamp("run.failed", {"code": "evaluation_failed", "message": type(e).__name__})
    finally:
        if not task.done():
            task.cancel()
