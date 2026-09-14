"""
SHAP & Rule-Based Plain-Language Explanation Engine for S40.

Generates pre-decision explainability packages containing:
1. Plain-language non-technical bullet points for ordinary users.
2. SHAP feature attributions & percentage risk contribution breakdowns.
3. Specific risk factor tags.
"""

from dataclasses import dataclass
from typing import Dict, Any, List, Optional
import numpy as np
import pandas as pd

from ml.explainability.explanations import (
    EXPLANATION_MAP,
    RiskDirection,
    explain_feature,
    validate_explanation_map,
)
from ml.profiles.recurring_pattern import is_recurring_match


def direction_of(feature: str) -> str:
    """Return the risk direction string for a given feature."""
    expl = explain_feature(feature)
    if expl is None:
        return "unknown"
    return (
        "higher_is_riskier"
        if expl.direction == RiskDirection.HIGHER_IS_RISKIER
        else "higher_is_safer"
    )


@dataclass(frozen=True)
class ShapFactor:
    feature: str
    label: str
    user_explanation: str
    analyst_explanation: str
    shap_value: float
    direction: str  # "risk_increasing" or "risk_decreasing"
    value: Any = None


class ShapExplainer:
    """
    SHAP-based explainer extracting feature-level attributions and human-readable factors.
    """

    def __init__(self, booster: Any, feature_names: tuple[str, ...] | list[str]):
        self.feature_names = tuple(feature_names)
        self.booster = booster
        self._explainer = None
        try:
            import shap
            self._explainer = shap.TreeExplainer(booster)
        except Exception:
            self._explainer = None

    def global_importance(self, frame: pd.DataFrame) -> list[dict]:
        """Compute global feature importance across a frame."""
        X = frame[list(self.feature_names)].to_numpy(dtype=float)
        if self._explainer is not None:
            shap_values = self._explainer.shap_values(X)
            mean_abs = np.abs(shap_values).mean(axis=0)
        else:
            mean_abs = np.ones(len(self.feature_names)) / len(self.feature_names)

        total = float(mean_abs.sum()) or 1.0
        rows = [
            {"feature": name, "gain": float(mean_abs[i]), "share": float(mean_abs[i] / total)}
            for i, name in enumerate(self.feature_names)
        ]
        return sorted(rows, key=lambda r: r["gain"], reverse=True)

    def explain_row(
        self,
        frame: pd.DataFrame,
        row_index: int = 0,
        top_k: int = 4,
        risk_increasing_only: bool = True,
        explainable_only: bool = True,
    ) -> list[ShapFactor]:
        """Generate top SHAP risk factors for a specific row in the frame."""
        X = frame[list(self.feature_names)].iloc[[row_index]].to_numpy(dtype=float)
        if self._explainer is not None:
            shap_values = self._explainer.shap_values(X)[0]
        else:
            shap_values = np.zeros(len(self.feature_names))

        row_vals = frame.iloc[row_index]
        factors = []
        for i, name in enumerate(self.feature_names):
            val = float(shap_values[i])
            feature_val = row_vals[name] if name in row_vals else None
            expl = explain_feature(name)
            if explainable_only and expl is None:
                continue
            direction = "risk_increasing" if val > 0 else "risk_decreasing"
            if risk_increasing_only and val <= 0:
                continue

            label = expl.label if expl else name
            user_expl = (
                expl.user_template.format(value=expl.format_value(feature_val))
                if expl
                else f"{name} value is unusual"
            )
            analyst_expl = (
                expl.analyst_template.format(value=expl.format_value(feature_val))
                if expl
                else f"{name} contributed {val:+.2f}"
            )
            factors.append(
                ShapFactor(
                    feature=name,
                    label=label,
                    user_explanation=user_expl,
                    analyst_explanation=analyst_expl,
                    shap_value=val,
                    direction=direction,
                    value=feature_val,
                )
            )

        factors.sort(key=lambda f: abs(f.shap_value), reverse=True)
        return factors[:top_k]


