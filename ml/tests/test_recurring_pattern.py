"""
Tests for ml/profiles/recurring_pattern.py — recurring-payment cadence
detection and the is_recurring_match() gate consumed by
ml/inference/predict.py, ml/inference/fusion.py, and
ml/explainability/shap_explainer.py.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ml.profiles.recurring_pattern import (
    AMOUNT_TOLERANCE_PCT,
    CadenceType,
    MIN_CONFIRMATIONS_FOR_TRUST,
    MIN_OCCURRENCES_FOR_CADENCE,
    classify_cadence,
    detect_recurring_pattern,
    is_recurring_match,
)


def _history(amounts_and_day_offsets, base=None):
    """Builds a chronological history list from (amount, day_offset) pairs."""
    base = base or datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        {"amount": amount, "timestamp": base + timedelta(days=offset)}
        for amount, offset in amounts_and_day_offsets
    ]


class TestSparseHistorySafety:
    def test_empty_history_never_raises(self):
        cluster = detect_recurring_pattern([])
        assert cluster.is_established is False
        assert cluster.occurrences == 0

    def test_single_transaction_never_raises(self):
        cluster = detect_recurring_pattern(_history([(5000.0, 0)]))
        assert cluster.is_established is False
        assert cluster.occurrences == 1

    def test_malformed_entries_are_skipped_not_raised(self):
        history = [
            {"amount": None, "timestamp": None},
            {"amount": "not-a-number", "timestamp": "not-a-date"},
            {},
        ]
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is False
        assert cluster.occurrences == 0

    def test_zero_confirmations_never_raises(self):
        cluster = detect_recurring_pattern([], confirmations_count=0)
        assert cluster.is_established is False


class TestCadenceEstablishment:
    def test_three_monthly_occurrences_establish_pattern(self):
        history = _history([(5000.0, 0), (5000.0, 30), (5000.0, 61)])
        cluster = detect_recurring_pattern(history)
        assert cluster.cadence_type == CadenceType.MONTHLY
        assert cluster.occurrences == MIN_OCCURRENCES_FOR_CADENCE
        assert cluster.is_established is True

    def test_two_monthly_occurrences_not_yet_established_without_confirmation(self):
        history = _history([(5000.0, 0), (5000.0, 30)])
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is False

    def test_weekly_cadence_detected(self):
        history = _history([(200.0, 0), (200.0, 7), (200.0, 14)])
        cluster = detect_recurring_pattern(history)
        assert cluster.cadence_type == CadenceType.WEEKLY
        assert cluster.is_established is True

    def test_biweekly_cadence_detected(self):
        history = _history([(800.0, 0), (800.0, 14), (800.0, 28)])
        cluster = detect_recurring_pattern(history)
        assert cluster.cadence_type == CadenceType.BIWEEKLY
        assert cluster.is_established is True

    def test_irregular_intervals_do_not_establish_cadence(self):
        history = _history([(5000.0, 0), (5000.0, 3), (5000.0, 55)])
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is False

    def test_amount_tolerance_boundary_just_within(self):
        # +8% on the third payment — cluster mean shifts to ~5133, keeping
        # every individual amount's deviation from that mean under 10%.
        history = _history([(5000.0, 0), (5000.0, 30), (5400.0, 60)])
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is True

    def test_amount_tolerance_boundary_just_beyond(self):
        # +30% on the third payment — cluster mean shifts to 5500, and
        # 6500's deviation from that mean (18%) exceeds AMOUNT_TOLERANCE_PCT.
        history = _history([(5000.0, 0), (5000.0, 30), (6500.0, 60)])
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is False


class TestConfirmationFastPath:
    def test_two_confirmations_establish_trust_without_cadence_history(self):
        cluster = detect_recurring_pattern([], confirmations_count=MIN_CONFIRMATIONS_FOR_TRUST)
        assert cluster.is_established is True

    def test_one_confirmation_plus_two_occurrences_establishes_trust(self):
        history = _history([(5000.0, 0), (5000.0, 30)])
        cluster = detect_recurring_pattern(history, confirmations_count=1)
        assert cluster.is_established is True

    def test_one_confirmation_alone_insufficient(self):
        cluster = detect_recurring_pattern([], confirmations_count=1)
        assert cluster.is_established is False

    def test_confirmation_fast_path_actually_matches_without_a_cadence(self):
        """Regression: is_established=True via the confirmation fast-path
        (2 confirmed payments minutes apart -- no real cadence, exactly what
        manual testing produces) must still let is_recurring_match() return
        True on a same-amount 3rd payment. Previously the function
        unconditionally required cadence_tolerance_days(cadence_type) > 0,
        which is 0 for CadenceType.NONE -- making the confirmation-only path
        permanently unreachable even though detect_recurring_pattern()
        correctly marked the cluster established."""
        history = _history([(50.0, 0), (50.0, 0)])  # same-instant, no real cadence
        cluster = detect_recurring_pattern(history, confirmations_count=2)
        assert cluster.is_established is True
        assert cluster.cadence_type == CadenceType.NONE

        features = {
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": cluster.cadence_type.value,
            "periodicity_cadence_delta": 0.0,
            "amount_deviation_from_recurring_baseline": 0.0,
        }
        assert is_recurring_match(features) is True

    def test_confirmation_fast_path_still_rejects_amount_spike(self):
        """The amount-deviation check must still apply even without a
        detected cadence -- confirmation-only trust covers the recipient,
        not an arbitrary amount."""
        features = {
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": CadenceType.NONE.value,
            "periodicity_cadence_delta": 0.0,
            "amount_deviation_from_recurring_baseline": 0.50,
        }
        assert is_recurring_match(features) is False


class TestSpikeDetection:
    def test_five_x_spike_against_established_cluster_not_a_match(self):
        history = _history([(5000.0, 0), (5000.0, 30), (5000.0, 60)])
        cluster = detect_recurring_pattern(history)
        assert cluster.is_established is True

        spike_features = {
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": cluster.cadence_type.value,
            "periodicity_cadence_delta": 1.0,
            "amount_deviation_from_recurring_baseline": abs(25000.0 - cluster.cluster_mean_amount)
            / cluster.cluster_mean_amount,
        }
        assert is_recurring_match(spike_features) is False

    def test_matching_amount_and_cadence_is_a_match(self):
        history = _history([(5000.0, 0), (5000.0, 30), (5000.0, 60)])
        cluster = detect_recurring_pattern(history)
        features = {
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": cluster.cadence_type.value,
            "periodicity_cadence_delta": 1.0,
            "amount_deviation_from_recurring_baseline": 0.01,
        }
        assert is_recurring_match(features) is True


class TestIsRecurringMatchDefaults:
    def test_missing_keys_default_to_false(self):
        assert is_recurring_match({}) is False

    def test_not_periodic_recipient_is_false(self):
        assert is_recurring_match({"is_known_periodic_recipient": 0.0}) is False

    def test_cadence_delta_outside_tolerance_is_false(self):
        features = {
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": "MONTHLY",
            "periodicity_cadence_delta": 20.0,  # far outside MONTHLY's tolerance
            "amount_deviation_from_recurring_baseline": 0.0,
        }
        assert is_recurring_match(features) is False


class TestClassifyCadence:
    @pytest.mark.parametrize(
        "days,expected",
        [
            (7, CadenceType.WEEKLY),
            (8, CadenceType.WEEKLY),
            (14, CadenceType.BIWEEKLY),
            (30, CadenceType.MONTHLY),
            (31, CadenceType.MONTHLY),
            (1, None),
            (0, None),
            (-5, None),
        ],
    )
    def test_classify_cadence(self, days, expected):
        assert classify_cadence(days) == expected
