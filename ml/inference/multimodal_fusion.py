"""
Multimodal Bayesian Saturation Risk Fusion Engine for S40 / AVARAN.

Unifies 4 independent detection modalities:
1. Transaction Fraud ML (LightGBM/XGBoost calibrated probability).
2. Behavioral Profile Anomaly (Isolation Forest / Mahalanobis distance).
3. Voice Vishing Intent NLP (Multilingual Aho-Corasick + Leaky Bucket).
4. Audio Anti-Spoofing (Acoustic jitter & vocoder distortion — catches a
   synthetic/cloned voice of a known person, e.g. asking for money).

Applies probabilistic saturation fusion, anti-double-counting controls,
single-threat overrides, and outputs calibrated 0–100 risk decisions.
"""

from typing import Dict, Any, Tuple, List, Optional


DEFAULT_MULTIMODAL_WEIGHTS: Dict[str, float] = {
    "transaction_fraud": 0.30,
    "behaviour_anomaly": 0.20,
    "device_risk": 0.15,
    "voice_risk": 0.25,
    "audio_spoof": 0.20,
}

DEFAULT_THRESHOLDS = {
    "low_max": 35,
    "medium_max": 74,
}


class MultimodalBayesianFusionEngine:
    """
    Fuses cross-modal fraud indicators into an explainable composite risk decision.
    """

    def __init__(self, weights: Optional[Dict[str, float]] = None, thresholds: Optional[Dict[str, int]] = None):
        self.weights = dict(DEFAULT_MULTIMODAL_WEIGHTS)
        if weights:
            self.weights.update(weights)

        self.thresholds = dict(DEFAULT_THRESHOLDS)
        if thresholds:
            self.thresholds.update(thresholds)

    def fuse_multimodal(
        self,
        sub_scores: Dict[str, float],
        features: Optional[Dict[str, float]] = None,
        active_rules: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Fuses multimodal sub-scores into an integrated risk score.

        Args:
            sub_scores: Dict mapping modality to normalized score [0.0, 1.0]:
                - transaction_fraud
                - behaviour_anomaly
                - device_risk
                - voice_risk
                - audio_spoof
                - rule_risk (optional)
            features: Contextual transaction/device feature map.
            active_rules: List of active rule dicts.

        Returns:
            Dict containing:
                - risk_score: int (0 to 100)
                - risk_level: str ('LOW', 'MEDIUM', 'HIGH')
                - decision: str ('ALLOW', 'WARN_CHOICE', 'CONFIRM_OR_CANCEL')
                - sub_scores: dict of rounded input signals
                - active_rules: list of triggered rules
                - primary_risk_factors: list of dominant risk contributors
        """
        feat = features or {}
        p_fraud = min(1.0, sub_scores.get("transaction_fraud", 0.0) * 2.5)
        s_anomaly = min(1.0, sub_scores.get("behaviour_anomaly", 0.0))
        r_device = min(1.0, sub_scores.get("device_risk", 0.0))
        r_voice = min(1.0, sub_scores.get("voice_risk", 0.0))
        r_audio_spoof = min(1.0, sub_scores.get("audio_spoof", 0.0))
        r_rule = min(1.0, sub_scores.get("rule_risk", 0.0))

        # Anti-double counting control (e.g. new device in both device risk and rule engine)
        if feat.get("new_device", 0) == 1 and r_device > 0.6:
            r_rule = r_rule * 0.75

        # Probabilistic Saturation Fusion:
        # Survival product = Product of (1 - w_i * score_i)
        w = self.weights
        comp_fraud = 1.0 - (w["transaction_fraud"] * p_fraud)
        comp_anomaly = 1.0 - (w["behaviour_anomaly"] * s_anomaly)
        comp_device = 1.0 - (w["device_risk"] * r_device)
        comp_voice = 1.0 - (w["voice_risk"] * r_voice)
        comp_spoof = 1.0 - (w["audio_spoof"] * r_audio_spoof)
        comp_rule = 1.0 - (0.25 * r_rule)

        survival = (
            comp_fraud
            * comp_anomaly
            * comp_device
            * comp_voice
            * comp_spoof
            * comp_rule
        )
        fused_float = 1.0 - survival

        # Single-Threat Critical Override:
        # Any severe independent signal guarantees escalation to at least HIGH tier (>=78)
        critical_override_reasons: List[str] = []
        if r_audio_spoof >= 0.65:
            critical_override_reasons.append("Synthetic cloned voice detected on call audio")
        if r_voice >= 0.60:
            critical_override_reasons.append("High coercive pressure / authority threat on call")
        if p_fraud >= 0.75:
            critical_override_reasons.append("High transaction fraud pattern probability")
        if feat.get("amount_vs_avg_ratio", 1.0) >= 15.0:
            critical_override_reasons.append("Extreme transaction amount spike (>15x normal)")
        if s_anomaly >= 0.85:
            critical_override_reasons.append("Critical behavioral profile deviation")

        if critical_override_reasons:
            fused_float = max(fused_float, 0.78)

        risk_score = int(round(min(100.0, fused_float * 100.0)))

        # Decision Tier Routing
        if risk_score <= self.thresholds["low_max"]:
            risk_level = "LOW"
            decision = "ALLOW"
        elif risk_score <= self.thresholds["medium_max"]:
            risk_level = "MEDIUM"
            decision = "WARN_CHOICE"
        else:
            risk_level = "HIGH"
            decision = "CONFIRM_OR_CANCEL"

        # Identify primary risk contributors
        raw_signals = {
            "Transaction Fraud ML": p_fraud,
            "Behavioral Profile Anomaly": s_anomaly,
            "Voice Vishing Coercion": r_voice,
            "Synthetic Audio Spoof": r_audio_spoof,
            "Device Novelty": r_device,
        }
        sorted_factors = [k for k, v in sorted(raw_signals.items(), key=lambda item: item[1], reverse=True) if v >= 0.30]

        return {
            "risk_score": risk_score,
            "risk_level": risk_level,
            "decision": decision,
            "sub_scores": {
                "transaction_fraud": round(p_fraud, 4),
                "behaviour_anomaly": round(s_anomaly, 4),
                "device_risk": round(r_device, 4),
                "voice_risk": round(r_voice, 4),
                "audio_spoof": round(r_audio_spoof, 4),
                "rule_risk": round(r_rule, 4),
            },
            "active_rules": active_rules or [],
            "primary_risk_factors": sorted_factors,
            "critical_overrides": critical_override_reasons,
        }
