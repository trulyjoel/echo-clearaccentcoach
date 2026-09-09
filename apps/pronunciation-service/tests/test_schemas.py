from typing import Any, cast

import pytest
from pydantic import ValidationError

from schemas import CanonicalWord, PronunciationEditOp, ScoreResponse


def test_canonical_word_round_trips():
    word = CanonicalWord(word="like", phones=["L", "AY", "K"])
    assert word.word == "like"
    assert word.phones == ["L", "AY", "K"]


def test_pronunciation_edit_op_allows_null_expected_phoneme_for_insertion():
    op = PronunciationEditOp(
        word="like", wordIndex=0, op="ins", expectedPhoneme=None, spokenPhoneme="AH"
    )
    assert op.expectedPhoneme is None


def test_pronunciation_edit_op_rejects_unknown_op():
    with pytest.raises(ValidationError):
        PronunciationEditOp(
            word="like",
            wordIndex=0,
            op=cast(Any, "bogus"),
            expectedPhoneme="L",
            spokenPhoneme="R",
        )


def test_score_response_serializes_edit_ops_list():
    response = ScoreResponse(
        editOps=[
            PronunciationEditOp(
                word="like", wordIndex=0, op="sub", expectedPhoneme="L", spokenPhoneme="R"
            )
        ]
    )
    assert response.model_dump() == {
        "editOps": [
            {
                "word": "like",
                "wordIndex": 0,
                "op": "sub",
                "expectedPhoneme": "L",
                "spokenPhoneme": "R",
            }
        ]
    }
