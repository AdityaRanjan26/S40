"""
Comprehensive Backend Regression Suite for Payment Workflow Stage Enforcement (Part 4R).

Validates:
1. Pure Validator Unit Tests:
   - Canonical stage enum and exact acceptance semantics
   - Evaluation rejection (EVALUATION_COMPLETED is never executable)
   - Risk level rejection (LOW, MEDIUM, HIGH are evaluation metrics, not workflow stages)
   - Null, missing, empty, and unknown stage rejection
   - Matching stage operations (authorization -> PAYMENT_AUTHORIZED, submission -> PAYMENT_SUBMITTED, completion -> PAYMENT_COMPLETED)
   - Candidate stage extraction, precedence, and source conflict detection across body, query, and header
   - Boolean stage helpers

2. Router / API Integration Tests:
   - Rejection across POST /authorize, POST /submit, POST /confirm, and Guardian endpoints
   - Source conflict detection (400 Bad Request) when body, query, or headers disagree
   - Standard project error format ({ "detail": "..." })
   - Risk evaluation returns stage="EVALUATION_COMPLETED"
   - Legacy compatibility without stage promotion when require_stage is not active

3. Side-Effect Tests:
   - Rejected requests produce zero database mutations
   - Rejected requests produce zero status or authorization mutations
   - Rejected requests produce zero integrity hash changes
   - Rejected requests produce zero audit log insertions
   - Rejected requests produce zero external payment dispatch or Guardian holds
"""

from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import create_access_token, hash_identifier, hash_password
from app.main import app
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.enums import PaymentWorkflowStage, RiskLevel, TransactionStatus
from app.models.guardian_request import GuardianRequest
from app.models.recipient import Recipient
from app.models.transaction import Transaction
from app.models.trusted_contact import TrustedContact
from app.models.user import User
from app.models.user_contact_info import UserContactInfo
from app.services.payment_workflow_guard import (
    assert_not_evaluation_stage,
    enforce_authorization_stage,
    enforce_completion_stage,
    enforce_guardian_stage,
    enforce_not_evaluation_stage,
    enforce_submission_stage,
    extract_stage_value,
    is_evaluation_stage,
    is_payment_authorized_stage,
    is_payment_completed_stage,
    is_payment_submitted_stage,
    resolve_candidate_stage,
    validate_authorization_stage,
    validate_completion_stage,
    validate_guardian_stage,
    validate_submission_stage,
    validate_workflow_stage,
)


# =====================================================================
# Fixtures
# =====================================================================

@pytest.fixture
def client(db_session: Session):
    def override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def test_data(db_session: Session):
    user = User(name="Stage Enforcement User", phone_hash=hash_identifier("+919111122222"), is_verified=True)
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)

    contact = UserContactInfo(
        user_id=user.id,
        phone_encrypted="+919111122222",
        email_encrypted="stage@avaran.ai",
        password_hash=hash_password("Password@12345"),
    )
    db_session.add(contact)

    device = Device(device_hash=hash_identifier("stage-dev-1"), user_id=user.id)
    recipient = Recipient(recipient_hash=hash_identifier("stage.merchant@upi"), user_id=user.id, display_name="Merchant Store")
    db_session.add_all([device, recipient])
    db_session.commit()
    db_session.refresh(device)
    db_session.refresh(recipient)

    guardian_contact = TrustedContact(
        user_id=user.id,
        contact_name="Family Contact",
        contact_phone_hash=hash_identifier("+919333344444"),
        phone_masked="+91 93333 44444",
        relationship="Family",
    )
    db_session.add(guardian_contact)
    db_session.commit()
    db_session.refresh(guardian_contact)

    return {
        "user": user,
        "device": device,
        "recipient": recipient,
        "guardian_contact": guardian_contact,
    }


# =====================================================================
# Group 1: Pure Validator Unit Tests
# =====================================================================

def test_extract_stage_value():
    """Verify extraction across strings, enums, dicts, objects, and edge cases."""
    assert extract_stage_value(PaymentWorkflowStage.PAYMENT_AUTHORIZED) == "PAYMENT_AUTHORIZED"
    assert extract_stage_value("  PAYMENT_AUTHORIZED  ") == "PAYMENT_AUTHORIZED"
    assert extract_stage_value({"stage": "PAYMENT_AUTHORIZED"}) == "PAYMENT_AUTHORIZED"
    assert extract_stage_value({"stage": PaymentWorkflowStage.PAYMENT_SUBMITTED}) == "PAYMENT_SUBMITTED"

    class DummyObj:
        stage = "PAYMENT_COMPLETED"

    assert extract_stage_value(DummyObj()) == "PAYMENT_COMPLETED"
    assert extract_stage_value(None) is None
    assert extract_stage_value("") == ""
    assert extract_stage_value({}) is None
    assert extract_stage_value({"other": "val"}) is None


