from schemas import CanonicalWord

# Every ARPAbet phone g2p.ts's HUPER_VALID_PHONES set may produce (see
# apps/server/src/g2p.ts), plus DX (the flap allophone HuPER's own output vocabulary includes even
# though g2p never targets it directly — see models.py's acceptable_realizations), mapped to its
# corresponding symbol in facebook/wav2vec2-xlsr-53-espeak-cv-ft's IPA vocabulary. Verified against
# that model's actual vocab.json, not assumed from general IPA knowledge. Every entry is a single
# symbol — this vocabulary already has dedicated single-token symbols for every English diphthong
# ARPAbet uses, so no two-phone onset/offset expansion is needed.
ARPABET_TO_IPA: dict[str, str] = {
    "AA": "ɑː",
    "AE": "æ",
    # g2p.ts strips stress digits, so AH covers both the stressed vowel /ʌ/ and the reduced vowel
    # /ə/ — /ʌ/ is AH's primary (citation-form) identity, chosen as the single mapping here.
    "AH": "ʌ",
    "AW": "aʊ",
    "AY": "aɪ",
    "B": "b",
    "CH": "tʃ",
    "D": "d",
    "DH": "ð",
    "DX": "ɾ",
    "EH": "ɛ",
    "ER": "ɚ",
    "EY": "eɪ",
    "F": "f",
    "G": "ɡ",
    "HH": "h",
    "IH": "ɪ",
    "IY": "iː",
    "JH": "dʒ",
    "K": "k",
    "L": "l",
    "M": "m",
    "N": "n",
    "NG": "ŋ",
    "OW": "oʊ",
    "OY": "ɔɪ",
    "P": "p",
    # The canonical English approximant, not the trill "r" — see
    # test_to_ipa_phones_maps_r_to_the_english_approximant_not_the_trill in
    # tests/test_arpabet_to_ipa.py for why this direction matters.
    "R": "ɹ",
    "S": "s",
    "SH": "ʃ",
    "T": "t",
    "TH": "θ",
    "UH": "ʊ",
    "UW": "uː",
    "V": "v",
    "W": "w",
    "Y": "j",
    "Z": "z",
    "ZH": "ʒ",
}


def to_ipa_phones(canonical_phones: list[CanonicalWord]) -> list[CanonicalWord]:
    """Rewrites each word's ARPAbet phones into facebook/wav2vec2-xlsr-53-espeak-cv-ft's IPA
    symbols, for scoring canonical phones against that model instead of HuPER. Raises ValueError
    on any phone absent from ARPABET_TO_IPA, matching score_pronunciation's own fail-loud
    convention for out-of-vocabulary phones rather than silently dropping or passing one through.
    """
    mapped = []
    for word in canonical_phones:
        ipa_phones = []
        for phone in word.phones:
            if phone not in ARPABET_TO_IPA:
                raise ValueError(f"no IPA mapping for ARPAbet phone {phone!r}")
            ipa_phones.append(ARPABET_TO_IPA[phone])
        mapped.append(CanonicalWord(word=word.word, phones=ipa_phones))
    return mapped
