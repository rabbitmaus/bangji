"""In-memory pending approvals (15 min TTL)."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from .schemas import Sentence, TailoringRequest, Verification

TTL_SECONDS = 15 * 60


@dataclass
class Pending:
    request: TailoringRequest
    sentences: list[Sentence]
    verifications: dict[str, Verification]
    created: float = field(default_factory=time.monotonic)
    decision: asyncio.Future | None = None


_pending: dict[str, Pending] = {}


def put(tid: str, p: Pending) -> None:
    purge()
    _pending[tid] = p


def get(tid: str) -> Pending | None:
    purge()
    return _pending.get(tid)


def pop(tid: str) -> Pending | None:
    return _pending.pop(tid, None)


def purge() -> None:
    now = time.monotonic()
    for k in [k for k, v in _pending.items() if now - v.created > TTL_SECONDS]:
        del _pending[k]
