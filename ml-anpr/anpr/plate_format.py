"""Indian-plate format rules, OCR confusion correction, and the string
similarity helpers used to cluster noisy readings of the same plate."""
import re

INDIAN_PLATE_PATTERN = re.compile(r'^[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}$')

_DIGIT_TO_LETTER = {'0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G'}
_LETTER_TO_DIGIT = {v: k for k, v in _DIGIT_TO_LETTER.items()}

# All current Indian state/UT registration codes (Wikipedia, "Vehicle
# registration plates of India", cross-checked against Parivahan's own
# code list). INDIAN_PLATE_PATTERN only checks character *class*
# (letter/letter/digit/digit/...), not whether the first two letters are
# a real code -- so a structurally-valid string with a nonexistent code
# (e.g. "GI23CG2045", "OO76N6774") passes it untouched. See
# _correct_state_code() below.
VALID_STATE_CODES = {
    'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'GA', 'GJ', 'HP',
    'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ',
    'NL', 'OD', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'UK', 'UP', 'WB',
}

# Deliberately narrow -- only I<->J is added here, and only because it's
# evidenced, not theorized: the plate-detector crop path (269-frame Anand
# CCTV eval) produced this exact GJ->GI misread on the same box/frame 3
# separate times, all landing in the strict pattern-match tier with an
# invalid "GI" prefix. Not extended to other visually-similar letter
# pairs without the same kind of direct evidence.
_LETTER_CONFUSABLES = {'I': 'J', 'J': 'I'}


def _correct_state_code(plate):
    """
    plate is assumed to already match INDIAN_PLATE_PATTERN. If its
    2-letter state code is a real one, returns plate unchanged. If not,
    but a single I<->J swap at either letter position would make it
    real, returns the corrected plate. Otherwise returns None -- signals
    "this pattern-matched string has an unrecognized state code and no
    known fix", so callers can demote it to the fallback tier instead of
    trusting a structurally-valid-but-nonexistent code at face value.
    """
    code = plate[:2]
    if code in VALID_STATE_CODES:
        return plate
    for i in (0, 1):
        c = code[i]
        if c in _LETTER_CONFUSABLES:
            fixed_code = code[:i] + _LETTER_CONFUSABLES[c] + code[i + 1:]
            if fixed_code in VALID_STATE_CODES:
                return fixed_code + plate[2:]
    return None


def _correct_plate_positions(cleaned):
    """
    Indian plates have fixed character-class positions: letters, then
    digits, then letters, then digits. OCR commonly confuses
    visually-similar letter/digit pairs (O/0, I/1, Z/2, S/5, B/8, G/6) --
    confirmed directly against ground truth on car2.jpg (HR2OAG3739 vs
    real HR20AG3739) and car3.jpg (MHZODV2366 vs real MH20DV2366), both
    single wrong-type characters at digit positions. If a cleaned OCR
    string is exactly plate-length but has a wrong-type character at a
    fixed position, try correcting it via the known confusion map, and
    only accept the correction if the result then matches the strict
    pattern -- so this can't turn arbitrary text into a fake plate, only
    recover a plate that was one confusable character away from matching.
    """
    for total_len, letter_run in ((10, 2), (9, 1)):
        if len(cleaned) != total_len:
            continue
        expected = ['L', 'L', 'D', 'D'] + ['L'] * letter_run + ['D'] * 4
        chars = list(cleaned)
        changed = False
        for i, kind in enumerate(expected):
            c = chars[i]
            if kind == 'D' and c in _LETTER_TO_DIGIT:
                chars[i] = _LETTER_TO_DIGIT[c]
                changed = True
            elif kind == 'L' and c in _DIGIT_TO_LETTER:
                chars[i] = _DIGIT_TO_LETTER[c]
                changed = True
        if changed:
            candidate = ''.join(chars)
            if INDIAN_PLATE_PATTERN.match(candidate):
                return candidate
    return None


def _edit_similarity(a, b):
    """Normalized edit-distance similarity (1.0 = identical). Tolerant of
    both character substitution (motion blur misreading one character as
    another) AND length differences (OCR dropping/inserting a character
    on a harder read of the same real plate) — same-length-only matching
    missed real repeat plates that read as slightly different lengths."""
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    dp = list(range(lb + 1))
    for i in range(1, la + 1):
        prev, dp[0] = dp[0], i
        for j in range(1, lb + 1):
            prev, dp[j] = dp[j], min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] != b[j - 1]))
    return 1 - dp[lb] / max(la, lb)


def _containment_similarity(short, long_):
    """Best contiguous-window character match of `short` inside `long_`,
    normalized by the short string's own length. Catches truncated reads
    (a plate partially cut off at the edge of a crop, or OCR just not
    extending across the full width) — a 7-character prefix of an
    11-character plate is a perfect read as far as it goes, but plain
    edit-distance similarity is capped by the length gap alone and can
    never clear a reasonable clustering threshold."""
    ls, ll = len(short), len(long_)
    if ls == 0 or ls > ll:
        return 0.0
    return max(
        sum(1 for x, y in zip(short, long_[start:start + ls]) if x == y) / ls
        for start in range(ll - ls + 1)
    )


def _plate_similarity(a, b):
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    return max(_edit_similarity(a, b), _containment_similarity(shorter, longer))
