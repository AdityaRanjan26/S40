"""
Pre-Payment Risk Evaluation Tests (Part 1).

Validates the real backend pre-payment evaluation endpoint POST /api/v1/risk/evaluate:
- Evaluates UPI IDs and 10-digit mobile numbers before any transaction exists.
- Resolves recipient names against DB using hashed identifiers without fabricating names.
- Enforces stage: EVALUATION_COMPLETED.
- Rejects malformed recipients and non-positive amounts with 422.
- Guarantees NO transaction is created, NO status is mutated, NO alert is created,
  and NO guardian request is triggered.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_identifier
from app.models.alert import Alert
from app.models.device import Device
from app.models.enums import TransactionStatus
from app.models.guardian_request import GuardianRequest
from app.models.recipient import Recipient
from app.models.transaction import Transaction
from app.models.user import User


def _auth_headers_for_new_user(client):
    """Mints a fresh user and a JWT for it — this endpoint now requires
    auth for every call, including anonymous-recipient prepayment checks
    that don't supply a user_id in the payload."""
    user_id = client.post(
        "/api/v1/users", json={"name": "Prepay Tester", "phone_number": "+91-90011-22233"}
    ).json()["id"]
    token = create_access_token({"sub": str(user_id)})
    return {"Authorization": f"Bearer {token}"}


def test_prepayment_evaluation_upi_unverified(client: TestClient, db_session: Session):
    """Evaluating a valid but previously unseen UPI ID returns UNVERIFIED without inventing names."""
    tx_count_before = db_session.query(Transaction).count()
    alert_count_before = db_session.query(Alert).count()
    guardian_count_before = db_session.query(GuardianRequest).count()

    response = client.post(
        "/api/v1/risk/evaluate",
        json={
            "recipient": "newmerchant@okhdfcbank",
            "amount": 1500.00,
            "note": "Grocery shopping",
        },
        headers=_auth_headers_for_new_user(client),
    )
    assert response.status_code == 200
    data = response.json()

    assert data["stage"] == "EVALUATION_COMPLETED"
    assert 0 <= data["risk_score"] <= 100
    assert data["risk_level"] in ("LOW", "MEDIUM", "HIGH")
    assert data["decision"] in ("ALLOW", "WARN_CHOICE", "CONFIRM_OR_CANCEL")
    assert isinstance(data["plain_language_reasons"], list)
    assert len(data["plain_language_reasons"]) > 0
    assert "disclaimer" in data

    rec = data["recipient"]
    assert rec["raw_input"] == "newmerchant@okhdfcbank"
    assert rec["normalized"] == "newmerchant@okhdfcbank"
    assert rec["recipient_type"] == "UPI_ID"
    assert rec["display_name"] is None
    assert rec["resolution_status"] == "UNVERIFIED"
    assert data["amount"] == 1500.00
    assert data["note"] == "Grocery shopping"

    # Verify strictly no state was persisted
    assert db_session.query(Transaction).count() == tx_count_before
    assert db_session.query(Alert).count() == alert_count_before
    assert db_session.query(GuardianRequest).count() == guardian_count_before


def test_prepayment_evaluation_mobile_unresolved(client: TestClient, db_session: Session):
    """Evaluating a valid 10-digit mobile number returns UNRESOLVED if not in DB, without appending @upi."""
    response = client.post(
        "/api/v1/risk/evaluate",
        json={
            "recipient": "+91 98765 43210",
            "amount": 750.50,
        },
        headers=_auth_headers_for_new_user(client),
    )
    assert response.status_code == 200
    data = response.json()

    assert data["stage"] == "EVALUATION_COMPLETED"
    rec = data["recipient"]
    assert rec["normalized"] == "9876543210"
    assert rec["recipient_type"] == "PHONE"
    assert rec["display_name"] is None
    assert rec["resolution_status"] == "UNRESOLVED"
    assert "@" not in rec["normalized"]


