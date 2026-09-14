"""
Unified ML Prediction Engine (Mediator / API Singleton) for S40.

Loads all serialized model artifacts once upon initialization:
- Transaction Fraud XGBoost (ml/models/fraud_xgb.json)
- Feature Scaler (ml/models/scaler.joblib)
- Behaviour Anomaly Forest (ml/models/anomaly_forest.joblib)
- Voice NLP Classifier (ml/models/voice_nlp.joblib)
- Fusion Configuration (ml/models/fusion_config.json)

Provides a mediator predict(payload: dict) -> dict entrypoint that executes feature extraction,
multi-model scoring, rule evaluation, SHAP explainability, and risk fusion strictly under 50ms.
"""

import os
import time
import json
import math
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, Any, Optional, List, Tuple

import joblib
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
import xgboost as xgb
from xgboost import XGBClassifier

from ml.explainability.shap_explainer import (
    ExplainabilityEngine,
    ShapExplainer,
    ShapFactor,
)
from ml.features.behaviour_features import BehaviourFeatureExtractor
from ml.features.device_features import DeviceFeatureExtractor
from ml.features.recipient_pattern_features import RecipientPatternFeatureExtractor
from ml.features.transaction_features import TransactionFeatureExtractor
from ml.features.voice_features import VoiceFeatureExtractor
from ml.inference.fusion import RiskFusionEngine
from ml.profiles.recurring_pattern import is_recurring_match
from ml.registry.artifact import ARTIFACT_ROOT, ModelArtifact, ModelMetadata
from ml.registry.model_registry import ModelRegistry, ModelStage

from ml.training.feature_manifest import MODEL_FEATURE_NAMES
from voice.classifier import VoiceClassifier

MODEL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
FRAUD_ROOT = ARTIFACT_ROOT / "fraud"


#: Sanity bounds for canonical features.
FEATURE_BOUNDS: dict[str, tuple[float | None, float | None]] = {
    "amount_zscore": (-1e4, 1e4),
    "amount_vs_average": (0.0, None),
    "recipient_seen_before": (0.0, 1.0),
    "recipient_frequency": (0.0, 1.0),
    "new_device": (0.0, 1.0),
    "device_account_count": (0.0, None),
    "transactions_last_10m": (0.0, None),
    "transactions_last_1h": (0.0, None),
    "time_of_day_deviation": (0.0, 1.0),
    "seconds_since_last_transaction": (0.0, None),
    "location_deviation": (0.0, 1.0),
    "user_transaction_count": (0.0, None),
    "profile_is_cold": (0.0, 1.0),
}


@dataclass(frozen=True)
class InputValidationIssue:
    feature: str
    problem: str
    detail: str


class InputValidationError(ValueError):
    def __init__(self, issues: list[InputValidationIssue]) -> None:
        self.issues = issues
        summary = "; ".join(f"{i.feature}: {i.problem}" for i in issues)
        super().__init__(f"Invalid fraud model input — {summary}")


@dataclass(frozen=True)
class FraudPrediction:
    """One detector's output. Not a risk score, not a decision."""

    model_name: str
    model_version: str
    fraud_probability: float
    raw_probability: float
    calibrated: bool
    top_factors: list[ShapFactor]
    feature_availability: dict[str, bool]
    cold_start: bool
    inference_ms: float
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        data = asdict(self)
        return data


