"""
Feature computation engine.

Single chronological pass. For each transaction, features are computed
against the state accumulated from *strictly earlier* transactions, and
only then is that transaction folded into the state. This ordering is the
structural guarantee against temporal leakage — there is no code path that
can see a future row, because future rows have not been processed yet.

That is a deliberate trade against vectorised pandas operations, which are
faster but make it very easy to accidentally compute a statistic over the
whole column (including the future) and then use it per-row. At S40's
prototype scale correctness is worth far more than the speed difference.

Features whose inputs the canonical data cannot supply are NOT computed
and NOT imputed. They are listed in UNAVAILABLE_SPEC_FEATURES so the gap
stays visible.
"""

from __future__ import annotations

from collections import defaultdict

import pandas as pd

from ml.data.canonical import Availability, CanonicalColumn as C, FeatureAvailability
from ml.features.base import (
    FeatureGroup as G,
    FeatureSpec,
    LeakageRisk,
    UnavailableFeature,
)
from ml.profiles.user_risk_profile import ProfileConfig, UserRiskProfile

FEATURE_SPECS: tuple[FeatureSpec, ...] = (
    FeatureSpec(
        name="amount_zscore",
        group=G.BEHAVIOUR,
        source="spec §6.1, §6.3",
        calculation="(amount - user's prior mean) / user's prior std",
        required_inputs=(C.USER_ID.value, C.AMOUNT.value),
        missing_behaviour=(
            "None when the profile is cold (<min_history) or prior spend has no "
            "variance. Never defaulted to 0, which would read as 'perfectly normal'."
        ),
        leakage=LeakageRisk.SAFE,
        leakage_note="Mean/std computed from strictly prior transactions only.",
    ),
    FeatureSpec(
        name="amount_vs_average",
        group=G.BEHAVIOUR,
        source="spec §6.1 (amount_vs_average), §14 ('7.2x higher than normal')",
        calculation="amount / user's prior mean",
        required_inputs=(C.USER_ID.value, C.AMOUNT.value),
        missing_behaviour="None when cold or prior mean is zero.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="transactions_last_10m",
        group=G.TEMPORAL,
        source="spec §6.1",
        calculation="Count of the user's prior transactions in the trailing 600s",
        required_inputs=(C.USER_ID.value, C.TIMESTAMP.value),
        missing_behaviour="None when the dataset has no wall-clock timestamp.",
        leakage=LeakageRisk.SAFE,
        leakage_note="Trailing window is strictly backward-looking.",
    ),
    FeatureSpec(
        name="transactions_last_1h",
        group=G.TEMPORAL,
        source="spec §6.1",
        calculation="Count of the user's prior transactions in the trailing 3600s",
        required_inputs=(C.USER_ID.value, C.TIMESTAMP.value),
        missing_behaviour="None when the dataset has no wall-clock timestamp.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="recipient_seen_before",
        group=G.RECIPIENT,
        source="spec §6.1",
        calculation="1 if the user has paid this recipient before, else 0",
        required_inputs=(C.USER_ID.value, C.RECIPIENT_ID.value),
        missing_behaviour="None when the dataset has no recipient concept (e.g. IEEE-CIS).",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="recipient_frequency",
        group=G.RECIPIENT,
        source="spec §6.1",
        calculation="Prior payments to this recipient / user's prior transactions",
        required_inputs=(C.USER_ID.value, C.RECIPIENT_ID.value),
        missing_behaviour="None when recipient is absent or the user has no history.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="time_of_day_deviation",
        group=G.TEMPORAL,
        source="spec §6.1, §6.3 (time_deviation)",
        calculation="1 - (share of the user's prior activity in this hour of day)",
        required_inputs=(C.USER_ID.value, C.TIMESTAMP.value),
        missing_behaviour="None when cold or no timestamp.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="new_device",
        group=G.DEVICE,
        source="spec §6.2",
        calculation="1 if this device is unseen for this user, else 0",
        required_inputs=(C.USER_ID.value, C.DEVICE_ID.value),
        missing_behaviour="None when the dataset has no device concept (e.g. PaySim).",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="device_account_count",
        group=G.DEVICE,
        source="spec §6.2, §41",
        calculation="Distinct users seen on this device so far",
        required_inputs=(C.USER_ID.value, C.DEVICE_ID.value),
        missing_behaviour="None when device is absent.",
        leakage=LeakageRisk.SAFE,
        leakage_note=(
            "Counts only associations observed before this row. A whole-dataset "
            "count would leak future device sharing."
        ),
    ),
    FeatureSpec(
        name="location_deviation",
        group=G.BEHAVIOUR,
        source="spec §6.3",
        calculation="1 if this location is unseen for this user, else 0",
        required_inputs=(C.USER_ID.value, C.LOCATION.value),
        missing_behaviour="None when the dataset has no location.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="seconds_since_last_transaction",
        group=G.TEMPORAL,
        source="spec §6.1 (transaction velocity), §6.3 (velocity_deviation)",
        calculation="Seconds between this transaction and the user's previous one",
        required_inputs=(C.USER_ID.value, C.TIMESTAMP.value),
        missing_behaviour="None for a user's first transaction or when no timestamp.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="user_transaction_count",
        group=G.TRANSACTION,
        source="spec §7 (User Risk Profile context)",
        calculation="Number of prior transactions observed for this user",
        required_inputs=(C.USER_ID.value,),
        missing_behaviour="0 for an unseen user — a true count, not an imputation.",
        leakage=LeakageRisk.SAFE,
    ),
    FeatureSpec(
        name="profile_is_cold",
        group=G.TRANSACTION,
        source="Phase 3 brief (cold-start behaviour must be explicit)",
        calculation="1 if the user's profile has < min_history observations",
        required_inputs=(C.USER_ID.value,),
        missing_behaviour="Always computable.",
        leakage=LeakageRisk.SAFE,
        leakage_note=(
            "Lets a downstream model distinguish 'no deviation detected' from "
            "'deviation not measurable yet' instead of conflating them."
        ),
    ),
)

