"""
Unit Tests for Multimodal Bayesian Risk Fusion and Adaptive Copilot.
"""

import unittest
from ml.inference.multimodal_fusion import MultimodalBayesianFusionEngine
from ml.inference.fusion import RiskFusionEngine
from engine.copilot.adaptive_copilot import AdaptiveCopilot


class TestMultimodalFusionAndCopilot(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.multimodal_engine = MultimodalBayesianFusionEngine()
        cls.legacy_engine = RiskFusionEngine()
        cls.copilot = AdaptiveCopilot()

    def test_multimodal_saturation_escalation(self):
        """Verifies that multiple elevated modalities compound probabilistically into HIGH tier."""
        sub_scores = {
            "transaction_fraud": 0.35,
            "behaviour_anomaly": 0.40,
            "device_risk": 0.30,
            "voice_risk": 0.45,
            "audio_spoof": 0.40,
        }
        res = self.multimodal_engine.fuse_multimodal(sub_scores)
        self.assertGreater(res["risk_score"], 74)
        self.assertEqual(res["risk_level"], "HIGH")
        self.assertEqual(res["decision"], "CONFIRM_OR_CANCEL")
        self.assertIn("Voice Vishing Coercion", res["primary_risk_factors"])

    def test_audio_spoof_single_signal_override(self):
        """Verifies that high synthetic voice probability triggers critical override to >=78."""
        sub_scores = {
            "transaction_fraud": 0.05,
            "behaviour_anomaly": 0.05,
            "device_risk": 0.05,
            "voice_risk": 0.10,
            "audio_spoof": 0.85,
        }
        res = self.multimodal_engine.fuse_multimodal(sub_scores)
        self.assertGreaterEqual(res["risk_score"], 78)
        self.assertEqual(res["risk_level"], "HIGH")
        self.assertEqual(res["decision"], "CONFIRM_OR_CANCEL")
        self.assertTrue(any("Synthetic cloned voice" in r for r in res["critical_overrides"]))

    def test_legacy_fusion_engine_multimodal_compatibility(self):
        """Verifies that RiskFusionEngine supports new multimodal signals while preserving legacy behavior."""
        sub_scores = {
            "transaction_fraud": 0.1,
            "behaviour_anomaly": 0.1,
            "device_risk": 0.1,
            "voice_risk": 0.1,
            "audio_spoof": 0.75,
        }
        res = self.legacy_engine.fuse_signals({}, sub_scores)
        self.assertGreaterEqual(res["risk_score"], 78)
        self.assertEqual(res["risk_level"], "HIGH")
        self.assertEqual(res["decision"], "CONFIRM_OR_CANCEL")
        self.assertIn("audio_spoof", res["sub_scores"])

    def test_adaptive_copilot_challenge_selection(self):
        """Verifies context-sensitive challenge generation across active triggers."""
        # 1. Synthetic audio challenge (cloned voice of a known person)
        aud_res = self.copilot.evaluate_response_strategy(
            risk_score=75,
            is_synthetic_voice=True,
            language="hi"
        )
        self.assertEqual(aud_res["challenge_type"], "VOICE_LIVENESS")
        self.assertIn("तारीख", aud_res["recommended_challenge"])

        # 2. Linguistic scam trap challenge
        ling_res = self.copilot.evaluate_response_strategy(
            risk_score=60,
            scam_categories=["DIGITAL_ARREST_POLICE"],
            language="bn"
        )
        self.assertEqual(ling_res["challenge_type"], "ADMINISTRATIVE_DEADEND")
        self.assertIn("ব্যাজ নম্বর", ling_res["recommended_challenge"])


if __name__ == "__main__":
    unittest.main()
