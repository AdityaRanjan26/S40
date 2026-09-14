"""
End-to-End Integration & Latency Benchmark Tests for MLPredictor.
"""

import time
import unittest
from ml.inference.predict import get_predictor, MLPredictor, RiskDecisionPackage


class TestEndToEndInference(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.predictor = get_predictor()

    def test_singleton_identity(self):
        another_instance = get_predictor()
        self.assertIs(self.predictor, another_instance)

    def test_predict_contract_and_latency(self):
        payload = {
            "transaction_id": "TXN_TEST_123",
            "amount": 15000.0,
            "recipient_id": "RECIPIENT_TEST",
            "timestamp": "2026-08-15T14:30:00Z",
            "device_id": "DEVICE_TEST",
            "location": "Bhubaneswar",
            "voice_transcript": "Your account will be blocked immediately.",
            "user_profile": {
                "normal_avg_amount": 1000.0,
                "normal_std_amount": 300.0,
            }
        }

        t0 = time.perf_counter()
        res = self.predictor.predict(payload)
        t1 = time.perf_counter()
        latency_ms = (t1 - t0) * 1000.0

        # Verify Response Schema
        self.assertEqual(res["transaction_id"], "TXN_TEST_123")
        self.assertIn(res["risk_level"], ["LOW", "MEDIUM", "HIGH"])
        self.assertIn(res["decision"], ["ALLOW", "WARN_CHOICE", "CONFIRM_OR_CANCEL"])
        self.assertIsInstance(res["plain_language_reasons"], list)
        self.assertIsInstance(res["risk_factors"], list)
        self.assertIsInstance(res["risk_contributions_pct"], dict)

        # Assert Strict Latency Threshold (<50ms)
        print(f"[TEST LATENCY] End-to-end inference latency: {latency_ms:.2f} ms")
        self.assertLess(latency_ms, 50.0)

    def test_recurring_rent_payment_converges_to_low_by_third_occurrence(self):
        """Month 1 -> Month 2 -> Month 3 rent-payment scenario (see
        ml/profiles/recurring_pattern.py): a student with a ~Rs.100 typical
        daily spend pays Rs.5,000 monthly rent to the same recipient. The
        first payment should score elevated (new recipient, huge amount
        deviation); by the 3rd month — with 2 prior confirmed payments in
        history and 2 explicit confirmations recorded, exactly as
        app/services/payment_lifecycle_service.py::confirm() would produce
        after the user confirms months 1 and 2 — the risk score must
        converge to LOW."""
        base_profile = {"normal_avg_amount": 100.0, "normal_std_amount": 30.0}

        # Month 1: first-ever payment to this recipient, no history at all.
        month1 = self.predictor.predict(
            {
                "transaction_id": "RENT_MONTH_1",
                "amount": 5000.0,
                "recipient_id": "RECIPIENT_LANDLORD",
                "timestamp": "2026-01-01T09:00:00Z",
                "device_id": "DEVICE_STUDENT",
                "user_profile": dict(base_profile, recipient_history=[], recipient_confirmations=0),
            }
        )
        self.assertNotEqual(month1["risk_level"], "LOW")

        # Month 3: months 1 & 2 are now confirmed history (2 prior payments,
        # 2 explicit UserFeedback(CONFIRM) rows) at a consistent ~30-day
        # cadence and identical amount.
        month3 = self.predictor.predict(
            {
                "transaction_id": "RENT_MONTH_3",
                "amount": 5000.0,
                "recipient_id": "RECIPIENT_LANDLORD",
                "timestamp": "2026-03-02T09:00:00Z",  # ~30 days after month 2
                "device_id": "DEVICE_STUDENT",
                "user_profile": dict(
                    base_profile,
                    recipient_history=[
                        {"amount": 5000.0, "timestamp": "2026-01-01T09:00:00Z"},
                        {"amount": 5000.0, "timestamp": "2026-01-31T09:00:00Z"},
                    ],
                    recipient_confirmations=2,
                ),
            }
        )
        self.assertEqual(month3["risk_level"], "LOW")
        self.assertTrue(
            any("recurring" in reason.lower() for reason in month3["plain_language_reasons"])
        )

    def test_spike_to_recurring_recipient_still_flags_high(self):
        """A 5x spike (Rs.25,000 instead of the established Rs.5,000 rent)
        to the SAME recipient with an otherwise-perfect cadence must still
        score HIGH — matching a recipient's schedule isn't enough on its
        own, the amount has to match too (see
        ml/profiles/recurring_pattern.py::is_recurring_match)."""
        result = self.predictor.predict(
            {
                "transaction_id": "RENT_SPIKE",
                "amount": 25000.0,
                "recipient_id": "RECIPIENT_LANDLORD",
                "timestamp": "2026-04-01T09:00:00Z",  # right on the expected ~30-day cadence
                "device_id": "DEVICE_STUDENT",
                "user_profile": {
                    "normal_avg_amount": 100.0,
                    "normal_std_amount": 30.0,
                    "recipient_history": [
                        {"amount": 5000.0, "timestamp": "2026-01-01T09:00:00Z"},
                        {"amount": 5000.0, "timestamp": "2026-01-31T09:00:00Z"},
                        {"amount": 5000.0, "timestamp": "2026-03-02T09:00:00Z"},
                    ],
                    "recipient_confirmations": 3,
                },
            }
        )
        self.assertEqual(result["risk_level"], "HIGH")


if __name__ == "__main__":
    unittest.main()