#: Features the specification names that canonical data cannot support.
#: Listed rather than fabricated (spec §52; Phase 3 brief).
UNAVAILABLE_SPEC_FEATURES: tuple[UnavailableFeature, ...] = (
    UnavailableFeature(
        name="location_distance",
        source="spec §6.2",
        reason="Canonical LOCATION holds place names/region codes, not coordinates.",
        would_require="Geocoding, or a source that publishes lat/long.",
    ),
    UnavailableFeature(
        name="impossible_travel",
        source="spec §6.2",
        reason="Requires location_distance plus reliable wall-clock time; neither "
        "is available together in any currently registered dataset.",
        would_require="Geocoded locations and true timestamps on the same rows.",
    ),
    UnavailableFeature(
        name="ip_novelty",
        source="spec §6.2",
        reason="No dataset in the registry publishes IP addresses, and S40 does "
        "not currently collect them.",
        would_require="An IP field, plus a privacy review before collecting one.",
    ),
    UnavailableFeature(
        name="device_risk",
        source="spec §6.2, §41",
        reason="A composite score produced by the device-risk rules, not a raw "
        "feature. Defining it here would pre-empt Phase 6.",
        would_require="The rule engine (docs/DEVELOPMENT_PLAN.md Phase 6).",
    ),
    UnavailableFeature(
        name="behaviour_deviation",
        source="spec §6.3",
        reason="An aggregate of the individual deviation features. Combining them "
        "requires weights, which spec §12 says must be calibrated, not invented.",
        would_require="Calibration against validation data (Phase 6).",
    ),
    # Recurring-payment cadence features (is_known_periodic_recipient,
    # periodicity_cadence_delta, amount_deviation_from_recurring_baseline,
    # historical_user_confirmations_for_recipient — see
    # ml/profiles/recurring_pattern.py, ml/features/recipient_pattern_features.py)
    # are deliberately NOT computed by this offline/training engine. They
    # are wired only into the live inference path
    # (app/services/risk_service.py -> ml/inference/predict.py), which
    # fusion.py/shap_explainer.py already consume via
    # ml.profiles.recurring_pattern.is_recurring_match(). Feeding them into
    # BEHAVIOUR_COLUMNS and retraining the IsolationForest was considered
    # and rejected: it would make cadence recognition an opaque, retrained
    # weight instead of the interpretable rule this module's own docstring
    # requires ("must NOT become a hidden second ML model").
    UnavailableFeature(
        name="is_known_periodic_recipient",
        source="Recurring-payment cadence detection (see ml/profiles/recurring_pattern.py)",
        reason="Requires a chronologically-ordered per-recipient transaction history "
        "this offline engine's per-user UserRiskProfile doesn't track (it's "
        "existence-only, not per-recipient-timestamped) — computed live instead.",
        would_require="Per-(user, recipient) transaction history, not just per-user.",
    ),
    UnavailableFeature(
        name="periodicity_cadence_delta",
        source="Recurring-payment cadence detection",
        reason="Depends on is_known_periodic_recipient's cluster detection.",
        would_require="Per-(user, recipient) transaction history.",
    ),
    UnavailableFeature(
        name="amount_deviation_from_recurring_baseline",
        source="Recurring-payment cadence detection",
        reason="Depends on is_known_periodic_recipient's cluster detection.",
        would_require="Per-(user, recipient) transaction history.",
    ),
    UnavailableFeature(
        name="historical_user_confirmations_for_recipient",
        source="Recurring-payment cadence detection",
        reason="Requires UserFeedback rows, which this offline engine's canonical "
        "training data doesn't carry (no confirm/cancel/report signal in the "
        "registered ML training datasets).",
        would_require="A canonical dataset that records explicit user confirmations.",
    ),
)