def test_prepayment_evaluation_resolves_known_recipient(client: TestClient, db_session: Session):
    """Evaluating a known recipient handle resolves the actual DB display name."""
    user = User(name="Sender User", phone_hash=hash_identifier("9900011122"))
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    upi_handle = "known.friend@icici"
    h = hash_identifier(upi_handle)
    recipient = Recipient(user_id=user.id, recipient_hash=h, display_name="Priya Sharma")
    db_session.add(recipient)
    db_session.commit()

    token = create_access_token({"sub": str(user.id)})
    response = client.post(
        "/api/v1/risk/evaluate",
        json={
            "recipient": upi_handle,
            "amount": 250.00,
            "user_id": user.id,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()

    assert data["stage"] == "EVALUATION_COMPLETED"
    rec = data["recipient"]
    assert rec["display_name"] == "Priya Sharma"
    assert rec["resolution_status"] == "RESOLVED"


def test_prepayment_evaluation_resolves_registered_phone_user(client: TestClient, db_session: Session):
    """Evaluating a phone number registered to an existing User resolves their real name."""
    phone = "9888877777"
    user = User(name="Rohit Verma", phone_hash=hash_identifier(phone))
    db_session.add(user)
    db_session.commit()

    response = client.post(
        "/api/v1/risk/evaluate",
        json={
            "recipient": "9888877777",
            "amount": 500.00,
        },
        headers=_auth_headers_for_new_user(client),
    )
    assert response.status_code == 200
    data = response.json()

    assert data["stage"] == "EVALUATION_COMPLETED"
    rec = data["recipient"]
    assert rec["display_name"] == "Rohit Verma"
    assert rec["resolution_status"] == "RESOLVED"


def test_prepayment_evaluation_rejects_invalid_recipients(client: TestClient):
    """Rejects malformed recipients with HTTP 422."""
    invalid_cases = [
        "",
        "   ",
        "invalid_handle_without_domain",
        "user@",
        "@bank",
        "12345",
        "+14155552671",  # Non-Indian phone
        "abcdefghij",
    ]
    headers = _auth_headers_for_new_user(client)

    for inv in invalid_cases:
        res = client.post(
            "/api/v1/risk/evaluate", json={"recipient": inv, "amount": 100}, headers=headers
        )
        assert res.status_code == 422
        assert "Invalid recipient" in res.json()["detail"]


def test_prepayment_evaluation_rejects_invalid_amounts(client: TestClient):
    """Rejects missing, zero, or negative amounts with HTTP 422."""
    headers = _auth_headers_for_new_user(client)

    res1 = client.post(
        "/api/v1/risk/evaluate", json={"recipient": "test@upi", "amount": 0}, headers=headers
    )
    assert res1.status_code == 422
    assert "greater than zero" in res1.json()["detail"].lower()

    res2 = client.post(
        "/api/v1/risk/evaluate", json={"recipient": "test@upi", "amount": -100}, headers=headers
    )
    assert res2.status_code == 422
    assert "greater than zero" in res2.json()["detail"].lower()

    res3 = client.post(
        "/api/v1/risk/evaluate", json={"recipient": "test@upi", "amount": "invalid"}, headers=headers
    )
    assert res3.status_code == 422
    assert "valid number" in res3.json()["detail"].lower()

    res4 = client.post("/api/v1/risk/evaluate", json={"recipient": "test@upi"}, headers=headers)
    assert res4.status_code == 422


def test_evaluation_endpoint_rejects_empty_payload(client: TestClient):
    """Rejects payload with neither transaction_id nor recipient/amount with HTTP 422."""
    res = client.post("/api/v1/risk/evaluate", json={}, headers=_auth_headers_for_new_user(client))
    assert res.status_code == 422
    assert "Either transaction_id or recipient" in res.json()["detail"]


def _seed_recurring_rent_history(db_session: Session):
    """Seeds a user, a known device, a recipient, and 3 monthly CONFIRMED
    rent-payment transactions at Rs.5,000 — the same Month1->Month2->Month3
    scenario as ml/profiles/recurring_pattern.py's unit tests, but through
    the real DB + HTTP path (risk_service.py::evaluate_prepayment's
    recipient_history/recipient_confirmations wiring)."""
    user = User(name="Rent Payer", phone_hash=hash_identifier("9811122233"))
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    device = Device(user_id=user.id, device_hash=hash_identifier("rent-device-1"))
    db_session.add(device)

    landlord_handle = "landlord@okicici"
    recipient = Recipient(
        user_id=user.id, recipient_hash=hash_identifier(landlord_handle), display_name="Landlord"
    )
    db_session.add(recipient)
    db_session.commit()
    db_session.refresh(device)
    db_session.refresh(recipient)

    # Offsets land the 3rd (most recent) historical payment ~30 days before
    # "now" so that today's 4th payment lands right on the established
    # monthly cadence (see periodicity_cadence_delta / MONTHLY tolerance
    # in ml/profiles/recurring_pattern.py) instead of arriving early.
    base = datetime.now(timezone.utc) - timedelta(days=91)
    for offset in (0, 30, 61):
        db_session.add(
            Transaction(
                user_id=user.id,
                recipient_id=recipient.id,
                device_id=device.id,
                amount=Decimal("5000.00"),
                timestamp=base + timedelta(days=offset),
                status=TransactionStatus.CONFIRMED,
            )
        )
    db_session.commit()

    return user, landlord_handle


def test_prepayment_evaluation_converges_to_low_for_established_recurring_recipient(
    client: TestClient, db_session: Session
):
    """A 4th Rs.5,000 payment to a recipient with 3 prior confirmed monthly
    payments at the same amount must score LOW — the live HTTP counterpart
    to tests/test_end_to_end_inference.py's Month1->Month3 convergence
    test, exercised through risk_service.py::evaluate_prepayment's real
    recipient_history wiring instead of a hand-built predictor payload."""
    user, landlord_handle = _seed_recurring_rent_history(db_session)
    token = create_access_token({"sub": str(user.id)})

    response = client.post(
        "/api/v1/risk/evaluate",
        json={"recipient": landlord_handle, "amount": 5000.00, "user_id": user.id},
        # Same raw device identifier used to seed the Device row in
        # _seed_recurring_rent_history — a realistic month-3 scenario where
        # the same phone has been used since month 1, isolating the
        # recurring-payment signal from an unrelated device-trust one (see
        # ml/inference/fusion.py: device newness is deliberately NOT part
        # of the recurring-payment forgiveness).
        headers={"Authorization": f"Bearer {token}", "X-Device-Id": "rent-device-1"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["risk_level"] == "LOW"
    assert any("recurring" in reason.lower() for reason in data["plain_language_reasons"])


def test_prepayment_evaluation_still_flags_spike_to_recurring_recipient(
    client: TestClient, db_session: Session
):
    """A 5x spike (Rs.25,000 instead of the established Rs.5,000 rent) to
    the same recipient must still be flagged — an established cadence
    alone isn't enough, the amount has to match too."""
    user, landlord_handle = _seed_recurring_rent_history(db_session)
    token = create_access_token({"sub": str(user.id)})

    response = client.post(
        "/api/v1/risk/evaluate",
        json={"recipient": landlord_handle, "amount": 25000.00, "user_id": user.id},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["risk_level"] in ("MEDIUM", "HIGH")
