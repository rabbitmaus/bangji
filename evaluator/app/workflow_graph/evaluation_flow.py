"""Per-item evaluation as a real Microsoft Agent Framework workflow.

rule_gate(code) -> [qualification, fit](AI, conditional edges) -> aggregate(code, fan-in)
-> review(AI + verify_quote tool, optional) -> finalize(code).

Edges are conditional on the gate/aggregate result: reject/injection/detail_missing skip all AI.
Honest notes on framework limits:
* Executors are stateless; one mutable ItemState travels as the message (passed by reference in-process),
  which keeps the SSE contract (executor.* events with durations/errorClass) under our control.
* Executor failures surface as framework `executor_failed` events without the original exception type, so
  LimitReached is recorded on ItemState instead of being re-raised.
"""
import asyncio
import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from agent_framework import Executor, WorkflowBuilder, WorkflowContext, handler
from opentelemetry import trace
from typing_extensions import Never

from ..evaluation import agents, fake
from ..evaluation.aggregate import (aggregate, apply_review, fit_to_criteria, mark_disagreements,
                                    qualification_to_criteria, review_proposal)
from ..evaluation.gate import now_kst, run_rule_gate
from ..schemas import FitResult

log = logging.getLogger("bangji.evaluation")
tracer = trace.get_tracer("bangji.evaluator")


@dataclass
class ItemState:
    req: Any
    item: Any
    budget: Any
    emit: Any
    limit_exc: type
    fake: bool
    final_fn: Any
    excerpt: str = ""
    item_reasons: list = field(default_factory=list)
    injection: bool = False
    criteria: list = field(default_factory=list)
    verdict: str = "hold"
    reasons: list = field(default_factory=list)
    source: str = "rule"
    q_res: Any = None
    f_res: Any = None
    diagnostics: list = field(default_factory=list)
    calls: int = 0
    limit_hit: bool = False
    final: dict | None = None

    @property
    def needs_ai(self) -> bool:
        return not (self.injection or self.item.detail_missing or self.verdict == "reject")

    def on_call(self) -> None:
        self.budget.use()
        self.calls += 1


