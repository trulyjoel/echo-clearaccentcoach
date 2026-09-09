from typing import Literal

from pydantic import BaseModel


class CanonicalWord(BaseModel):
    """One transcript word and its canonical ARPAbet phones, matching `apps/server/src/g2p.ts`'s
    `CanonicalWord` shape exactly."""

    word: str
    phones: list[str]


class PronunciationEditOp(BaseModel):
    """One detected pronunciation deviation, matching the wire contract
    `apps/server/src/pronunciation.ts` already validates against."""

    word: str
    wordIndex: int
    op: Literal["sub", "del", "ins"]
    expectedPhoneme: str | None
    spokenPhoneme: str | None


class ScoreResponse(BaseModel):
    editOps: list[PronunciationEditOp]
