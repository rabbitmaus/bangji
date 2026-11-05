"""Copilot SDK / Agent Framework adapter (TRD 3.2, 3.5, 4.2). All SDK API usage is isolated here."""
from __future__ import annotations

import contextvars
import json
import os
import tempfile
from typing import Any

from pydantic import BaseModel, ValidationError

_client: Any = None
_base_dir: str | None = None


def make_client():
    """CopilotClient in multi-user safe `empty` mode with the server token only."""
    global _base_dir
    from copilot import CopilotClient

    if _base_dir is None:
        _base_dir = tempfile.mkdtemp(prefix="copilot-")
    return CopilotClient(
        mode="empty",
        base_directory=_base_dir,
        session_idle_timeout_seconds=300,
        use_logged_in_user=False,
        github_token=os.environ.get("COPILOT_GITHUB_TOKEN"),
    )


def get_client():
    global _client
    if _client is None:
        _client = make_client()
    return _client


def _tool_name(tool: Any) -> str:
    return getattr(tool, "name", None) or getattr(tool, "__name__", str(tool))


def make_agent(name: str, instructions: str, tools: list | None = None, model: str | None = None):
    """GitHubCopilotAgent with an explicit tool allowlist; permission requests stay denied (default)."""
    from agent_framework.github import GitHubCopilotAgent

    tools = list(tools or [])
    options: dict[str, Any] = {
        "available_tools": [f"custom:{_tool_name(t)}" for t in tools],  # explicit, possibly empty
        "timeout": float(os.environ.get("GITHUB_COPILOT_TIMEOUT", "60")),
    }
    model = model or os.environ.get("GITHUB_COPILOT_MODEL")
    if model:
        options["model"] = model
    return GitHubCopilotAgent(
        name=name, instructions=instructions, client=get_client(), tools=tools or None, default_options=options,
    )


# Optional async callback receiving token deltas (str); set by callers that want streamed text.
delta_sink: contextvars.ContextVar[Any] = contextvars.ContextVar("bangji_delta_sink", default=None)


async def _run_text(agent, prompt: str) -> str:
    sink = delta_sink.get()
    if sink is not None:
        try:
            parts: list[str] = []
            async for update in agent.run(prompt, stream=True):
                chunk = getattr(update, "text", None)
                if chunk:
                    parts.append(chunk)
                    await sink(chunk)
            if parts:
                return "".join(parts)
        except TypeError:
            pass  # streaming unsupported by this agent; fall back to a single call
    response = await agent.run(prompt)
    return getattr(response, "text", None) or str(response)


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end > start else text


async def run_json(agent, prompt: str, schema: type[BaseModel], on_call=None):
    """Run the agent and validate JSON against schema; one retry with the error on failure.

    on_call() is invoked before every model call (budget accounting).
    """
    schema_json = json.dumps(schema.model_json_schema(by_alias=True), ensure_ascii=False)
    full = f"{prompt}\n\nRespond with ONLY a JSON object matching this JSON Schema:\n{schema_json}"
    error: Exception | None = None
    for attempt in range(2):
        if on_call:
            on_call()
        text = await _run_text(agent, full if attempt == 0 else (
            f"{full}\n\nYour previous response was invalid: {str(error)[:500]}. Return corrected JSON only."))
        try:
            return schema.model_validate_json(_extract_json(text))
        except (ValidationError, ValueError) as e:
            error = e
    raise error  # type: ignore[misc]


__all__ = ["delta_sink", "make_client", "make_agent", "run_json", "get_client"]
