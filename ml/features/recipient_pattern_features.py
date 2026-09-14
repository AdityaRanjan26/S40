"""
Recipient Pattern Feature Extractor for S40 Fraud Shield.

Computes recurring-payment/cadence-recognition features for the CURRENT
transaction against ONE recipient's confirmed payment history — the
runtime counterpart to ml/profiles/recurring_pattern.py's pure detection
logic. Same dict-in/dict-out convention as
ml/features/behaviour_features.py::BehaviourFeatureExtractor (a sibling
extractor, not a replacement — existing extractors are untouched and this
is merged into the same `features` dict alongside them, see
ml/inference/predict.py).

Never raises, never returns NaN: any missing/malformed input degrades to
values that keep is_recurring_match() (recurring_pattern.py) returning
False, i.e. "treat this as a fresh, non-recurring transaction" — the safe
default.
"""

from typing import Any, Dict, List

from ml.profiles.recurring_pattern import CadenceType, detect_recurring_pattern


class RecipientPatternFeatureExtractor:
    """Extracts recurring-cadence recognition features by comparing the
    active payload against this recipient's confirmed transaction
    history."""

    FEATURE_NAMES = [
        "is_known_periodic_recipient",
        "periodicity_cadence_delta",
        "amount_deviation_from_recurring_baseline",
        "historical_user_confirmations_for_recipient",
        "periodicity_cadence_type",
    ]

    def extract_features(
        self, transaction: Dict[str, Any], user_profile: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Args:
            transaction: current transaction payload (amount, timestamp, recipient_id).
            user_profile: must carry `recipient_history` (list of
                {amount, timestamp} for this recipient, oldest first —
                populated by app/services/risk_service.py via
                transaction_repository.get_transactions_for_recipient) and
                `recipient_confirmations` (int count from
                user_feedback_repository.count_confirmations_for_recipient).
                Both default to empty/zero when absent.

        Returns:
            Dict of the 5 recipient-pattern features (4 requested +
            periodicity_cadence_type plumbing — see module docstring).
        """
        try:
            history: List[Any] = user_profile.get("recipient_history") or []
            confirmations = int(user_profile.get("recipient_confirmations", 0) or 0)
            recipient_id = transaction.get("recipient_db_id")

            cluster = detect_recurring_pattern(
                history, recipient_id=recipient_id, confirmations_count=confirmations
            )

            amount = float(transaction.get("amount", 0.0) or 0.0)
            current_ts = transaction.get("timestamp")

            # Days since the last recorded payment to this recipient, vs.
            # the cadence's expected interval — how far off-schedule this
            # transaction is. Falls back to 0.0 (never flags a delay) when
            # there's no established interval to compare against; safe
            # because every consumer gates on is_known_periodic_recipient
            # first (see is_recurring_match).
            cadence_delta = 0.0
            if cluster.is_established and cluster.expected_interval_days and cluster.last_txn_timestamp:
                from datetime import datetime

                parsed_now = None
                if isinstance(current_ts, str):
                    try:
                        parsed_now = datetime.fromisoformat(current_ts.replace("Z", "+00:00"))
                    except ValueError:
                        parsed_now = None
                elif isinstance(current_ts, datetime):
                    parsed_now = current_ts

                if parsed_now is not None:
                    last = cluster.last_txn_timestamp
                    if last.tzinfo is None and parsed_now.tzinfo is not None:
                        parsed_now = parsed_now.replace(tzinfo=None)
                    elif last.tzinfo is not None and parsed_now.tzinfo is None:
                        last = last.replace(tzinfo=None)
                    days_since = abs((parsed_now - last).total_seconds()) / 86400.0
                    cadence_delta = abs(days_since - cluster.expected_interval_days)

            # Fallback 1.0 (fully off-baseline) rather than 0.0 — never
            # silently reads as "exactly on-baseline" when there's nothing
            # to compare against.
            amount_deviation = 1.0
            if cluster.is_established and cluster.cluster_mean_amount and cluster.cluster_mean_amount > 0:
                amount_deviation = abs(amount - cluster.cluster_mean_amount) / cluster.cluster_mean_amount

            return {
                "is_known_periodic_recipient": 1.0 if cluster.is_established else 0.0,
                "periodicity_cadence_delta": float(cadence_delta),
                "amount_deviation_from_recurring_baseline": float(amount_deviation),
                "historical_user_confirmations_for_recipient": float(confirmations),
                "periodicity_cadence_type": (
                    cluster.cadence_type.value
                    if isinstance(cluster.cadence_type, CadenceType)
                    else str(cluster.cadence_type)
                ),
            }
        except Exception:
            # Defensive catch-all: a malformed history must never break
            # scoring for the rest of the transaction — degrade to
            # "not recurring" instead of raising.
            return {
                "is_known_periodic_recipient": 0.0,
                "periodicity_cadence_delta": 0.0,
                "amount_deviation_from_recurring_baseline": 1.0,
                "historical_user_confirmations_for_recipient": 0.0,
                "periodicity_cadence_type": CadenceType.NONE.value,
            }