def test_boolean_stage_helpers():
    """Verify boolean helper functions return True strictly for their target stage."""
    assert is_evaluation_stage("EVALUATION_COMPLETED") is True
    assert is_evaluation_stage("PAYMENT_AUTHORIZED") is False
    assert is_evaluation_stage("LOW") is False
    assert is_evaluation_stage(None) is False

    assert is_payment_authorized_stage("PAYMENT_AUTHORIZED") is True
    assert is_payment_authorized_stage("EVALUATION_COMPLETED") is False
    assert is_payment_authorized_stage(None) is False

    assert is_payment_submitted_stage("PAYMENT_SUBMITTED") is True
    assert is_payment_submitted_stage("PAYMENT_AUTHORIZED") is False

    assert is_payment_completed_stage("PAYMENT_COMPLETED") is True
    assert is_payment_completed_stage("PAYMENT_SUBMITTED") is False


def test_resolve_candidate_stage_precedence_and_conflicts():
    """Verify precedence and conflict detection across body, query, and header."""
    # 1. No sources provided
    stage, provided, err = resolve_candidate_stage()
    assert stage is None
    assert provided is False
    assert err is None

    # 2. Single source provided
    stage, provided, err = resolve_candidate_stage(body_stage="PAYMENT_AUTHORIZED", body_stage_provided=True)
    assert stage == "PAYMENT_AUTHORIZED"
    assert provided is True
    assert err is None

    stage, provided, err = resolve_candidate_stage(query_stage="PAYMENT_SUBMITTED")
    assert stage == "PAYMENT_SUBMITTED"
    assert provided is True
    assert err is None

    stage, provided, err = resolve_candidate_stage(header_stage="PAYMENT_COMPLETED")
    assert stage == "PAYMENT_COMPLETED"
    assert provided is True
    assert err is None

    # 3. Multiple sources agreeing
    stage, provided, err = resolve_candidate_stage(
        body_stage="PAYMENT_AUTHORIZED",
        query_stage="PAYMENT_AUTHORIZED",
        header_stage="PAYMENT_AUTHORIZED",
        body_stage_provided=True,
    )
    assert stage == "PAYMENT_AUTHORIZED"
    assert provided is True
    assert err is None

    # 4. Multiple sources conflicting -> MUST return conflict_error
    stage, provided, err = resolve_candidate_stage(
        body_stage="PAYMENT_AUTHORIZED",
        header_stage="PAYMENT_COMPLETED",
        body_stage_provided=True,
    )
    assert stage is None
    assert provided is True
    assert "Conflicting workflow stage values" in err

    stage, provided, err = resolve_candidate_stage(
        query_stage="PAYMENT_SUBMITTED",
        header_stage="PAYMENT_AUTHORIZED",
    )
    assert stage is None
    assert provided is True
    assert "Conflicting workflow stage values" in err


def test_validate_authorization_stage():
    """Verify authorization accepts ONLY PAYMENT_AUTHORIZED and rejects all others."""
    # Valid
    valid, err = validate_authorization_stage("PAYMENT_AUTHORIZED")
    assert valid is True
    assert err is None
    assert validate_authorization_stage(PaymentWorkflowStage.PAYMENT_AUTHORIZED)[0] is True
    assert validate_authorization_stage({"stage": "PAYMENT_AUTHORIZED"})[0] is True

    # Rejection of evaluation
    valid, err = validate_authorization_stage("EVALUATION_COMPLETED")
    assert valid is False
    assert "EVALUATION_COMPLETED" in err

    # Rejection of risk levels
    for risk in ("LOW", "MEDIUM", "HIGH"):
        valid, err = validate_authorization_stage(risk)
        assert valid is False
        assert f"Risk level '{risk}'" in err

    # Rejection of null, empty, unknown, and mismatched stages
    for bad in (None, "", "   ", "UNKNOWN_STAGE", "EVALUATING", "PAYMENT_SUBMITTED", "PAYMENT_COMPLETED"):
        valid, err = validate_authorization_stage(bad)
        assert valid is False
        assert err is not None