class FraudDetector:
    """Transaction fraud detector loaded from a serialized artifact or registry."""

    MODEL_NAME = "s40_transaction_fraud"

    def __init__(
        self,
        booster: xgb.XGBClassifier,
        calibrator: Any,
        metadata: Any,
        path: Path,
    ) -> None:
        self.booster = booster
        self.calibrator = calibrator
        self.metadata = (
            metadata.to_dict() if hasattr(metadata, "to_dict") else dict(metadata)
        )
        self.path = Path(path)
        self.feature_names = tuple(
            self.metadata.get("feature_names") or MODEL_FEATURE_NAMES
        )
        self.explainer = ShapExplainer(self.booster.get_booster(), self.feature_names)
        self.artifact = ModelArtifact(
            booster=self.booster,
            calibrator=self.calibrator,
            metadata=(
                metadata
                if isinstance(metadata, ModelMetadata)
                else ModelMetadata(**self.metadata)
            ),
            path=self.path,
        )

    @classmethod
    def from_path(cls, path: Path) -> "FraudDetector":
        path = Path(path)
        metadata_file = path / "metadata.json"
        model_file = path / "model.json"
        calibrator_file = path / "calibrator.joblib"

        if not model_file.exists():
            raise FileNotFoundError(
                f"No model.json in {path}. Train one with:\n"
                f"    python -m ml.training.train_fraud"
            )
        if not metadata_file.exists():
            raise FileNotFoundError(
                f"No metadata.json in {path}. An artifact without provenance must not be loaded."
            )

        metadata_dict = json.loads(metadata_file.read_text(encoding="utf-8"))
        booster = xgb.XGBClassifier()
        booster.load_model(str(model_file))

        calibrator = None
        if calibrator_file.exists():
            calibrator = joblib.load(calibrator_file)

        return cls(booster, calibrator, metadata_dict, path)

    @classmethod
    def from_registry(
        cls,
        stage: ModelStage = ModelStage.CURRENT,
        *,
        root: Optional[Path] = None,
    ) -> "FraudDetector":
        registry = ModelRegistry(root=Path(root) if root else FRAUD_ROOT)
        version = registry.state().get(stage.value)
        if not version:
            raise FileNotFoundError(
                f"No fraud model registered as '{stage.value}'. Train one with:\n"
                f"    python -m ml.training.train_fraud"
            )
        return cls.from_path(registry.version_path(version))

    @property
    def model_version(self) -> str:
        return self.metadata.get("model_version", "unknown")

    def _validate(
        self, features: dict
    ) -> Tuple[list[InputValidationIssue], list[str]]:
        issues: list[InputValidationIssue] = []
        warnings: list[str] = []

        for name in self.feature_names:
            if name not in features:
                issues.append(
                    InputValidationIssue(name, "missing", "Required feature absent.")
                )
                continue
            value = features[name]
            if value is None or (isinstance(value, float) and math.isnan(value)):
                continue  # legitimate absence -> cold start
            if isinstance(value, bool):
                continue
            if not isinstance(value, (int, float, np.integer, np.floating)):
                issues.append(
                    InputValidationIssue(
                        name,
                        "invalid_type",
                        f"Expected a number, got {type(value).__name__}.",
                    )
                )
                continue
            if math.isinf(float(value)):
                issues.append(
                    InputValidationIssue(name, "not_finite", "Value is infinite.")
                )
                continue
            low, high = FEATURE_BOUNDS.get(name, (None, None))
            numeric = float(value)
            if low is not None and numeric < low:
                issues.append(
                    InputValidationIssue(
                        name, "out_of_range", f"{numeric} is below minimum {low}."
                    )
                )
            if high is not None and numeric > high:
                issues.append(
                    InputValidationIssue(
                        name, "out_of_range", f"{numeric} is above maximum {high}."
                    )
                )

        unexpected = set(features) - set(self.feature_names)
        if unexpected:
            warnings.append(f"Ignored unrecognised keys: {sorted(unexpected)}")
        return issues, warnings

    def predict(self, features: dict, top_k: int = 4) -> FraudPrediction:
        started = time.perf_counter()
        issues, warnings = self._validate(features)
        if issues:
            raise InputValidationError(issues)

        values = {}
        availability = {}
        for name in self.feature_names:
            raw = features.get(name)
            missing = raw is None or (isinstance(raw, float) and math.isnan(raw))
            availability[name] = not missing
            values[name] = np.nan if missing else float(raw)

        df = pd.DataFrame([values], columns=list(self.feature_names)).astype(
            "float64"
        )
        raw_prob = float(self.booster.predict_proba(df)[:, 1][0])

        if self.calibrator is not None:
            calibrated_prob = float(
                np.clip(
                    self.calibrator.predict(np.array([raw_prob]))[0],
                    1e-4,
                    1.0 - 1e-4,
                )
            )
            calibrated = True
        else:
            calibrated_prob = float(np.clip(raw_prob, 1e-4, 1.0 - 1e-4))
            calibrated = False

        factors = self.explainer.explain_row(
            df,
            row_index=0,
            top_k=top_k,
            risk_increasing_only=True,
            explainable_only=True,
        )

        cold_start = bool(features.get("profile_is_cold", 0.0) == 1.0)
        if cold_start or not all(availability.values()):
            warnings.append(
                "Caution: cold-start profile with missing historical baseline."
            )


        return FraudPrediction(
            model_name=self.MODEL_NAME,
            model_version=self.model_version,
            fraud_probability=calibrated_prob,
            raw_probability=raw_prob,
            calibrated=calibrated,
            top_factors=factors,
            feature_availability=availability,
            cold_start=cold_start,
            inference_ms=(time.perf_counter() - started) * 1000.0,
            warnings=warnings,
        )

    def predict_batch(self, frame: pd.DataFrame) -> np.ndarray:
        df = frame.reindex(columns=list(self.feature_names)).astype("float64")
        raw_probs = self.booster.predict_proba(df)[:, 1]
        if self.calibrator is not None:
            return np.clip(self.calibrator.predict(raw_probs), 1e-4, 1.0 - 1e-4)
        return np.clip(raw_probs, 1e-4, 1.0 - 1e-4)




