"""
Unit Tests for Risk Calibration & Fusion Engine.
"""

import unittest
from ml.inference.fusion import RiskFusionEngine


class TestRiskFusionEngine(unittest.TestCase):

    def setUp(self):
        self.fusion_engine = RiskFusionEngine()

    def test_low_risk_decision(self):
        features = {"amount_vs_avg_ratio": 1.0, "new_device": 0, "recipient_novelty": 0}
        sub_scores = {
            "transaction_fraud": 0.05,
            "behaviour_anomaly": 0.05,
            "device_risk": 0.0,
            "voice_risk": 0.0,
        }
        res = self.fusion_engine.fuse_signals(features, sub_scores, [])
        self.assertLessEqual(res["risk_score"], 30)
        self.assertEqual(res["risk_level"], "LOW")
        self.assertEqual(res["decision"], "ALLOW")

    def test_high_risk_decision(self):
        features = {
            "amount_vs_avg_ratio": 8.0,
            "new_device": 1,
            "recipient_novelty": 1,
            "impossible_travel_speed_kmh": 1200.0,
            "voice_risk_score": 0.90,
        }
        sub_scores = {
            "transaction_fraud": 0.85,
            "behaviour_anomaly": 0.80,
            "device_risk": 0.90,
            "voice_risk": 0.90,
        }
        res = self.fusion_engine.fuse_signals(features, sub_scores, [])
        self.assertGreater(res["risk_score"], 60)
        self.assertEqual(res["risk_level"], "HIGH")
        self.assertEqual(res["decision"], "CONFIRM_OR_CANCEL")

    def test_anti_double_counting_dampening(self):
        features = {"new_device": 1, "amount_vs_avg_ratio": 4.0, "recipient_novelty": 1}
        sub_scores = {
            "transaction_fraud": 0.50,
            "behaviour_anomaly": 0.40,
            "device_risk": 0.80,  # High device risk already penalizes
            "voice_risk": 0.10,
        }
        res = self.fusion_engine.fuse_signals(features, sub_scores, [])
        self.assertIn("rule_risk", res["sub_scores"])

    def test_recurring_match_bypasses_high_amount_override(self):
        """A payment that matches an established recurring pattern for its
        recipient (e.g. month-3 rent, 25x the user's GLOBAL average) must
        not be force-floored to HIGH by the amount_vs_avg_ratio>=15 single-
        signal override — see ml/inference/fusion.py's recurring_match gate."""
        features = {
            "amount_vs_avg_ratio": 20.0,  # would normally force >=78 alone
            "new_device": 0,
            "recipient_novelty": 0,
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": "MONTHLY",
            "periodicity_cadence_delta": 1.0,  # well within MONTHLY's tolerance
            "amount_deviation_from_recurring_baseline": 0.02,  # well within 10%
        }
        sub_scores = {
            "transaction_fraud": 0.10,
            "behaviour_anomaly": 0.05,  # already-dampened value, as predict.py would produce
            "device_risk": 0.10,
            "voice_risk": 0.0,
        }
        res = self.fusion_engine.fuse_signals(features, sub_scores, [])
        self.assertLess(res["risk_score"], 78)
        self.assertNotEqual(res["risk_level"], "HIGH")

    def test_amount_deviation_beyond_tolerance_still_floors_despite_periodic_flag(self):
        """A spike to an otherwise-recurring recipient (e.g. 5x the usual
        rent amount) must still trigger the HIGH override — matching a
        recipient's cadence isn't enough if the AMOUNT itself deviates
        beyond AMOUNT_TOLERANCE_PCT, since is_recurring_match() requires
        both to hold."""
        features = {
            "amount_vs_avg_ratio": 20.0,
            "new_device": 0,
            "recipient_novelty": 0,
            "is_known_periodic_recipient": 1.0,
            "periodicity_cadence_type": "MONTHLY",
            "periodicity_cadence_delta": 1.0,
            "amount_deviation_from_recurring_baseline": 0.50,  # far beyond 10% tolerance
        }
        sub_scores = {
            "transaction_fraud": 0.10,
            "behaviour_anomaly": 0.05,
            "device_risk": 0.10,
            "voice_risk": 0.0,
        }
        res = self.fusion_engine.fuse_signals(features, sub_scores, [])
        self.assertGreaterEqual(res["risk_score"], 78)
        self.assertEqual(res["risk_level"], "HIGH")


if __name__ == "__main__":
    unittest.main()
