"""Pydantic mirrors of packages/arena-agents/src/schemas.ts.

`cites` is load-bearing here exactly as it is on the TypeScript side: the
mechanical audit (called over MCP — see llm.py) checks every cited signal id
against what was actually captured, so an agent that cannot be made to emit a
clean id list cannot be audited at all, and the whole "reasoning here is
checkable" claim goes decorative.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Belief(BaseModel):
    p: float = Field(
        ge=0.01, le=0.99, description="Probability that YES settles true, strictly between 0.01 and 0.99"
    )
    confidence: float = Field(ge=0, le=1, description="Weight to give this view given evidence quality, 0-1")
    rationale: str = Field(description="Two or three sentences. State the reasoning, not a summary of the data.")
    cites: list[str] = Field(
        description="Signal ids this belief actually rests on. Use ONLY ids from the evidence table."
    )


class Challenge(BaseModel):
    severity: str = Field(description='One of: none, minor, material, fatal. "none" if the reasoning holds up.')
    claim: str = Field(description="The specific flaw, in one or two sentences. Empty if severity is none.")
    cites: list[str] = Field(description="Signal ids relevant to the challenge")


class Response(BaseModel):
    moved: bool = Field(description="True if the challenge changed your view")
    p: float = Field(ge=0.01, le=0.99)
    rationale: str = Field(
        description="If you moved, say what specifically changed your mind. If you held, say why the challenge fails."
    )
    cites: list[str]


class Verdict(BaseModel):
    p: float = Field(ge=0.01, le=0.99)
    dissent: str = Field(
        description="Where the council genuinely disagreed, and which side you found more credible. Do not smooth this over."
    )
    key_evidence: list[str] = Field(description="Signal ids that most determined the verdict")