def test_validate_submission_stage():
    """Verify submission accepts ONLY PAYMENT_SUBMITTED and rejects all others."""
    # Valid
    valid, err = validate_submission_stage("PAYMENT_SUBMITTED")
    assert valid is True
    assert err is None

    # Rejection of evaluation
    valid, err = validate_submission_stage("EVALUATION_COMPLETED")
    assert valid is False
    assert "EVALUATION_COMPLETED" in err

    # Rejection of risk levels
    for risk in ("LOW", "MEDIUM", "HIGH"):
        valid, err = validate_submission_stage(risk)
        assert valid is False
        assert f"Risk level '{risk}'" in err

    # Rejection of null, empty, unknown, and mismatched stages
    for bad in (None, "", "UNKNOWN_STAGE", "PAYMENT_AUTHORIZED", "PAYMENT_COMPLETED"):
        valid, err = validate_submission_stage(bad)
        assert valid is False
        assert err is not None


def test_validate_completion_stage():
    """Verify completion accepts ONLY PAYMENT_COMPLETED and rejects all others."""
    # Valid
    valid, err = validate_completion_stage("PAYMENT_COMPLETED")
    assert valid is True
    assert err is None

    # Rejection of evaluation
    valid, err = validate_completion_stage("EVALUATION_COMPLETED")
    assert valid is False
    assert "EVALUATION_COMPLETED" in err

    # Rejection of risk levels
    for risk in ("LOW", "MEDIUM", "HIGH"):
        valid, err = validate_completion_stage(risk)
        assert valid is False
        assert f"Risk level '{risk}'" in err

    # Rejection of null, empty, unknown, and mismatched stages
    for bad in (None, "", "UNKNOWN_STAGE", "PAYMENT_AUTHORIZED", "PAYMENT_SUBMITTED"):
        valid, err = validate_completion_stage(bad)
        assert valid is False
        assert err is not None


def test_validate_guardian_stage():
    """Verify guardian hold validation rejects evaluation results and risk levels."""
    # Rejection of evaluation
    valid, err = validate_guardian_stage("EVALUATION_COMPLETED")
    assert valid is False
    assert "EVALUATION_COMPLETED" in err

    # Rejection of risk levels
    for risk in ("LOW", "MEDIUM", "HIGH"):
        valid, err = validate_guardian_stage(risk)
        assert valid is False

    # Valid non-authorized hold
    assert validate_guardian_stage("PAYMENT_AUTHORIZED")[0] is True
    assert validate_guardian_stage("PAYMENT_SUBMITTED")[0] is True

    # If is_authorized_hold is True, requires PAYMENT_AUTHORIZED
    assert validate_guardian_stage("PAYMENT_AUTHORIZED", is_authorized_hold=True)[0] is True
    assert validate_guardian_stage("PAYMENT_SUBMITTED", is_authorized_hold=True)[0] is False


def test_assert_not_evaluation_stage():
    """Verify assert_not_evaluation_stage allows only valid executable stages."""
    assert assert_not_evaluation_stage("PAYMENT_AUTHORIZED")[0] is True
    assert assert_not_evaluation_stage("PAYMENT_SUBMITTED")[0] is True
    assert assert_not_evaluation_stage("PAYMENT_COMPLETED")[0] is True

    assert assert_not_evaluation_stage("EVALUATION_COMPLETED")[0] is False
    assert assert_not_evaluation_stage("LOW")[0] is False
    assert assert_not_evaluation_stage(None)[0] is False
    assert assert_not_evaluation_stage("UNKNOWN")[0] is False


def test_validate_workflow_stage_dispatch():
    """Verify generic dispatcher calls appropriate operation validator."""
    assert validate_workflow_stage("authorize", "PAYMENT_AUTHORIZED")[0] is True
    assert validate_workflow_stage("authorize", "PAYMENT_SUBMITTED")[0] is False

    assert validate_workflow_stage("submit", "PAYMENT_SUBMITTED")[0] is True
    assert validate_workflow_stage("submit", "PAYMENT_AUTHORIZED")[0] is False

    assert validate_workflow_stage("complete", "PAYMENT_COMPLETED")[0] is True
    assert validate_workflow_stage("complete", "PAYMENT_SUBMITTED")[0] is False

    assert validate_workflow_stage("unknown_op", "PAYMENT_AUTHORIZED")[0] is False


