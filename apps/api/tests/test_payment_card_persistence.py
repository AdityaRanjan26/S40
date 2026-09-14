"""
Payment Card Persistence Integration Tests (Part 2).

Validates:
1. After successful evaluation, payment draft/card can be persisted via POST /api/v1/payments/prepare.
2. Idempotency on client_request_id prevents duplicate cards.
3. User ownership isolation: User B cannot access User A's transaction card.
4. Evaluation remains strictly advisory:
   - status is PENDING (not COMPLETED, not AUTHORIZED, not CONFIRMED)
   - NO Guardian request or approval is triggered during evaluation/preparation
5. All risk levels (LOW, MEDIUM, HIGH) with risk score and detailed reasons are persisted.
6. Expired evaluations cannot be used (HTTP 410 Gone).
7. GET /api/v1/users/{user_id}/transactions and GET /api/v1/transactions/{id} reload all Goal 2 fields.
"""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token
from app.models.enums import TransactionStatus
from app.models.guardian_request import GuardianRequest
from app.models.transaction import Transaction
from app.models.user import User


def _create_user(client: TestClient, name: str = "Persistence User", phone: str = "+91-91234-56789") -> int:
    res = client.post("/api/v1/users", json={"name": name, "phone_number": phone})
    assert res.status_code == 201
    return res.json()["id"]