def compute_features(
    frame: pd.DataFrame,
    availability: FeatureAvailability,
    *,
    profile_config: ProfileConfig | None = None,
) -> pd.DataFrame:
    """Compute leakage-safe features for a canonical frame.

    Returns a new frame: the canonical columns plus one column per feature
    in FEATURE_SPECS that this dataset's availability actually supports.
    Unsupported features are omitted entirely rather than emitted as nulls,
    so a caller cannot mistake "this dataset cannot express this" for
    "this row happened to be missing it".
    """
    config = profile_config or ProfileConfig()

    has_user = availability.is_usable(C.USER_ID.value)
    has_time = availability.of(C.TIMESTAMP.value) is Availability.OBSERVED
    has_recipient = availability.is_usable(C.RECIPIENT_ID.value)
    has_device = availability.is_usable(C.DEVICE_ID.value)
    has_location = availability.is_usable(C.LOCATION.value)

    if not has_user:
        # Without a user identity there is no "normal for this user", so
        # every behavioural feature is meaningless. Returning the frame
        # untouched is the honest outcome (this is the ULB case).
        return frame.copy()

    order_column = (
        C.TIMESTAMP.value
        if has_time and frame[C.TIMESTAMP.value].notna().any()
        else C.TIME_INDEX.value
    )
    ordered = frame.sort_values(order_column, kind="stable").reset_index(drop=True)

    profiles: dict[str, UserRiskProfile] = {}
    # (user, recipient) -> prior payment count
    recipient_counts: dict[tuple[str, str], int] = defaultdict(int)
    # device -> set of users seen on it so far
    device_users: dict[str, set[str]] = defaultdict(set)

    rows: list[dict] = []
    for record in ordered.to_dict(orient="records"):
        user = record[C.USER_ID.value]
        user_key = str(user) if not pd.isna(user) else None
        amount = _as_float(record[C.AMOUNT.value])
        recipient = _as_str(record[C.RECIPIENT_ID.value]) if has_recipient else None
        device = _as_str(record[C.DEVICE_ID.value]) if has_device else None
        location = _as_str(record[C.LOCATION.value]) if has_location else None
        timestamp = _as_datetime(record[C.TIMESTAMP.value]) if has_time else None

        if user_key is None:
            rows.append({})
            continue

        profile = profiles.get(user_key)
        if profile is None:
            profile = UserRiskProfile(user_id=user_key, config=config)
            profiles[user_key] = profile

        computed: dict[str, object] = {
            "user_transaction_count": profile.count,
            "profile_is_cold": int(profile.is_cold),
        }

        if amount is not None:
            computed["amount_zscore"] = profile.amount_zscore(amount)
            computed["amount_vs_average"] = profile.amount_ratio(amount)

        if has_recipient:
            seen = profile.has_seen_recipient(recipient)
            computed["recipient_seen_before"] = None if seen is None else int(seen)
            if recipient is not None:
                prior = recipient_counts[(user_key, recipient)]
                computed["recipient_frequency"] = (
                    prior / profile.count if profile.count else None
                )

        if has_device:
            seen_device = profile.has_seen_device(device)
            computed["new_device"] = None if seen_device is None else int(not seen_device)
            computed["device_account_count"] = (
                len(device_users[device]) if device is not None else None
            )

        if has_location:
            seen_location = profile.has_seen_location(location)
            computed["location_deviation"] = (
                None if seen_location is None else int(not seen_location)
            )

        if has_time and timestamp is not None:
            computed["transactions_last_10m"] = profile.transactions_within(timestamp, 600)
            computed["transactions_last_1h"] = profile.transactions_within(timestamp, 3600)
            hour_share = profile.hour_frequency(timestamp.hour)
            computed["time_of_day_deviation"] = (
                None if hour_share is None else 1.0 - hour_share
            )
            computed["seconds_since_last_transaction"] = (
                (timestamp - profile.last_timestamp).total_seconds()
                if profile.last_timestamp is not None
                else None
            )

        rows.append(computed)

        # --- fold this transaction in, AFTER scoring it ------------------
        profile.update(
            amount=amount,
            recipient=recipient,
            device=device,
            location=location,
            timestamp=timestamp,
        )
        if recipient is not None:
            recipient_counts[(user_key, recipient)] += 1
        if device is not None:
            device_users[device].add(user_key)

    features = pd.DataFrame(rows, index=ordered.index)
    # Force a consistent nullable-float dtype on every feature column.
    # Without this, a column that happens to be entirely missing comes back
    # as object/None while a partially-populated one comes back as
    # float/NaN — same meaning, different type, which breaks downstream
    # concatenation and makes "is this missing?" checks inconsistent.
    for column in features.columns:
        features[column] = pd.to_numeric(features[column], errors="coerce").astype("Float64")
    return pd.concat([ordered, features], axis=1)


def supported_feature_names(availability: FeatureAvailability) -> list[str]:
    """Which FEATURE_SPECS a dataset can actually support."""
    return [
        spec.name
        for spec in FEATURE_SPECS
        if all(availability.is_usable(column) for column in spec.required_inputs)
    ]


def _as_float(value) -> float | None:
    if value is None or pd.isna(value):
        return None
    return float(value)


def _as_str(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    return str(value)


def _as_datetime(value):
    if value is None or pd.isna(value):
        return None
    return pd.Timestamp(value).to_pydatetime()