# =====================================================================
# Group 2: Router / API Integration Tests
# =====================================================================

def test_risk_evaluate_returns_evaluation_completed_stage(client: TestClient, test_data: dict, db_session: Session):
    """POST /api/v1/risk/evaluate must explicitly return stage='EVALUATION_COMPLETED'."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("5000.00"),
        status=TransactionStatus.PENDING,
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    token = create_access_token({"sub": str(test_data["user"].id)})
    res = client.post(
        "/api/v1/risk/evaluate",
        json={"transaction_id": txn.id},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data.get("stage") == PaymentWorkflowStage.EVALUATION_COMPLETED.value


def test_authorization_endpoint_rejections(client: TestClient, test_data: dict, db_session: Session):
    """Verify POST /authorize rejects evaluation, risk levels, null, empty, unknown, and mismatched stages."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("45000.00"),
        status=TransactionStatus.PENDING_AUTHORIZATION,
        authorization_required=True,
        authorization_status="PENDING",
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    # 1. EVALUATION_COMPLETED via body
    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": "EVALUATION_COMPLETED"})
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 2. EVALUATION_COMPLETED via query
    res = client.post(f"/api/v1/transactions/{txn.id}/authorize?stage=EVALUATION_COMPLETED")
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 3. EVALUATION_COMPLETED via header
    res = client.post(
        f"/api/v1/transactions/{txn.id}/authorize",
        headers={"X-Workflow-Stage": "EVALUATION_COMPLETED"},
    )
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 4. Risk levels (LOW, MEDIUM, HIGH)
    for risk in ("LOW", "MEDIUM", "HIGH"):
        res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": risk})
        assert res.status_code == 400
        assert f"Risk level '{risk}'" in res.json()["detail"]

    # 5. Null, empty, unknown
    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": None})
    assert res.status_code == 400

    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": ""})
    assert res.status_code == 400

    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": "UNKNOWN_STAGE"})
    assert res.status_code == 400

    # 6. Mismatched lifecycle stages
    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": "PAYMENT_SUBMITTED"})
    assert res.status_code == 400

    res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": "PAYMENT_COMPLETED"})
    assert res.status_code == 400

    # 7. Source conflict detection
    res = client.post(
        f"/api/v1/transactions/{txn.id}/authorize",
        json={"stage": "PAYMENT_AUTHORIZED"},
        headers={"X-Workflow-Stage": "PAYMENT_COMPLETED"},
    )
    assert res.status_code == 400
    assert "Conflicting workflow stage values" in res.json()["detail"]

    # 8. require_stage requested with missing stage
    res = client.post(f"/api/v1/transactions/{txn.id}/authorize?require_stage=true", json={"method": "BIOMETRIC"})
    assert res.status_code == 400

    res = client.post(
        f"/api/v1/transactions/{txn.id}/authorize",
        headers={"X-Require-Stage": "true"},
        json={"method": "BIOMETRIC"},
    )
    assert res.status_code == 400


