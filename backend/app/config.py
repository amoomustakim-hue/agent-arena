"""Backend configuration.

The backend deliberately knows nothing about Somnia, viem, or the DreamDEX SDK.
Its only route to the venue is the MCP server, so the settings here describe how
to *reach* that server rather than how to talk to a chain.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# The repo root: backend/app/config.py -> backend/ -> repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]

load_dotenv(REPO_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    """Everything the backend needs, resolved once at import."""

    repo_root: Path = REPO_ROOT

    # --- The MCP intelligence server (read-only). Spawned as a child process
    # over stdio. `tsx` is invoked through Node directly rather than through a
    # shell so there is no shell quoting to get wrong on Windows.
    mcp_server: Path = REPO_ROOT / "packages" / "arena-mcp" / "src" / "server.ts"
    trading_mcp_server: Path = REPO_ROOT / "packages" / "arena-trade-mcp" / "src" / "server.ts"
    tsx_cli: Path = REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"

    # Run the whole stack with no network. Propagated to the MCP child.
    fixtures: bool = field(default_factory=lambda: os.getenv("ARENA_FIXTURES") == "true")

    network: str = field(default_factory=lambda: os.getenv("NETWORK", "testnet"))
    model: str = field(default_factory=lambda: os.getenv("ARENA_MODEL", "claude-opus-5"))

    # Which LLM backs the council. "anthropic" (default, real demo) or "groq"
    # — Groq hosts open-weight models (not Claude) behind an OpenAI-compatible
    # API with a genuinely free tier, which makes it useful for testing the
    # orchestration (LangGraph flow, MCP tool calls, event recording, the
    # WebSocket stream) end to end at zero cost. It is not a substitute for
    # judgment quality: this swaps which model argues, not just which bill it
    # goes on. gpt-oss-120b is the default because it is one of the few models
    # Groq runs in strict structured-output mode (guaranteed schema-valid
    # JSON via constrained decoding), which the council's belief/verdict
    # schemas depend on exactly as much as Claude's structured outputs do.
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "anthropic").lower())
    groq_model: str = field(default_factory=lambda: os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"))

    # Completed sessions live here as Black Box JSONL. The TypeScript reputation
    # tools read the same directory — the file format is the contract between
    # the two languages, which is why neither imports the other.
    sessions_dir: Path = field(
        default_factory=lambda: REPO_ROOT / os.getenv("ARENA_SESSIONS", "blackbox")
    )

    def mcp_command(self) -> tuple[str, list[str]]:
        """The argv for spawning the read-only intelligence MCP server."""
        args = [str(self.tsx_cli), str(self.mcp_server)]
        if self.fixtures:
            args.append("--fixtures")
        return ("node", args)

    def trading_mcp_command(self) -> tuple[str, list[str]]:
        """The argv for spawning the (read-only-in-practice) trading MCP server."""
        args = [str(self.tsx_cli), str(self.trading_mcp_server)]
        if self.fixtures:
            args.append("--fixtures")
        return ("node", args)

    def mcp_env(self) -> dict[str, str]:
        """Environment for the MCP child.

        Passes the parent environment through so the child picks up NETWORK,
        VENUE_ID and the RPC endpoints from the same .env the backend read.
        """
        env = dict(os.environ)
        if self.fixtures:
            env["ARENA_FIXTURES"] = "true"
        return env


settings = Settings()