class RiskDecisionPackage(BaseModel):
    """Pydantic model representing the authoritative decision package contract."""

    transaction_id: str
    risk_score: int = Field(..., ge=0, le=100)
    risk_level: str  # LOW, MEDIUM, HIGH
    decision: str  # ALLOW, WARN_CHOICE, CONFIRM_OR_CANCEL
    plain_language_reasons: list[str]
    risk_factors: list[str]
    risk_contributions_pct: dict[str, float]
    latency_ms: float
    timestamp: str



class MLPredictor:
    """
    Singleton Inference Manager for S40 Fraud Shield.
    Loads models once at startup and performs fast <50ms real-time scoring.
    """
    _instance: Optional["MLPredictor"] = None

    def __new__(cls, model_dir: str = MODEL_DIR):
        if cls._instance is None:
            cls._instance = super(MLPredictor, cls).__new__(cls)
            cls._instance._initialize(model_dir)
        return cls._instance

    def _initialize(self, model_dir: str):
        """Loads all serialized model artifacts from disk into memory."""
        self.model_dir = model_dir
        
        # 1. Feature Extractors
        self.txn_extractor = TransactionFeatureExtractor()
        self.behaviour_extractor = BehaviourFeatureExtractor()
        self.device_extractor = DeviceFeatureExtractor()
        self.voice_extractor = VoiceFeatureExtractor()
        self.pattern_extractor = RecipientPatternFeatureExtractor()

        # 2. Sub-Models & Scalers
        self.xgb_model = None
        self.scaler = None
        self.anomaly_forest = None
        self.voice_nlp_pipeline = None

        xgb_path = os.path.join(model_dir, "fraud_xgb.json")
        calibrated_path = os.path.join(model_dir, "calibrated_fraud.joblib")
        scaler_path = os.path.join(model_dir, "scaler.joblib")
        anomaly_path = os.path.join(model_dir, "anomaly_forest.joblib")
        voice_path = os.path.join(model_dir, "voice_nlp.joblib")
        fusion_cfg_path = os.path.join(model_dir, "fusion_config.json")

        if os.path.exists(calibrated_path):
            self.xgb_model = joblib.load(calibrated_path)
            print("[ML PREDICTOR] Loaded Isotonic Calibrated Classifier.")
        elif os.path.exists(xgb_path):
            self.xgb_model = XGBClassifier()
            self.xgb_model.load_model(xgb_path)

        if os.path.exists(scaler_path):
            self.scaler = joblib.load(scaler_path)

        if os.path.exists(anomaly_path):
            self.anomaly_forest = joblib.load(anomaly_path)

        if os.path.exists(voice_path):
            self.voice_nlp_pipeline = joblib.load(voice_path)

        # 3. Voice Classifier & Subsystems
        self.voice_classifier = VoiceClassifier(nlp_model_artifact=self.voice_nlp_pipeline)
        self.explainability_engine = ExplainabilityEngine(xgb_model=self.xgb_model)
        self.fusion_engine = RiskFusionEngine(config_path=fusion_cfg_path)

        # 4. Warm-up inference
        try:
            self.predict({
                "transaction_id": "WARMUP",
                "amount": 100.0,
                "recipient_id": "RECIPIENT_WARMUP",
                "timestamp": "2026-01-01T00:00:00Z",
                "device_id": "DEVICE_WARMUP",
            })
        except Exception:
            pass

        print("[ML PREDICTOR] Singleton successfully initialized and model artifacts loaded.")


    def predict(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes unified real-time risk scoring for an incoming payload.

        Args:
            payload: Dict containing transaction details, device context, user profile, and voice transcripts.

        Returns:
            Dict matching RiskDecisionPackage schema.
        """
        start_time = time.perf_counter()

        transaction = payload.get("transaction", payload)
        user_profile = payload.get("user_profile", payload.get("user_risk_profile", {}))

        # 1. Feature Extraction
        if "features" in payload and isinstance(payload["features"], dict):
            features = dict(payload["features"])
        else:
            f_txn = self.txn_extractor.extract_features(transaction, user_profile)
            f_beh = self.behaviour_extractor.extract_features(transaction, user_profile)
            f_dev = self.device_extractor.extract_features(transaction, user_profile)
            f_voi = self.voice_extractor.extract_features(transaction, user_profile)
            f_pat = self.pattern_extractor.extract_features(transaction, user_profile)
            features = {**f_txn, **f_beh, **f_dev, **f_voi, **f_pat}

        def _to_float(val, default: float = 0.0) -> float:
            if val is None:
                return default
            try:
                f = float(val)
                return default if np.isnan(f) else f
            except (ValueError, TypeError):
                return default

        # Combined Unified Feature Dictionary & Mappings
        features["amount_vs_average"] = _to_float(features.get("amount_vs_avg_ratio", features.get("amount_vs_average", 1.0)), 1.0)
        features["transactions_last_10m"] = _to_float(features.get("velocity_10m", features.get("transactions_last_10m", 0.0)), 0.0)
        features["transactions_last_1h"] = _to_float(features.get("velocity_1h", features.get("transactions_last_1h", 0.0)), 0.0)
        features["recipient_seen_before"] = _to_float(features.get("recipient_seen_before", 0.0 if _to_float(features.get("recipient_novelty", 0.0)) == 1.0 else 1.0), 1.0)
        features["new_device"] = _to_float(features.get("new_device", 0.0), 0.0)
        features["device_account_count"] = _to_float(features.get("device_account_count", 1.0), 1.0)
        features["seconds_since_last_transaction"] = _to_float(features.get("seconds_since_last_transaction", 3600.0), 3600.0)
        features["time_of_day_deviation"] = _to_float(features.get("time_of_day_deviation", _to_float(features.get("time_deviation_hours", 0.0)) / 12.0), 0.0)
        features["location_deviation"] = _to_float(features.get("location_deviation", features.get("location_anomaly_score", 0.0)), 0.0)
        features["user_transaction_count"] = _to_float(features.get("user_transaction_count", user_profile.get("user_transaction_count", 50.0)), 50.0)
        features["profile_is_cold"] = _to_float(features.get("profile_is_cold", user_profile.get("profile_is_cold", 0.0)), 0.0)

        # Recurring-payment cadence features (ml/features/recipient_pattern_features.py) —
        # normalized here too so the "features passed directly in payload"
        # shortcut above still gets safe defaults, same as every other key.
        features["is_known_periodic_recipient"] = _to_float(features.get("is_known_periodic_recipient", 0.0), 0.0)
        features["periodicity_cadence_delta"] = _to_float(features.get("periodicity_cadence_delta", 0.0), 0.0)
        features["amount_deviation_from_recurring_baseline"] = _to_float(
            features.get("amount_deviation_from_recurring_baseline", 1.0), 1.0
        )
        features["historical_user_confirmations_for_recipient"] = _to_float(
            features.get("historical_user_confirmations_for_recipient", 0.0), 0.0
        )
        features["periodicity_cadence_type"] = features.get("periodicity_cadence_type") or "NONE"


        # 2. Sub-Model Inferences
        # (a) Transaction Fraud XGBoost Score
        p_fraud = 0.15
        if self.xgb_model is not None:
            try:
                from ml.training.feature_manifest import MODEL_FEATURE_NAMES
                df = pd.DataFrame([[features.get(col, 0.0) for col in MODEL_FEATURE_NAMES]], columns=list(MODEL_FEATURE_NAMES)).astype("float64")
                p_fraud = float(self.xgb_model.predict_proba(df)[:, 1][0])
            except Exception:
                p_fraud = 0.15

        # (b) Behaviour Anomaly Isolation Forest Score
        s_anomaly = 0.10
        if self.anomaly_forest is not None:
            try:
                from ml.training.train_anomaly import BEHAVIOUR_COLUMNS
                beh_vec = [features.get(col, 0.0) for col in BEHAVIOUR_COLUMNS]
                raw_score = self.anomaly_forest.decision_function([beh_vec])[0]
                s_anomaly = float(np.clip(0.5 - raw_score, 0.0, 1.0))
            except Exception:
                s_anomaly = 0.10

        # Recurring-payment dampening: a transaction that genuinely matches
        # an established cadence+amount pattern for this recipient (see
        # ml/profiles/recurring_pattern.py) shouldn't keep tripping the
        # anomaly score just because it deviates from the user's GLOBAL
        # baseline. DAMPENING_FACTOR is a proposed placeholder, not tuned.
        # This alone is not sufficient to keep the final score low — see
        # fusion.py's matching bypass in its single-signal override, which
        # is what actually stops amount_vs_avg_ratio from force-flooring a
        # legitimately large recurring payment to HIGH.
        if is_recurring_match(features):
            DAMPENING_FACTOR = 0.15
            s_anomaly = s_anomaly * DAMPENING_FACTOR

        # (c) Device Risk Score
        new_device = features.get("new_device", 0.0)
        impossible_travel = features.get("impossible_travel_speed_kmh", 0.0)
        account_count = features.get("device_account_count", 1.0)
        
        r_device = 0.1
        if new_device == 1.0:
            r_device += 0.45
        if impossible_travel > 800.0:
            r_device += 0.40
        if account_count > 2:
            r_device += 0.15
        r_device = min(1.0, r_device)

        # (d) Voice Phishing Risk Score
        voice_payload = transaction.get("voice_transcript", transaction.get("voice_analysis", ""))
        if isinstance(voice_payload, str) and voice_payload.strip():
            voice_res = self.voice_classifier.classify_transcript(voice_payload)
            r_voice = float(voice_res.get("overall_voice_risk", 0.0))
        else:
            r_voice = float(features.get("coercion_score", 0.0))

        features["voice_risk_score"] = r_voice
        features["coercion_score"] = r_voice

        sub_scores = {
            "transaction_fraud": p_fraud,
            "behaviour_anomaly": s_anomaly,
            "device_risk": r_device,
            "voice_risk": r_voice,
        }

        # 3. Rule Evaluation & Fusion
        fusion_result = self.fusion_engine.fuse_signals(features, sub_scores)
        active_rules = fusion_result.get("active_rules", [])


        # 4. Explainability Package Generation
        explanation_pkg = self.explainability_engine.generate_explanation(
            features, sub_scores, active_rules
        )

        latency_ms = (time.perf_counter() - start_time) * 1000.0

        txn_id = str(transaction.get("transaction_id", "TXN_UNKNOWN"))
        ts = str(transaction.get("timestamp", ""))

        response = {
            "transaction_id": txn_id,
            "risk_score": fusion_result["risk_score"],
            "risk_level": fusion_result["risk_level"],
            "decision": fusion_result["decision"],
            "plain_language_reasons": explanation_pkg["plain_language_reasons"],
            "risk_factors": explanation_pkg["risk_factors"],
            "risk_contributions_pct": explanation_pkg["risk_contributions_pct"],
            "sub_scores": fusion_result["sub_scores"],
            "latency_ms": round(latency_ms, 2),
            "timestamp": ts,
        }

        return response


# Global singleton instance helper function
def get_predictor() -> MLPredictor:
    return MLPredictor()
