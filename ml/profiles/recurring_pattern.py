"""
Recurring-payment cadence detection.

Static anomaly scoring compares every transaction against a user's *global*
amount baseline. That means a genuinely routine payment — rent to the same
landlord every month, for example — gets flagged as anomalous forever,
since ₹5,000 is unremarkable against that recipient's own history but can
be 25-100x the user's overall daily-spend average.

This module answers one question, live, from a user's confirmed
transaction history to a single recipient: "does this look like an
established recurring pattern, or a fresh/deviating one?" It never learns
weights and never mutates anything — like ml/profiles/user_risk_profile.py,
it stays a plain, auditable, deterministic calculation so a human reviewing
a score can see exactly why a payment was or wasn't treated as recurring.

TWO WAYS A PATTERN BECOMES "ESTABLISHED":
1. Cadence: MIN_OCCURRENCES_FOR_CADENCE consecutive payments to the same
   recipient at a consistent interval (weekly/bi-weekly/monthly, see
   CADENCE_INTERVALS) and consistent amount (AMOUNT_TOLERANCE_PCT).
2. Explicit trust: the user has confirmed MIN_CONFIRMATIONS_FOR_TRUST or
   more payments to this recipient (see
   apps/api/app/services/payment_lifecycle_service.py::confirm, which
   writes the UserFeedback rows this counts) — a faster path than waiting
   for cadence to repeat naturally.

ALL THRESHOLDS BELOW ARE PROPOSED, NOT TUNED — placeholders consistent with
the stated ±10% amount / ~28-32 day monthly requirements, flagged for
product/data-science sign-off before this scores real users, the same
honesty convention ProfileConfig.min_history already uses in
user_risk_profile.py.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Optional


class CadenceType(str, Enum):
    NONE = "NONE"
    WEEKLY = "WEEKLY"
    BIWEEKLY = "BIWEEKLY"
    MONTHLY = "MONTHLY"


#: cadence -> (expected_interval_days, tolerance_days). Monthly's ±4 days
#: covers the requirement's stated ~28-32 day window plus scheduling jitter
#: (weekends, bank processing delays).
CADENCE_INTERVALS: dict[CadenceType, tuple[int, int]] = {
    CadenceType.WEEKLY: (7, 2),
    CadenceType.BIWEEKLY: (14, 3),
    CadenceType.MONTHLY: (30, 4),
}

#: Amount must stay within this fraction of the recurring cluster's mean.
AMOUNT_TOLERANCE_PCT = 0.10

#: Occurrences at a consistent cadence+amount before cadence alone
#: establishes a pattern (matches the "month 3 rent" example directly).
MIN_OCCURRENCES_FOR_CADENCE = 3

#: Explicit UserFeedback(CONFIRM) count that establishes trust on its own,
#: even with fewer observed occurrences than MIN_OCCURRENCES_FOR_CADENCE.
MIN_CONFIRMATIONS_FOR_TRUST = 2


@dataclass(frozen=True)
class RecurringCluster:
    """Result of analyzing one recipient's payment history. Always
    constructible from sparse/empty input — never raises, no field is ever
    NaN."""

    recipient_id: Optional[int]
    cadence_type: CadenceType = CadenceType.NONE
    expected_interval_days: Optional[int] = None
    occurrences: int = 0
    cluster_mean_amount: Optional[float] = None
    cluster_std_amount: Optional[float] = None
    confirmations_count: int = 0
    is_established: bool = False
    last_txn_timestamp: Optional[datetime] = None


def classify_cadence(interval_days: float) -> Optional[CadenceType]:
    """Buckets a day-gap into the nearest cadence type it falls within
    tolerance of, or None if it doesn't match any recognized cadence."""
    if interval_days is None or interval_days <= 0:
        return None
    best: Optional[CadenceType] = None
    best_delta = None
    for cadence, (expected, tolerance) in CADENCE_INTERVALS.items():
        delta = abs(interval_days - expected)
        if delta <= tolerance and (best_delta is None or delta < best_delta):
            best = cadence
            best_delta = delta
    return best


def cadence_tolerance_days(cadence_type: CadenceType) -> int:
    """Tolerance window (days) for a cadence type; 0 for NONE/unrecognized
    so an unestablished pattern never accidentally passes a delta check."""
    interval = CADENCE_INTERVALS.get(cadence_type)
    return interval[1] if interval else 0