class ExplainabilityEngine:
    """
    Translates ML feature importances and active rule triggers into
    human-readable, non-technical explanations.
    """

    def __init__(self, xgb_model: Any = None):
        self.xgb_model = xgb_model
        self.shap_explainer = None
        if xgb_model is not None:
            try:
                import shap
                self.shap_explainer = shap.TreeExplainer(xgb_model)
            except Exception:
                self.shap_explainer = None

    def generate_explanation(
        self,
        features: Dict[str, float],
        sub_scores: Dict[str, float],
        active_rules: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Generates a human-readable explanation package.

        Args:
            features: Dictionary of computed feature values.
            sub_scores: Model outputs (fraud_probability, anomaly_score, device_risk, voice_risk).
            active_rules: List of triggered rule dictionaries.

        Returns:
            Dict containing bullet_points, risk_factors, and risk_contributions_pct.
        """
        bullet_points: List[str] = []
        risk_factors: List[str] = []

        def _safe_f(v, d=0.0):
            if v is None:
                return d
            try:
                f = float(v)
                return d if np.isnan(f) else f
            except (ValueError, TypeError):
                return d

        amount = _safe_f(features.get("amount", 0.0))
        zscore = _safe_f(features.get("amount_zscore", 0.0))
        avg_ratio = _safe_f(features.get("amount_vs_avg_ratio", features.get("amount_vs_average", 1.0)), 1.0)
        new_device = _safe_f(features.get("new_device", 0.0))
        recipient_novelty = _safe_f(features.get("recipient_novelty", 0.0 if _safe_f(features.get("recipient_seen_before", 1.0)) == 1.0 else 1.0))
        impossible_travel = _safe_f(features.get("impossible_travel_speed_kmh", 0.0))
        voice_risk = _safe_f(sub_scores.get("voice_risk", 0.0))
        anomaly_score = _safe_f(sub_scores.get("behaviour_anomaly", 0.0))

        # Recurring-payment recognition (ml/profiles/recurring_pattern.py):
        # a transaction matching an established cadence+amount pattern for
        # its recipient gets its own explanation instead of the usual
        # amount-deviation/new-recipient risk bullets, which would
        # otherwise misleadingly describe a routine, recognized payment as
        # suspicious.
        recurring_match = is_recurring_match(features)
        cadence_type = str(features.get("periodicity_cadence_type", "NONE") or "NONE")

        amount_flagged = avg_ratio >= 3.0 or zscore >= 2.5
        recipient_flagged = recipient_novelty == 1.0

        # 1. Plain-Language Rule & Feature Maps
        if recurring_match:
            # cadence_type is "NONE" when the match came from the
            # confirmation fast-path (2+ confirmed payments, too few/too
            # irregular to classify a weekly/biweekly/monthly cadence yet —
            # see recurring_pattern.py::is_recurring_match) rather than a
            # detected schedule; "recurring none payment" would misleadingly
            # imply a cadence exists.
            if cadence_type == "NONE":
                bullet_points.append(
                    "Recognized trusted recipient based on your previous confirmed payments."
                )
            else:
                bullet_points.append(
                    f"Recognized recurring {cadence_type.lower()} payment to a verified recipient."
                )
        elif amount_flagged and recipient_flagged:
            # Both conditions fired together — the literal first-occurrence
            # scenario ("a sudden ₹5,000 transfer to a new recipient")
            # reads better as one combined sentence than two separate
            # bullets saying almost the same thing.
            bullet_points.append(
                "Amount is significantly higher than your typical transactions and recipient is new."
            )
            risk_factors.append("amount_deviation")
            risk_factors.append("new_recipient")
        else:
            if amount_flagged:
                bullet_points.append(f"Transaction amount (₹{amount:,.0f}) is {avg_ratio:.1f}× higher than your usual average.")
                risk_factors.append("amount_deviation")

            if recipient_flagged:
                bullet_points.append("Recipient account has never been used before.")
                risk_factors.append("new_recipient")

        if new_device == 1.0:
            bullet_points.append("Payment initiated from an unrecognized device.")
            risk_factors.append("new_device")

        if impossible_travel > 800.0:
            bullet_points.append("Unusual physical distance detected since your last transaction.")
            risk_factors.append("impossible_travel")

        if voice_risk >= 0.5:
            bullet_points.append("Potential voice call coercion / social engineering scam indicators detected.")
            risk_factors.append("voice_phishing")

        if anomaly_score >= 0.70 and "amount_deviation" not in risk_factors:
            bullet_points.append("Unusual timing or transaction pattern for your account history.")
            risk_factors.append("behavioural_drift")

        # Include explicit rule explanations if present
        for rule in active_rules:
            expl = rule.get("explanation")
            rule_id = rule.get("rule_id")
            if expl and expl not in bullet_points:
                bullet_points.append(expl)
            if rule_id and rule_id not in risk_factors:
                risk_factors.append(rule_id.lower())

        # Fallback explanation if no specific triggers fired
        if not bullet_points:
            bullet_points.append("Transaction matches your typical payment activity.")

        # 2. Risk Contribution Percentage Breakdown (for Institution Dashboard & Explainability Card)
        raw_contributions = {
            "Transaction Fraud Model": max(0.01, sub_scores.get("transaction_fraud", 0.1)),
            "Behaviour Anomaly": max(0.01, sub_scores.get("behaviour_anomaly", 0.1)),
            "Device Integrity": max(0.01, sub_scores.get("device_risk", 0.1)),
            "Voice Scam Analysis": max(0.01, sub_scores.get("voice_risk", 0.0)),
            "Rule Engine": max(0.01, sub_scores.get("rule_risk", 0.0)),
        }

        total_contrib = sum(raw_contributions.values())
        risk_contributions_pct = {
            k: round((v / total_contrib) * 100.0, 1)
            for k, v in raw_contributions.items()
        }

        return {
            "plain_language_reasons": bullet_points,
            "risk_factors": list(set(risk_factors)),
            "risk_contributions_pct": risk_contributions_pct,
        }

