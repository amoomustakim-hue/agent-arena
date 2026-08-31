"""Whether council orchestration is even possible right now, and why not.

Surfaced by /health so the failure mode is "the UI tells you what's missing"
rather than "the first council run throws deep inside a graph node."
"""

from __future__ import annotations

import os

from ..config import settings


def llm_status() -> dict[str, str | bool]:
    """Readiness for whichever provider `LLM_PROVIDER` selects.

    Two providers, two very different failure messages, because "no key" means
    something different depending which service it is missing for — pointing
    someone at `ant auth login` when they set LLM_PROVIDER=groq would just be
    wrong.
    """
    if settings.llm_provider == "groq":
        key = os.getenv("GROQ_API_KEY", "").strip()
        if key:
            return {"ready": True, "source": "env", "provider": "groq", "model": settings.groq_model}
        return {
            "ready": False,
            "source": "none",
            "provider": "groq",
            "detail": (
                "LLM_PROVIDER=groq but GROQ_API_KEY is not set. Get a free key at "
                "console.groq.com and set GROQ_API_KEY in .env — no billing required."
            ),
        }

    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    token = os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
    if key or token:
        return {"ready": True, "source": "env", "provider": "anthropic", "model": settings.model}
    return {
        "ready": False,
        "source": "none",
        "provider": "anthropic",
        "detail": (
            "No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, and no `ant` CLI profile "
            "was found. Council sessions cannot run until one is configured — set "
            "ANTHROPIC_API_KEY in .env, run `ant auth login`, or set LLM_PROVIDER=groq for "
            "free-tier testing (see GROQ_API_KEY in .env.example)."
        ),
    }
