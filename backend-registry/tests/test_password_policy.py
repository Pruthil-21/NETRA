"""app/services/password_policy_service.py -- structure and scoring approach
adapted from github.com/Pruthil-21/password-strength-analyzer, ported
in-process (see that module's own docstring for why: no online breach
check, everything self-contained)."""
import pytest
from app.services import password_policy_service


def test_rejects_a_password_shorter_than_the_minimum():
    with pytest.raises(ValueError, match="at least"):
        password_policy_service.validate_password_or_raise("Ab1!")


def test_rejects_a_common_dictionary_word():
    with pytest.raises(ValueError, match="too weak"):
        password_policy_service.validate_password_or_raise("password")


def test_scores_a_password_lower_when_it_contains_the_officers_own_badge_number():
    with_context = password_policy_service.analyze_password("GJ-SO-001-2026", user_inputs=["GJ-SO-001"])
    without_context = password_policy_service.analyze_password("GJ-SO-001-2026", user_inputs=[])
    assert with_context["score"] <= without_context["score"]


def test_accepts_a_genuinely_strong_passphrase():
    # Should not raise.
    password_policy_service.validate_password_or_raise("Correct-Horse-Battery-Staple-9!")


def test_analyze_password_flags_keyboard_walk_and_sequential_patterns():
    keyboard = password_policy_service.analyze_password("qwertyuiop123")
    assert any("keyboard-walk" in w for w in keyboard["weaknesses"])

    sequential = password_policy_service.analyze_password("abcdefgh123")
    assert any("sequential" in w for w in sequential["weaknesses"])


def test_analyze_password_reports_a_meets_requirements_flag():
    weak = password_policy_service.analyze_password("short")
    assert weak["meets_requirements"] is False

    strong = password_policy_service.analyze_password("Correct-Horse-Battery-Staple-9!")
    assert strong["meets_requirements"] is True
