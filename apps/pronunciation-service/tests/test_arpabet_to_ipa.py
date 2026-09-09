import pytest

from arpabet_to_ipa import to_ipa_phones
from schemas import CanonicalWord


def test_to_ipa_phones_maps_a_plain_consonant_and_vowel():
    canonical = [CanonicalWord(word="dog", phones=["D", "AA", "G"])]

    result = to_ipa_phones(canonical)

    assert result == [CanonicalWord(word="dog", phones=["d", "ɑː", "ɡ"])]


def test_to_ipa_phones_maps_a_diphthong_to_its_single_ipa_symbol():
    # AY has a dedicated single-token IPA symbol in this vocabulary (aɪ) — not a two-phone
    # onset/offset expansion, confirmed against the model's own vocab.json.
    canonical = [CanonicalWord(word="high", phones=["HH", "AY"])]

    result = to_ipa_phones(canonical)

    assert result == [CanonicalWord(word="high", phones=["h", "aɪ"])]


def test_to_ipa_phones_maps_r_to_the_english_approximant_not_the_trill():
    # The canonical/expected phone must be the standard American English approximant ɹ — the
    # entire point of this comparison model is noticing when the audio's actual phone is the
    # "wrong" trill/tap/uvular alternative instead. Confirmed against this model's own vocab.json:
    # ɹ and r (trill) are separate symbols.
    canonical = [CanonicalWord(word="red", phones=["R", "EH", "D"])]

    result = to_ipa_phones(canonical)

    assert result[0].phones[0] == "ɹ"


def test_to_ipa_phones_preserves_word_boundaries_across_multiple_words():
    canonical = [
        CanonicalWord(word="hi", phones=["HH", "AY"]),
        CanonicalWord(word="there", phones=["DH", "EH", "R"]),
    ]

    result = to_ipa_phones(canonical)

    assert [w.word for w in result] == ["hi", "there"]
    assert result[1].phones == ["ð", "ɛ", "ɹ"]


def test_to_ipa_phones_handles_a_word_with_no_phones():
    canonical = [CanonicalWord(word="", phones=[])]

    assert to_ipa_phones(canonical) == [CanonicalWord(word="", phones=[])]


def test_to_ipa_phones_raises_for_a_phone_not_in_the_table():
    canonical = [CanonicalWord(word="x", phones=["ZZZ"])]

    with pytest.raises(ValueError, match="ZZZ"):
        to_ipa_phones(canonical)
