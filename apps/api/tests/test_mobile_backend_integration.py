"""
End-to-End Integration Test Suite for Mobile Application Frontend & FastAPI Backend.

Validates all API contracts called by mobile services (Auth, Transactions, Risk Evaluation, Alerts, Actions).
"""

import pytest
from fastapi.testclient import TestClient

from app.core.security import create_access_token
from app.main import app

client = TestClient(app)


def test_auth_signup_and_login():
    """Test mobile signup, OTP verification, and login endpoints."""
    # 1. Test Signup
    signup_payload = {
        "fullName": "Test Mobile User",
        "mobileNumber": "+91-99999-88888",
        "email": "mobile.test@example.com",
        "password": "StrongPassword123!",
    }
    signup_res = client.post("/api/v1/auth/signup", json=signup_payload)
    assert signup_res.status_code in (200, 201)
    signup_data = signup_res.json()
    assert signup_data["success"] is True
    assert signup_data["pendingVerification"] is True
    user_id = signup_data["userId"]
    assert signup_data["user"]["name"] == "Test Mobile User"

    # 2. Test OTP Verification
    from app.services.otp_service import otp_delivery_provider
    dispatched_otp = otp_delivery_provider.get_last_otp_for_target("+91-99999-88888")
    assert dispatched_otp is not None
    verify_res = client.post(
        "/api/v1/auth/verify-otp",
        json={"userId": user_id, "otp": dispatched_otp},
    )
    assert verify_res.status_code == 200
    verify_data = verify_res.json()
    assert verify_data["success"] is True
    assert "token" in verify_data

    # 3. Test Login
    login_payload = {
        "identifier": "+91-99999-88888",
        "password": "StrongPassword123!",
    }
    login_res = client.post("/api/v1/auth/login", json=login_payload)
    assert login_res.status_code == 200
    login_data = login_res.json()
    assert login_data["success"] is True
    assert login_data["user"]["id"] == user_id


def test_user_transactions_list():
    """Test user transaction history endpoint expected by PaymentService.getTransactions()."""
    res = client.get("/api/v1/users/1/transactions?limit=10&offset=0")
    assert res.status_code == 200
    data = res.json()
    assert "items" in data
    assert "total" in data
    assert isinstance(data["items"], list)


def test_risk_evaluation_and_transaction_actions():
    """Test creating transaction, running ML risk evaluation, and performing confirm/cancel/report actions."""
    # 1. Create User
    u_res = client.post("/api/v1/users", json={"name": "Action User", "phone_number": "+91-98765-99999"})
    assert u_res.status_code in (200, 201, 409)
    user_id = u_res.json()["id"] if u_res.status_code != 409 else 1

    # 2. Create Transaction
    tx_payload = {
        "user_id": user_id,
        "recipient_identifier": "merchant.fastpay@upi",
        "device_identifier": "device_pixel_8_pro",
        "amount": "49000.00",
        "location": "Mumbai",
        "payment_method": "UPI FastPay",
    }
    tx_res = client.post("/api/v1/transactions", json=tx_payload)
    assert tx_res.status_code in (200, 201)
    tx_id = tx_res.json()["id"]

    # 3. Evaluate ML Risk
    token = create_access_token({"sub": str(user_id)})
    risk_res = client.post(
        "/api/v1/risk/evaluate",
        json={"transaction_id": tx_id},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert risk_res.status_code == 200
    risk_data = risk_res.json()
    assert "risk_score" in risk_data
    assert "risk_level" in risk_data
    assert "decision" in risk_data

    # 4. Confirm Transaction Action
    if risk_data.get("risk_level") == "HIGH":
        # Authoritative security check: un-authorized confirm must return 403
        unauth_confirm = client.post(f"/api/v1/transactions/{tx_id}/confirm", json={"stage": "PAYMENT_COMPLETED"})
        assert unauth_confirm.status_code == 403
        # Authorize transaction with biometrics
        auth_res = client.post(f"/api/v1/transactions/{tx_id}/authorize", json={"method": "BIOMETRIC"})
        assert auth_res.status_code == 200

        confirm_res = client.post(f"/api/v1/transactions/{tx_id}/confirm", json={"stage": "PAYMENT_COMPLETED"})
        assert confirm_res.status_code == 200
        assert confirm_res.json()["status"] == "COMPLETED"

        # 5. Duplicate confirm against a COMPLETED transaction is idempotent
        # (AVARAN PAY spec §12): safe 200/COMPLETED response, flagged as a
        # duplicate, not an error. Cancel on a completed transaction is
        # still rejected.
        dup_confirm = client.post(f"/api/v1/transactions/{tx_id}/confirm")
        assert dup_confirm.status_code == 200
        assert dup_confirm.json()["duplicate"] is True
        cancel_confirmed = client.post(f"/api/v1/transactions/{tx_id}/cancel")
        assert cancel_confirmed.status_code == 400

        # 6. Cancel Action on a Pending Transaction
        tx_cancel = client.post("/api/v1/transactions", json=tx_payload).json()["id"]
        cancel_res = client.post(f"/api/v1/transactions/{tx_cancel}/cancel")
        assert cancel_res.status_code == 200
        assert cancel_res.json()["status"] == "CANCELLED"

        # 7. Report Transaction Action
        tx_report = client.post("/api/v1/transactions", json=tx_payload).json()["id"]
        report_res = client.post(f"/api/v1/transactions/{tx_report}/report", params={"reason": "Scam victim"})
        assert report_res.status_code == 200
        assert report_res.json()["status"] == "REPORTED"


def test_alerts_endpoint():
    """Test mobile alerts service backend endpoint."""
    res = client.get("/api/v1/alerts")
    assert res.status_code == 200
    assert isinstance(res.json(), list)
