"""
Automated unit & integration tests for Production Hardening:
- Cryptographic Key Separation (dedicated transaction integrity key)
- Production Secret Validation
- Production OTP Provider Safety
- HTTPS / Reverse-Proxy Enforcement
- Structured Security Audit Logging & Privacy Redaction
"""

from decimal import Decimal
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import Settings, validate_production_configuration, settings
from app.core.database import get_db
from app.main import app
from app.models.enums import TransactionStatus
from app.models.recipient import Recipient
from app.models.transaction import Transaction
from app.models.user import User
from app.services.security_audit_service import SecurityAuditService
from app.services.transaction_integrity_service import TransactionIntegrityService


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


def test_transaction_integrity_uses_dedicated_key():
    """Verify transaction integrity uses dedicated key, separated from SECRET_KEY."""
    mock_txn = type(
        "MockTxn",
        (),
        {
            "id": 101,
            "user_id": 5,
            "recipient_id": 9,
            "recipient": type("Recip", (), {"recipient_hash": "recip_hash_abc"})(),
            "amount": Decimal("15000.00"),
            "payment_method": "UPI",
            "location": "Mumbai",
        },
    )()

    orig_key = settings.transaction_integrity_key
    orig_secret = settings.secret_key
    try:
        settings.transaction_integrity_key = "test-dedicated-integrity-key-32-chars-long"
        hash1 = TransactionIntegrityService.compute_integrity_hash(mock_txn)

        # Changing general secret key MUST NOT change the integrity hash
        settings.secret_key = "completely-different-general-secret-key-12345"
        hash2 = TransactionIntegrityService.compute_integrity_hash(mock_txn)
        assert hash1 == hash2
        assert TransactionIntegrityService.verify_integrity(mock_txn, hash1) is True
    finally:
        settings.transaction_integrity_key = orig_key
        settings.secret_key = orig_secret


def test_production_secret_validation_rejects_insecure_defaults():
    """Verify startup validation aborts if production environment has default dev secrets."""
    insecure_prod_settings = Settings(
        environment="production",
        secret_key="s40-dev-general-secret-key-change-me",
        transaction_integrity_key="avaran-dedicated-txn-integrity-key-dev-only",
        hash_pepper="s40-dev-only-pepper-change-me",
        contact_info_encryption_key="_SiZeLTNC9qRCBhjjnil3lbCAYqQYDheLL-DYZ0fq1g=",
        otp_delivery_provider="mock",
        enable_dev_otp_inspection=True,
    )

    with pytest.raises(ValueError) as exc:
        validate_production_configuration(insecure_prod_settings)
    assert "Production configuration error" in str(exc.value)


def test_production_secret_validation_succeeds_with_hardened_config():
    """Verify startup validation passes with strong, independent production secrets."""
    valid_prod_settings = Settings(
        environment="production",
        secret_key="production-high-entropy-secret-key-min-32-bytes-long",
        transaction_integrity_key="production-dedicated-integrity-key-min-32-bytes",
        hash_pepper="production-strong-unique-hash-pepper-value-1234",
        contact_info_encryption_key="s40_production_real_fernet_key_placeholder_val=",
        app_data_encryption_key="s40_production_real_fernet_key_placeholder_va2=",
        otp_delivery_provider="twilio",
        enable_dev_otp_inspection=False,
        enable_demo_endpoints=False,
        cors_origin_regex=None,
    )

    # Should not raise exception
    validate_production_configuration(valid_prod_settings)


def test_production_otp_safety_rejects_mock_delivery():
    """Verify production mode rejects mock and dev OTP inspection."""
    prod_mock_settings = Settings(
        environment="production",
        secret_key="production-high-entropy-secret-key-min-32-bytes-long",
        transaction_integrity_key="production-dedicated-integrity-key-min-32-bytes",
        hash_pepper="production-strong-unique-hash-pepper-value-1234",
        contact_info_encryption_key="s40_production_real_fernet_key_placeholder_val=",
        app_data_encryption_key="s40_production_real_fernet_key_placeholder_va2=",
        otp_delivery_provider="mock",
        enable_dev_otp_inspection=False,
    )
    with pytest.raises(ValueError) as exc:
        validate_production_configuration(prod_mock_settings)
    assert "Production requires a live verified OTP delivery provider" in str(exc.value)


def test_security_audit_service_sanitizes_credentials():
    """Verify passwords, OTPs, tokens, and raw PINs are redacted from security audit logs."""
    raw_event = SecurityAuditService.log_event(
        event_type="TEST_SECURITY_EVENT",
        user_id=42,
        transaction_id=101,
        details={
            "password": "SuperSecretPassword123!",
            "otp_code": "123456",
            "token": "raw_opaque_bearer_token_xyz",
            "app_pin": "654321",
            "safe_metadata": "ValidNonSensitiveValue",
        },
    )

    details = raw_event["details"]
    assert details["password"] == "[REDACTED]"
    assert details["otp_code"] == "[REDACTED]"
    assert details["token"] == "[REDACTED]"
    assert details["app_pin"] == "[REDACTED]"
    assert details["safe_metadata"] == "ValidNonSensitiveValue"


def test_https_enforcement_in_production(client: TestClient):
    """Verify HTTP requests are blocked when HTTPS enforcement is enabled."""
    orig_enforce = settings.enforce_https
    try:
        settings.enforce_https = True
        resp = client.get("/api/v1/auth/me", headers={"x-forwarded-proto": "http"})
        assert resp.status_code == 403
        assert "HTTPS connection required" in resp.text

        # Health checks remain accessible
        health_resp = client.get("/health")
        assert health_resp.status_code == 200
    finally:
        settings.enforce_https = orig_enforce
