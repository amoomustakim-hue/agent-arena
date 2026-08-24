"""Whether council orchestration is even possible right now, and why not.

Surfaced by /health so the failure mode is "the UI tells you what's missing"
rather than "the first council run throws deep inside a graph node."
"""

from __future__ import annotations

import os


def anthropic_status() -> dict[str, str | bool]:
    key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    token = os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip()
    if key or token:
        return {"ready": True, "source": "env"}
    return {
        "ready": False,
        "source": "none",
        "detail": (
            "No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set, and no `ant` CLI profile "
            "was found. Council sessions cannot run until one is configured — set "
            "ANTHROPIC_API_KEY in .env, or run `ant auth login`."
        ),
    }