def _opaque(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


async def _step(state: ItemState, name: str, fn):
    """Run fn as an executor step: SSE started/completed (+optional errorClass) and an OTel span."""
    key = state.item.item_key
    start = time.monotonic()
    calls0 = state.calls
    diag0 = len(state.diagnostics)
    await state.emit("executor.started", {"itemKey": key, "executor": name})
    with tracer.start_as_current_span(f"bangji.executor.{name}") as span:
        span.set_attribute("bangji.run_id", _opaque(state.req.run_id))
        span.set_attribute("bangji.item", _opaque(key))
        span.set_attribute("bangji.executor", name)
        try:
            return await fn()
        finally:
            ms = int((time.monotonic() - start) * 1000)
            span.set_attribute("bangji.duration_ms", ms)
            span.set_attribute("bangji.model_calls", state.calls - calls0)
            payload = {"itemKey": key, "executor": name, "durationMs": ms}
            new = [d for d in state.diagnostics[diag0:] if d["executor"] == name]
            if new:
                payload["errorClass"] = new[0]["errorClass"]
            await state.emit("executor.completed", payload)


async def _agent(state: ItemState, name: str, real_fn, fake_fn):
    """Call an agent with timeout; classify failures instead of collapsing them."""
    if state.fake:
        return fake_fn()
    try:
        return await asyncio.wait_for(real_fn(), state.req.limits.agent_seconds)
    except state.limit_exc:
        state.limit_hit = True
        return None
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        cls = "agent_timeout"
    except Exception as e:  # noqa: BLE001
        cls = "schema_failure" if type(e).__name__ in ("ValidationError", "ValueError") else "agent_error"
        log.warning("%s agent failed: %s", name, type(e).__name__)
    state.diagnostics.append({"executor": name, "errorClass": cls})
    return None


class RuleGate(Executor):
    def __init__(self):
        super().__init__(id="rule_gate")

    @handler
    async def run(self, s: ItemState, ctx: WorkflowContext[ItemState]) -> None:
        async def body():
            from ..evaluation.text import MAX_EXCERPT_CHARS

            item, req = s.item, s.req
            s.excerpt, truncated = item.excerpt, item.truncated
            if len(s.excerpt) > MAX_EXCERPT_CHARS:
                s.excerpt, truncated = s.excerpt[:MAX_EXCERPT_CHARS], True
            s.item_reasons = ["input_truncated"] if truncated else []
            s.injection = item.injection_suspected
            s.criteria = list(run_rule_gate(req.conditions.rules, item.fields, req.experience_years, now_kst()))
            s.verdict, s.reasons = aggregate(
                s.criteria, s.injection, s.item_reasons + (["detail_missing"] if item.detail_missing else []))
            if not s.needs_ai:
                await s.emit("verdict.partial", {"itemKey": item.item_key, "decision": s.verdict,
                                                 "holdReasons": s.reasons})

        await _step(s, "rule_gate", body)
        await ctx.send_message(s)


class Qualification(Executor):
    def __init__(self):
        super().__init__(id="qualification")

    @handler
    async def run(self, s: ItemState, ctx: WorkflowContext[ItemState]) -> None:
        async def body():
            s.q_res = await _agent(
                s, "qualification",
                lambda: agents.qualification(s.excerpt, s.req.facts, s.on_call),
                lambda: fake.qualification(s.excerpt, s.req.facts))

        await _step(s, "qualification", body)
        await ctx.send_message(s)


class Fit(Executor):
    def __init__(self):
        super().__init__(id="fit")

    @handler
    async def run(self, s: ItemState, ctx: WorkflowContext[ItemState]) -> None:
        async def body():
            sem = s.req.conditions.semantic
            if not sem:
                s.f_res = "skipped"
                return
            s.f_res = await _agent(
                s, "fit",
                lambda: agents.fit(s.excerpt, s.req.facts, sem, s.on_call),
                lambda: fake.fit(s.excerpt, s.req.facts, sem))

        await _step(s, "fit", body)
        await ctx.send_message(s)


class Aggregate(Executor):
    def __init__(self):
        super().__init__(id="aggregate")

    @handler
    async def run(self, ss: list[ItemState], ctx: WorkflowContext[ItemState]) -> None:
        s = ss[0]

        async def body():
            cond = s.req.conditions
            q, f = s.q_res, s.f_res
            s.criteria += qualification_to_criteria(q, s.excerpt, s.req.facts, cond.default_qualification_required)
            if f != "skipped":
                s.criteria += fit_to_criteria(f, cond.semantic, s.excerpt, s.req.facts)
            s.injection = s.injection or bool(q and q.injection_suspected) or bool(
                isinstance(f, FitResult) and f.injection_suspected)
            mark_disagreements(s.criteria)
            s.source = "ai"
            failed = q is None or f is None
            s.verdict, s.reasons = aggregate(
                s.criteria, s.injection, s.item_reasons + (["schema_failure"] if failed else []))
            await s.emit("verdict.partial", {"itemKey": s.item.item_key, "decision": s.verdict,
                                             "holdReasons": s.reasons})

        await _step(s, "aggregate", body)
        await ctx.send_message(s)


class Review(Executor):
    def __init__(self):
        super().__init__(id="review")

    @handler
    async def run(self, s: ItemState, ctx: WorkflowContext[ItemState]) -> None:
        async def body():
            crit = json.dumps([c.model_dump(by_alias=True) for c in s.criteria], ensure_ascii=False)
            res = None
            if not s.fake:
                res = await _agent(s, "review", lambda: agents.review(s.excerpt, s.verdict, crit, s.on_call),
                                   lambda: None)
                if res is None and any(d["executor"] == "review" for d in s.diagnostics):
                    s.diagnostics.append({"executor": "review", "errorClass": "review_failed"})
            new, extra = apply_review(s.verdict, review_proposal(res))
            if new != s.verdict:
                await s.emit("review.changed", {"itemKey": s.item.item_key, "before": s.verdict, "after": new,
                                                "reason": res.reason if res else ""})
                s.verdict, s.reasons, s.source = new, extra, "review"

        await _step(s, "review", body)
        await ctx.send_message(s)


class Finalize(Executor):
    def __init__(self):
        super().__init__(id="finalize")

    @handler
    async def run(self, s: ItemState, ctx: WorkflowContext[Never, dict]) -> None:
        async def body():
            s.final = s.final_fn(s.item, s.verdict, s.source, s.criteria, s.reasons, s.injection, s.excerpt)
            s.final["diagnostics"] = list(s.diagnostics)
            s.final["modelCalls"] = s.calls

        await _step(s, "finalize", body)
        await ctx.yield_output(s.final)


def _ai_review_path(s: ItemState) -> bool:
    return s.source == "ai" and s.verdict in ("pass", "reject")


def build_evaluation_workflow():
    gate, qual, fit, agg, rev, fin = RuleGate(), Qualification(), Fit(), Aggregate(), Review(), Finalize()
    return (
        WorkflowBuilder(name="bangji_evaluation", start_executor=gate)
        .add_edge(gate, qual, condition=lambda s: s.needs_ai)
        .add_edge(gate, fit, condition=lambda s: s.needs_ai)
        .add_edge(gate, fin, condition=lambda s: not s.needs_ai)
        .add_fan_in_edges([qual, fit], agg)
        .add_edge(agg, rev, condition=_ai_review_path)
        .add_edge(agg, fin, condition=lambda s: not _ai_review_path(s))
        .add_edge(rev, fin)
        .build()
    )


async def run_item_workflow(state: ItemState) -> dict:
    """Run a fresh workflow for one item (isolated under concurrency); returns the final verdict dict."""
    out = None
    async for ev in build_evaluation_workflow().run(state, stream=True):
        if ev.type == "output":
            out = ev.data
        elif ev.type in ("failed", "executor_failed"):
            raise RuntimeError(f"workflow_{ev.type}")
    if out is None:
        raise RuntimeError("workflow_no_output")
    return out