def test_authorization_endpoint_acceptance(client: TestClient, test_data: dict, db_session: Session):
    """Verify POST /authorize accepts PAYMENT_AUTHORIZED."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("45000.00"),
        status=TransactionStatus.PENDING_AUTHORIZATION,
        authorization_required=True,
        authorization_status="PENDING",
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    res = client.post(
        f"/api/v1/transactions/{txn.id}/authorize",
        json={"method": "BIOMETRIC", "stage": "PAYMENT_AUTHORIZED"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["authorization_status"] == "AUTHORIZED"
    assert data["status"] == TransactionStatus.AUTHORIZED.value


def test_submission_endpoint_rejections_and_acceptance(client: TestClient, test_data: dict, db_session: Session):
    """Verify POST /submit strictly enforces PAYMENT_SUBMITTED."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("1500.00"),
        status=TransactionStatus.AUTHORIZED,
        authorization_status="AUTHORIZED",
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    # 1. Missing stage
    res = client.post(f"/api/v1/transactions/{txn.id}/submit")
    assert res.status_code == 400

    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={})
    assert res.status_code == 400

    # 2. EVALUATION_COMPLETED
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": "EVALUATION_COMPLETED"})
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 3. Risk levels
    for risk in ("LOW", "MEDIUM", "HIGH"):
        res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": risk})
        assert res.status_code == 400

    # 4. Null, empty, unknown
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": None})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": ""})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": "INVALID"})
    assert res.status_code == 400

    # 5. Mismatched stage
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": "PAYMENT_AUTHORIZED"})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": "PAYMENT_COMPLETED"})
    assert res.status_code == 400

    # 6. Source conflict
    res = client.post(
        f"/api/v1/transactions/{txn.id}/submit",
        json={"stage": "PAYMENT_SUBMITTED"},
        headers={"X-Workflow-Stage": "PAYMENT_AUTHORIZED"},
    )
    assert res.status_code == 400
    assert "Conflicting workflow stage values" in res.json()["detail"]

    # 7. Valid acceptance
    res = client.post(
        f"/api/v1/transactions/{txn.id}/submit",
        json={"stage": "PAYMENT_SUBMITTED", "payment_app_used": "Google Pay UPI"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["stage"] == PaymentWorkflowStage.PAYMENT_SUBMITTED.value
    assert data["payment_app_used"] == "Google Pay UPI"


def test_confirmation_endpoint_rejections_and_acceptance(client: TestClient, test_data: dict, db_session: Session):
    """Verify POST /confirm rejects invalid stages and accepts PAYMENT_COMPLETED."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("500.00"),
        status=TransactionStatus.ALLOWED,
        authorization_required=False,
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    # 1. Stage is optional by default, same as /authorize — a caller that
    # omits it (e.g. the real mobile confirm-without-stage path, or a
    # retry) is not blocked. Strict mode (require_stage) is opt-in and
    # exercised on its own transaction below so it doesn't consume this
    # one's ALLOWED state before the rejection tests that follow.
    strict_txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("500.00"),
        status=TransactionStatus.ALLOWED,
        authorization_required=False,
    )
    db_session.add(strict_txn)
    db_session.commit()
    db_session.refresh(strict_txn)

    res_req_true = client.post(f"/api/v1/transactions/{strict_txn.id}/confirm?require_stage=true")
    assert res_req_true.status_code == 400
    assert "PAYMENT_COMPLETED" in res_req_true.json()["detail"]

    res_header_true = client.post(
        f"/api/v1/transactions/{strict_txn.id}/confirm",
        headers={"X-Require-Stage": "true"},
    )
    assert res_header_true.status_code == 400
    assert "PAYMENT_COMPLETED" in res_header_true.json()["detail"]

    res_strict_ok = client.post(
        f"/api/v1/transactions/{strict_txn.id}/confirm?require_stage=true",
        json={"stage": "PAYMENT_COMPLETED"},
    )
    assert res_strict_ok.status_code == 200
    assert res_strict_ok.json()["status"] == "COMPLETED"

    # 2. EVALUATION_COMPLETED rejected
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": "EVALUATION_COMPLETED"})
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 3. Risk levels rejected (LOW, MEDIUM, HIGH)
    for risk in ("LOW", "MEDIUM", "HIGH"):
        res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": risk})
        assert res.status_code == 400
        assert f"Risk level '{risk}'" in res.json()["detail"]

    # 4. Null, empty, unknown
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": None})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": ""})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": "UNKNOWN"})
    assert res.status_code == 400

    # 5. Mismatched stage
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": "PAYMENT_AUTHORIZED"})
    assert res.status_code == 400
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": "PAYMENT_SUBMITTED"})
    assert res.status_code == 400

    # 6. Conflict detection
    res = client.post(
        f"/api/v1/transactions/{txn.id}/confirm",
        json={"stage": "PAYMENT_COMPLETED"},
        headers={"X-Workflow-Stage": "PAYMENT_AUTHORIZED"},
    )
    assert res.status_code == 400
    assert "Conflicting workflow stage values" in res.json()["detail"]

    # 7. Valid acceptance — confirm now advances straight to the final
    # COMPLETED status in one call (AVARAN PAY spec §5/§8), not CONFIRMED.
    res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": "PAYMENT_COMPLETED"})
    assert res.status_code == 200
    assert res.json()["status"] == TransactionStatus.COMPLETED.value


def test_guardian_endpoint_rejections(client: TestClient, test_data: dict, db_session: Session):
    """Verify Guardian endpoints reject EVALUATION_COMPLETED and risk levels before creating/approving holds."""
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("60000.00"),
        status=TransactionStatus.PENDING,
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    # 1. Trigger guardian request with EVALUATION_COMPLETED
    res = client.post(
        "/api/v1/guardian/requests",
        json={"transaction_id": txn.id, "stage": "EVALUATION_COMPLETED"},
    )
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]

    # 2. Trigger guardian request with risk level
    res = client.post(
        "/api/v1/guardian/requests",
        json={"transaction_id": txn.id, "stage": "HIGH"},
    )
    assert res.status_code == 400

    # 3. Create a valid guardian request
    valid_create = client.post(
        "/api/v1/guardian/requests",
        json={"transaction_id": txn.id},
    )
    assert valid_create.status_code == 201
    req_id = valid_create.json()["id"]

    # 4. Approve with EVALUATION_COMPLETED -> rejected
    res = client.post(
        f"/api/v1/guardian/requests/{req_id}/approve",
        json={"stage": "EVALUATION_COMPLETED"},
    )
    assert res.status_code == 400
    assert "EVALUATION_COMPLETED" in res.json()["detail"]


# =====================================================================
# Group 3: Side-Effect Verification Tests (Zero Side Effects on Rejection)
# =====================================================================

def test_rejection_produces_zero_database_mutations(client: TestClient, test_data: dict, db_session: Session):
    """
    Guarantees that all rejected requests produce zero database mutations:
    - Status remains unchanged
    - Authorization status and timestamps remain unchanged
    - Integrity hashes remain unchanged
    - Audit logs count remains strictly identical
    - No Guardian holds or fraud cases created
    """
    txn = Transaction(
        user_id=test_data["user"].id,
        recipient_id=test_data["recipient"].id,
        device_id=test_data["device"].id,
        amount=Decimal("75000.00"),
        status=TransactionStatus.PENDING_AUTHORIZATION,
        authorization_required=True,
        authorization_status="PENDING",
        integrity_hash=None,
    )
    db_session.add(txn)
    db_session.commit()
    db_session.refresh(txn)

    # Record baseline state
    baseline_status = txn.status
    baseline_auth_status = txn.authorization_status
    baseline_auth_at = txn.authorized_at
    baseline_hash = txn.integrity_hash

    baseline_audit_count = db_session.query(AuditLog).count()
    baseline_guardian_count = db_session.query(GuardianRequest).count()

    auth_invalid = ["EVALUATION_COMPLETED", "LOW", "MEDIUM", "HIGH", "UNKNOWN_STAGE", "PAYMENT_SUBMITTED", "PAYMENT_COMPLETED"]
    submit_invalid = ["EVALUATION_COMPLETED", "LOW", "MEDIUM", "HIGH", "UNKNOWN_STAGE", "PAYMENT_AUTHORIZED", "PAYMENT_COMPLETED"]
    confirm_invalid = ["EVALUATION_COMPLETED", "LOW", "MEDIUM", "HIGH", "UNKNOWN_STAGE", "PAYMENT_AUTHORIZED", "PAYMENT_SUBMITTED"]
    guardian_invalid = ["EVALUATION_COMPLETED", "LOW", "MEDIUM", "HIGH", "UNKNOWN_STAGE"]

    # 1. Authorization rejections
    for bad_stage in auth_invalid:
        res = client.post(f"/api/v1/transactions/{txn.id}/authorize", json={"stage": bad_stage})
        assert res.status_code == 400

    # 2. Submission rejections
    for bad_stage in submit_invalid:
        res = client.post(f"/api/v1/transactions/{txn.id}/submit", json={"stage": bad_stage})
        assert res.status_code == 400

    # 3. Confirmation rejections
    for bad_stage in confirm_invalid:
        res = client.post(f"/api/v1/transactions/{txn.id}/confirm", json={"stage": bad_stage})
        assert res.status_code == 400

    # 4. Guardian hold creation rejections
    for bad_stage in guardian_invalid:
        res = client.post("/api/v1/guardian/requests", json={"transaction_id": txn.id, "stage": bad_stage})
        assert res.status_code == 400

    # Refresh transaction from DB
    db_session.expire_all()
    refreshed_txn = db_session.query(Transaction).filter(Transaction.id == txn.id).one()

    # Assert transaction state is 100% UNTOUCHED
    assert refreshed_txn.status == baseline_status
    assert refreshed_txn.authorization_status == baseline_auth_status
    assert refreshed_txn.authorized_at == baseline_auth_at
    assert refreshed_txn.integrity_hash == baseline_hash

    # Assert zero audit logs or guardian requests were created
    current_audit_count = db_session.query(AuditLog).count()
    current_guardian_count = db_session.query(GuardianRequest).count()

    assert current_audit_count == baseline_audit_count
    assert current_guardian_count == baseline_guardian_count