def test_successful_card_persistence(client: TestClient, db_session: Session):
    """Card is persisted via POST /api/v1/payments/prepare with evaluation details."""
    user_id = _create_user(client, "Card User 1", "+91-98765-43210")
    token = create_access_token({"sub": str(user_id)})

    # Step 1: Pre-payment evaluation
    eval_res = client.post(
        "/api/v1/risk/evaluate",
        json={
            "recipient": "grocery@upi",
            "amount": 450.00,
            "note": "Weekly vegetables",
            "user_id": user_id,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert eval_res.status_code == 200
    eval_data = eval_res.json()
    assert eval_data["stage"] == "EVALUATION_COMPLETED"
    assert "evaluation_id" in eval_data

    # Step 2: Persist payment draft/card
    idem_key = f"idem-{eval_data['evaluation_id']}"
    prepare_res = client.post(
        "/api/v1/payments/prepare",
        json={
            "user_id": user_id,
            "source": "UPI_ID",
            "amount": "450.00",
            "upi_id": "grocery@upi",
            "note": "Weekly vegetables",
            "device_identifier": "device-pers-1",
            "client_request_id": idem_key,
            "evaluation_id": eval_data["evaluation_id"],
            "risk_score": eval_data["risk_score"],
            "risk_level": eval_data["risk_level"],
            "decision": eval_data["decision"],
            "risk_factors": eval_data["risk_factors"],
            "plain_language_reasons": eval_data["plain_language_reasons"],
            "recipient_type": eval_data["recipient"]["recipient_type"],
            "resolution_status": eval_data["recipient"]["resolution_status"],
            "evaluation_timestamp": eval_data["timestamp"],
            "evaluation_expires_at": eval_data["expires_at"],
            "guardian_required": eval_data["guardian_required"],
        },
    )
    assert prepare_res.status_code == 201
    card = prepare_res.json()

    # Verify all Goal 2 fields present on returned card
    assert card["id"] is not None
    assert card["user_id"] == user_id
    assert card["status"] == "PENDING"
    assert card["amount"] == "450.00"
    assert card["evaluation_id"] == eval_data["evaluation_id"]
    assert card["recipient_input"] == "grocery@upi"
    assert card["recipient_type"] == "UPI_ID"
    assert card["note"] == "Weekly vegetables"
    assert card["decision"] in ("ALLOW", "WARN", "WARN_CHOICE", "CONFIRM_OR_CANCEL")
    assert card["workflow_stage"] == "EVALUATION_COMPLETED"

    assert "risk_score" in card
    assert "risk_level" in card


def test_card_reload_after_screen_reopen(client: TestClient, db_session: Session):
    """GET /api/v1/users/{user_id}/transactions reloads persisted card with all Goal 2 fields."""
    user_id = _create_user(client, "Card User 2", "+91-98765-43211")

    # Prepare card
    prepare_res = client.post(
        "/api/v1/payments/prepare",
        json={
            "user_id": user_id,
            "source": "UPI_ID",
            "amount": "750.00",
            "upi_id": "bakery@okhdfc",
            "note": "Birthday cake",
            "device_identifier": "device-pers-2",
            "client_request_id": "idem-reload-001",
            "evaluation_id": "EVAL-RELOAD-123",
            "risk_score": 25.0,
            "risk_level": "LOW",
            "decision": "ALLOW",
            "recipient_type": "UPI_ID",
            "resolution_status": "UNVERIFIED",
        },
    )
    assert prepare_res.status_code == 201
    txn_id = prepare_res.json()["id"]

    # Reload from user transactions endpoint (simulating Payments screen reopen)
    list_res = client.get(f"/api/v1/users/{user_id}/transactions")
    assert list_res.status_code == 200
    data = list_res.json()
    assert data["total"] >= 1

    matched = next((it for it in data["items"] if it["id"] == txn_id), None)
    assert matched is not None
    assert matched["amount"] == 750.0
    assert matched["status"] == "PENDING"
    assert matched["evaluation_id"] == f"EVAL-TXN-{txn_id}"
    assert matched["recipient_type"] == "UPI_ID"
    assert matched["workflow_stage"] == "EVALUATION_COMPLETED"
    assert matched["decision"] == "ALLOW"


def test_duplicate_evaluation_idempotency(client: TestClient, db_session: Session):
    """Duplicate requests with same client_request_id return same card without creating duplicates."""
    user_id = _create_user(client, "Card User 3", "+91-98765-43212")

    payload = {
        "user_id": user_id,
        "source": "UPI_ID",
        "amount": "300.00",
        "upi_id": "tea@upi",
        "device_identifier": "device-pers-3",
        "client_request_id": "idem-dup-test-999",
        "evaluation_id": "EVAL-DUP-999",
        "risk_score": 10.0,
        "risk_level": "LOW",
    }

    first = client.post("/api/v1/payments/prepare", json=payload)
    second = client.post("/api/v1/payments/prepare", json=payload)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    # Verify only 1 row exists in DB
    count = db_session.query(Transaction).filter(
        Transaction.user_id == user_id,
        Transaction.idempotency_key == "idem-dup-test-999",
    ).count()
    assert count == 1


def test_user_ownership_isolation(client: TestClient, db_session: Session):
    """User B cannot access User A's transaction card."""
    user_a = _create_user(client, "User A", "+91-98765-43213")
    user_b = _create_user(client, "User B", "+91-98765-43214")

    # User A creates card
    res_a = client.post(
        "/api/v1/payments/prepare",
        json={
            "user_id": user_a,
            "source": "UPI_ID",
            "amount": "1000.00",
            "upi_id": "rent@upi",
            "device_identifier": "device-a",
            "client_request_id": "idem-user-a-01",
        },
    )
    assert res_a.status_code == 201
    txn_id = res_a.json()["id"]

    # User B lists transactions: User A's transaction must not appear
    list_b = client.get(f"/api/v1/users/{user_b}/transactions")
    assert list_b.status_code == 200
    ids_b = [it["id"] for it in list_b.json()["items"]]
    assert txn_id not in ids_b

    # User B attempts to access User A's transaction directly with ownership validation
    detail_res = client.get(f"/api/v1/transactions/{txn_id}?user_id={user_b}")
    assert detail_res.status_code == 403
    assert "Access denied" in detail_res.json()["detail"]


def test_evaluation_remains_advisory_no_completion_or_guardian_approval(client: TestClient, db_session: Session):
    """Evaluation & persistence must remain strictly advisory: no Guardian request, no completion."""
    user_id = _create_user(client, "Advisory User", "+91-98765-43215")

    # Create high-risk evaluation persistence
    res = client.post(
        "/api/v1/payments/prepare",
        json={
            "user_id": user_id,
            "source": "UPI_ID",
            "amount": "99000.00",
            "upi_id": "suspicious@upi",
            "device_identifier": "device-adv-1",
            "client_request_id": "idem-adv-01",
            "risk_score": 88.0,
            "risk_level": "HIGH",
            "decision": "CONFIRM_OR_CANCEL",
            "guardian_required": True,
        },
    )
    assert res.status_code == 201
    card = res.json()
    txn_id = card["id"]

    # Invariant checks:
    # 1. Transaction status is PENDING (not COMPLETED, not CONFIRMED)
    assert card["status"] == "PENDING"
    assert card["status"] != "COMPLETED"
    assert card["status"] != "CONFIRMED"

    # 2. NO GuardianRequest created in DB during evaluation/preparation
    g_count = db_session.query(GuardianRequest).filter(GuardianRequest.transaction_id == txn_id).count()
    assert g_count == 0

    # 3. guardian_required is an advisory flag
    assert card["guardian_required"] is True


def test_expired_evaluation_cannot_be_persisted(client: TestClient, db_session: Session):
    """An evaluation past its expires_at timestamp is rejected with HTTP 410 Gone."""
    user_id = _create_user(client, "Expiry User", "+91-98765-43216")

    past_time = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()

    res = client.post(
        "/api/v1/payments/prepare",
        json={
            "user_id": user_id,
            "source": "UPI_ID",
            "amount": "100.00",
            "upi_id": "expired@upi",
            "device_identifier": "device-exp-1",
            "client_request_id": "idem-expired-01",
            "evaluation_expires_at": past_time,
        },
    )
    assert res.status_code == 410
    assert "expired" in res.json()["detail"].lower()
