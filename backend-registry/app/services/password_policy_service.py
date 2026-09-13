"""Password strength analysis and enforcement -- structure and scoring
approach adapted from github.com/Pruthil-21/password-strength-analyzer
(zxcvbn-based scoring, entropy, structural weakness detection), ported
in-process here rather than called out to since this is the one place in
the app a password is ever set (registration, self-service reset, admin
reset, change-password) and there's no reason to make any of those pay a
network hop for it.

Deliberately does NOT do an online breach check (the reference repo's
breach.py, using HaveIBeenPwned's k-anonymity API) -- this is a
law-enforcement deployment, and this project's own stance elsewhere
(see the ANPR VLM fallback) is that nothing about an officer's
credentials should leave the machine over a third-party API, even a
privacy-preserving one. The structural/entropy checks below need no
network access at all.
"""
import math
import re

from zxcvbn import zxcvbn

# Below this, a password is rejected outright regardless of anything else
# -- zxcvbn's own 0-4 score already accounts for length, common passwords,
# dictionary words and simple patterns, so this is a floor, not the whole
# policy. 2 ("Fair") turns away anything zxcvbn itself would call weak or
# very weak.
MIN_ZXCVBN_SCORE = 2
MIN_LENGTH = 8

_SEQUENCES = ["abcdefghijklmnopqrstuvwxyz", "0123456789"]
_KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"]


def _character_pool(password: str) -> int:
    pool = 0
    if any(c.islower() for c in password):
        pool += 26
    if any(c.isupper() for c in password):
        pool += 26
    if any(c.isdigit() for c in password):
        pool += 10
    if any(not c.isalnum() for c in password):
        pool += 32
    return pool


def _entropy_bits(password: str) -> float:
    if not password:
        return 0.0
    pool = _character_pool(password)
    if pool == 0:
        return 0.0
    return round(len(password) * math.log2(pool), 2)


def _has_sequential(password: str) -> bool:
    lowered = password.lower()
    for seq in _SEQUENCES:
        rev = seq[::-1]
        for i in range(len(seq) - 2):
            if seq[i:i + 3] in lowered or rev[i:i + 3] in lowered:
                return True
    return False


def _has_repeated(password: str) -> bool:
    return bool(re.search(r"(.)\1{2,}", password))


def _has_keyboard_pattern(password: str, min_run: int = 4) -> bool:
    lowered = password.lower()
    for row in _KEYBOARD_ROWS:
        rev = row[::-1]
        for i in range(len(row) - min_run + 1):
            if row[i:i + min_run] in lowered or rev[i:i + min_run] in lowered:
                return True
    return False


def _weaknesses(password: str) -> list[str]:
    out = []
    if len(password) < MIN_LENGTH:
        out.append(f"Shorter than the required minimum of {MIN_LENGTH} characters.")
    if not re.search(r"[A-Z]", password):
        out.append("No uppercase letters.")
    if not re.search(r"[a-z]", password):
        out.append("No lowercase letters.")
    if not re.search(r"\d", password):
        out.append("No numeric digits.")
    if not re.search(r"[^A-Za-z0-9]", password):
        out.append("No special characters.")
    if _has_sequential(password):
        out.append("Contains a sequential run (e.g. 'abc', '321').")
    if _has_repeated(password):
        out.append("Contains a character repeated three or more times in a row.")
    if _has_keyboard_pattern(password):
        out.append("Contains a keyboard-walk pattern (e.g. 'qwerty', '1qaz').")
    return out


_LEVELS = {0: "Very Weak", 1: "Weak", 2: "Fair", 3: "Strong", 4: "Very Strong"}


def analyze_password(password: str, user_inputs: list[str] | None = None) -> dict:
    """Full analysis -- used both to render a live strength meter and as
    the basis for validate_password_or_raise's pass/fail decision.
    user_inputs (badge number, name, email) are fed to zxcvbn so it can
    penalize a password built from the officer's own identifying details,
    the same way it already penalizes dictionary words."""
    result = zxcvbn(password, user_inputs=user_inputs or [])
    score = result["score"]
    weaknesses = _weaknesses(password)
    entropy = _entropy_bits(password)

    return {
        "score": score,
        "strength": _LEVELS[score],
        "entropy": entropy,
        "crack_time": result["crack_times_display"]["offline_slow_hashing_1e4_per_second"],
        "weaknesses": weaknesses,
        "meets_requirements": len(password) >= MIN_LENGTH and score >= MIN_ZXCVBN_SCORE,
    }


def validate_password_or_raise(password: str, user_inputs: list[str] | None = None) -> None:
    """Raises ValueError with a caller-facing reason if the password falls
    below the minimum bar. Callers turn this into a 400 -- kept as a plain
    ValueError (not an HTTPException) so this module has no FastAPI
    dependency and stays testable/reusable on its own."""
    if len(password) < MIN_LENGTH:
        raise ValueError(f"Password must be at least {MIN_LENGTH} characters.")
    analysis = analyze_password(password, user_inputs=user_inputs)
    if analysis["score"] < MIN_ZXCVBN_SCORE:
        reason = analysis["weaknesses"][0] if analysis["weaknesses"] else "This password is too easy to guess."
        raise ValueError(f"Password is too weak ({analysis['strength']}). {reason}")
