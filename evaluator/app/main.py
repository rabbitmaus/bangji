from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from opentelemetry import context as otel_context
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from app.routers import evaluations, tailorings

log = logging.getLogger("bangji.evaluator")


def _setup_telemetry() -> None:
    if os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING"):
        try:
            from azure.monitor.opentelemetry import configure_azure_monitor

            configure_azure_monitor()
        except Exception:  # noqa: BLE001
            log.exception("azure monitor setup failed")
    try:  # Agent Framework built-in OTel; prompts/responses are never recorded
        from agent_framework.observability import enable_instrumentation

        enable_instrumentation(enable_sensitive_data=False)
    except Exception:  # noqa: BLE001
        log.warning("agent framework instrumentation unavailable")


class TraceparentMiddleware:
    """Attach the caller's W3C trace context for the duration of the request."""

    def __init__(self, app):
        self.app = app
        self.prop = TraceContextTextMapPropagator()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"] if k in (b"traceparent", b"tracestate")}
        token = otel_context.attach(self.prop.extract(headers))
        try:
            await self.app(scope, receive, send)
        finally:
            otel_context.detach(token)


_setup_telemetry()

app = FastAPI(title="bangji-evaluator")
app.add_middleware(TraceparentMiddleware)
app.include_router(evaluations.router)
app.include_router(tailorings.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
