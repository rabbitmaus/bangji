"""Model-contract smoke test (needs COPILOT_GITHUB_TOKEN). Run: python scripts/smoke_models.py"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


async def main() -> int:
    if not os.environ.get("COPILOT_GITHUB_TOKEN"):
        print("SKIP: COPILOT_GITHUB_TOKEN not set")
        return 0
    from app.evaluation import agents
    from app.schemas import Fact

    excerpt = "백엔드 개발자 모집. 필수: Python 경력 2년 이상, SQL 사용 경험."
    facts = [Fact(id="F1", text="Python으로 3년간 백엔드 API를 개발했다")]
    ok = True
    try:
        await agents.qualification(excerpt, facts)
        print("PASS qualification")
    except Exception as e:  # noqa: BLE001
        ok = False
        print("FAIL qualification", type(e).__name__, str(e)[:200])
    try:
        await agents.review(excerpt, "pass", "[]")
        print("PASS review (verify_quote tool)")
    except Exception as e:  # noqa: BLE001
        ok = False
        print("FAIL review", type(e).__name__, str(e)[:200])
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