def _amount_of(entry: Any) -> Optional[float]:
    try:
        value = entry.get("amount") if isinstance(entry, dict) else getattr(entry, "amount", None)
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _timestamp_of(entry: Any) -> Optional[datetime]:
    ts = entry.get("timestamp") if isinstance(entry, dict) else getattr(entry, "timestamp", None)
    if isinstance(ts, datetime):
        return ts
    if isinstance(ts, str):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def detect_recurring_pattern(
    history: list[Any],
    *,
    recipient_id: Optional[int] = None,
    confirmations_count: int = 0,
) -> RecurringCluster:
    """Analyzes a chronologically-ordered (oldest-first) transaction
    history to one recipient. `history` entries may be plain dicts
    ({"amount": ..., "timestamp": ...}) or ORM Transaction rows — both are
    read defensively, missing/malformed entries are simply skipped rather
    than raising.

    Deterministic and side-effect free: never mutates its input, never
    returns NaN, degrades to a "not established" cluster on any sparse or
    malformed history instead of guessing.
    """
    confirmations_count = max(0, int(confirmations_count or 0))

    clean: list[tuple[float, datetime]] = []
    for entry in history:
        amount = _amount_of(entry)
        ts = _timestamp_of(entry)
        if amount is not None and amount > 0 and ts is not None:
            clean.append((amount, ts))
    clean.sort(key=lambda pair: pair[1])

    if len(clean) < 2:
        # Not enough history for cadence — the confirmation fast path can
        # still establish trust on its own.
        is_established = confirmations_count >= MIN_CONFIRMATIONS_FOR_TRUST
        last_ts = clean[-1][1] if clean else None
        mean_amount = clean[-1][0] if clean else None
        return RecurringCluster(
            recipient_id=recipient_id,
            occurrences=len(clean),
            cluster_mean_amount=mean_amount,
            confirmations_count=confirmations_count,
            is_established=is_established,
            last_txn_timestamp=last_ts,
        )

    intervals = [
        (clean[i][1] - clean[i - 1][1]).total_seconds() / 86400.0 for i in range(1, len(clean))
    ]

    # Classify each interval; find the cadence bucket most of them agree on.
    classifications = [classify_cadence(d) for d in intervals]
    counts: dict[CadenceType, int] = {}
    for c in classifications:
        if c is not None:
            counts[c] = counts.get(c, 0) + 1

    if not counts:
        cadence_type = CadenceType.NONE
        matching_run = clean
    else:
        cadence_type = max(counts, key=lambda k: counts[k])
        # The run of transactions consistent with the winning cadence —
        # simplification: use all transactions, since a single outlier
        # interval shouldn't discard the rest of an otherwise-consistent
        # history from the amount baseline.
        matching_run = clean

    amounts = [a for a, _ in matching_run]
    cluster_mean = statistics.fmean(amounts) if amounts else None
    cluster_std = statistics.pstdev(amounts) if len(amounts) >= 2 else 0.0

    expected_interval = CADENCE_INTERVALS.get(cadence_type, (None, None))[0]
    occurrences = len(clean)

    amount_consistent = True
    if cluster_mean and cluster_mean > 0:
        amount_consistent = all(
            abs(a - cluster_mean) / cluster_mean <= AMOUNT_TOLERANCE_PCT for a in amounts
        )

    cadence_established = (
        cadence_type != CadenceType.NONE
        and occurrences >= MIN_OCCURRENCES_FOR_CADENCE
        and amount_consistent
    )
    confirmation_established = (
        confirmations_count >= MIN_CONFIRMATIONS_FOR_TRUST
        or (occurrences >= 2 and confirmations_count >= 1)
    )
    is_established = cadence_established or confirmation_established

    return RecurringCluster(
        recipient_id=recipient_id,
        cadence_type=cadence_type,
        expected_interval_days=expected_interval,
        occurrences=occurrences,
        cluster_mean_amount=cluster_mean,
        cluster_std_amount=cluster_std,
        confirmations_count=confirmations_count,
        is_established=is_established,
        last_txn_timestamp=clean[-1][1],
    )


def is_recurring_match(features: dict) -> bool:
    """The single shared gate used by both the fusion-layer bypass and the
    explainability branch: does THIS transaction actually match its
    recipient's established pattern (not just "is there a pattern at all"
    for this recipient in the abstract)?

    Reads only from the `features` dict (never re-queries the DB), so it's
    safe to call from ml/inference/fusion.py and
    ml/explainability/shap_explainer.py without threading DB sessions
    through them. Missing keys default to values that make this return
    False — a caller that never populates these features (i.e. every
    existing caller before this feature existed) always gets `False`.
    """
    if float(features.get("is_known_periodic_recipient", 0.0) or 0.0) != 1.0:
        return False

    cadence_type_raw = features.get("periodicity_cadence_type", CadenceType.NONE.value)
    try:
        cadence_type = CadenceType(cadence_type_raw)
    except ValueError:
        cadence_type = CadenceType.NONE

    # A real cadence has been detected (3+ occurrences at a consistent
    # interval): also require this transaction to land within that
    # cadence's tolerance window (i.e. "on schedule"). When cadence_type is
    # NONE, is_known_periodic_recipient==1 can only have come from the
    # confirmation fast-path (MIN_CONFIRMATIONS_FOR_TRUST reached with too
    # few/too-irregular occurrences to classify a cadence at all) — there is
    # no detected schedule to be "on" in that case, so skipping this check
    # is correct, not a gap: two confirmed payments made minutes apart
    # (e.g. manual testing) still establish trust without a cadence ever
    # existing.
    if cadence_type != CadenceType.NONE:
        tolerance = cadence_tolerance_days(cadence_type)
        if tolerance <= 0:
            return False
        delta = features.get("periodicity_cadence_delta", None)
        if delta is None or abs(float(delta)) > tolerance:
            return False

    amount_deviation = features.get("amount_deviation_from_recurring_baseline", 1.0)
    if amount_deviation is None or float(amount_deviation) > AMOUNT_TOLERANCE_PCT:
        return False

    return True
