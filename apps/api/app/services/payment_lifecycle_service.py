"""
payment_lifecycle_service — shared logic behind both `/api/v1/payments/*`
(AVARAN PAY spec-shaped surface) and the pre-existing `/api/v1/transactions/*`
(mobile-facing surface). One implementation so the two entry points can't
diverge (spec §2: "the frontend must not maintain a separate authoritative
transaction state" applies just as much to two backend surfaces disagreeing
with each other).
"""

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_identifier
from app.models.enums import GuardianOutcome, UserDecision
from app.models.enums import TransactionStatus as S
from app.models.transaction import Transaction
from app.models.user_feedback import UserFeedback
from app.repositories import guardian_repository, transaction_repository, user_pattern_repository
from app.services import notification_service
from app.services.exceptions import DomainError, TransactionNotFoundError
from app.services.security_audit_service import SecurityAuditService
from app.services.transaction_integrity_service import TransactionIntegrityService
from app.services.transaction_state_machine import is_terminal, transition


class PaymentNotEligibleError(DomainError):
    """Raised when a transaction is in a state that doesn't permit the requested action."""


class PaymentMismatchError(DomainError):
    """Raised when a launch-upi payload's amount/recipient don't match the analysed transaction."""


class AuthorizationExpiredError(DomainError):
    """Raised when a biometric/device authorization is older than the configured max age."""


class AuthorizationRequiredError(DomainError):
    """Raised when a pending Guardian/biometric authorization step blocks
    confirmation. Maps to HTTP 403 (distinct from a plain 400 "not
    eligible" state error), matching this repo's pre-existing convention."""


class TransactionIntegrityViolationError(DomainError):
    """Raised when a transaction's bound integrity hash no longer matches its
    current details — amount/recipient/etc. changed after authorization or
    Guardian approval. Maps to HTTP 409, distinct from a plain 400 "not
    eligible" error."""


@dataclass
class ConfirmResult:
    transaction: Transaction
    duplicate: bool


def _get_transaction_or_raise(db: Session, transaction_id: int) -> Transaction:
    txn = transaction_repository.get_transaction(db, transaction_id)
    if txn is None:
        raise TransactionNotFoundError(f"Transaction {transaction_id} not found.")
    return txn


def launch_upi(
    db: Session,
    transaction_id: int,
    *,
    app: str,
    amount: Decimal,
    recipient_identifier: str,
) -> Transaction:
    txn = _get_transaction_or_raise(db, transaction_id)

    if is_terminal(txn.status) or txn.status == S.PAYMENT_PENDING:
        raise PaymentNotEligibleError(
            f"Cannot launch a UPI app for a transaction in status {txn.status.value}."
        )
    if txn.status == S.PENDING_GUARDIAN_APPROVAL:
        raise PaymentNotEligibleError("Transaction is awaiting Guardian approval and cannot launch UPI yet.")

    recipient_hash = hash_identifier(str(recipient_identifier))
    recipient_matches = bool(txn.recipient) and txn.recipient.recipient_hash == recipient_hash
    amount_matches = Decimal(str(txn.amount)) == Decimal(str(amount))
    if not (recipient_matches and amount_matches):
        SecurityAuditService.log_event(
            "TRANSACTION_BLOCKED",
            user_id=txn.user_id,
            transaction_id=txn.id,
            details={"reason": "launch_upi_payload_mismatch"},
            db=db,
        )
        raise PaymentMismatchError(
            "UPI launch payload amount/recipient do not match the analysed transaction."
        )

    txn.upi_app = app
    txn.upi_launch_at = datetime.now(timezone.utc)
    txn.upi_launch_count = (txn.upi_launch_count or 0) + 1
    db.commit()
    db.refresh(txn)

    SecurityAuditService.log_event(
        "UPI_APP_SELECTED", user_id=txn.user_id, transaction_id=txn.id, details={"app": app}, db=db
    )
    SecurityAuditService.log_event(
        "UPI_LAUNCH_ATTEMPTED",
        user_id=txn.user_id,
        transaction_id=txn.id,
        details={"app": app, "launch_count": txn.upi_launch_count},
        db=db,
    )

    return transition(db, txn, S.PAYMENT_PENDING)


def confirm(db: Session, transaction_id: int, *, utr_reference: Optional[str] = None) -> ConfirmResult:
    txn = _get_transaction_or_raise(db, transaction_id)

    # Duplicate confirmation against an already-completed transaction (spec
    # §12/§14): safe, deterministic, no error, no second row.
    if txn.status == S.COMPLETED:
        SecurityAuditService.log_event(
            "DUPLICATE_CONFIRMATION_ATTEMPTED", user_id=txn.user_id, transaction_id=txn.id, db=db
        )
        return ConfirmResult(transaction=txn, duplicate=True)

    if is_terminal(txn.status):
        raise PaymentNotEligibleError(f"Cannot confirm a transaction in terminal status {txn.status.value}.")

    if txn.status == S.PENDING_GUARDIAN_APPROVAL:
        raise PaymentNotEligibleError("Transaction is awaiting Guardian approval and cannot be confirmed directly.")

    pending_req = guardian_repository.get_pending_request_for_transaction(db, txn.id)
    if pending_req:
        raise AuthorizationRequiredError("Transaction is awaiting trusted contact approval.")

    if txn.authorization_required:
        if txn.authorization_status != "AUTHORIZED":
            raise AuthorizationRequiredError("High-risk transaction requires biometric authorization before confirmation.")

        if txn.authorized_at:
            authorized_at = (
                txn.authorized_at.replace(tzinfo=timezone.utc)
                if txn.authorized_at.tzinfo is None
                else txn.authorized_at
            )
            age = (datetime.now(timezone.utc) - authorized_at).total_seconds()
            if age > settings.authorization_max_age_seconds:
                txn.authorization_status = "PENDING"
                txn.integrity_hash = None
                txn.guardian_integrity_hash = None
                txn.status = S.PENDING_AUTHORIZATION
                for req in txn.guardian_requests:
                    if req.outcome == GuardianOutcome.APPROVED:
                        req.outcome = GuardianOutcome.INVALIDATED
                        req.resolution_notes = "Guardian approval invalidated: authorization expired."
                db.commit()
                SecurityAuditService.log_event(
                    "BIOMETRIC_FAILED",
                    user_id=txn.user_id,
                    transaction_id=txn.id,
                    details={"reason": "authorization_expired", "age_seconds": int(age)},
                    db=db,
                )
                raise AuthorizationExpiredError(
                    "Authorization has expired and must be repeated before confirming."
                )

        if not TransactionIntegrityService.verify_integrity(txn, txn.integrity_hash):
            txn.authorization_status = "PENDING"
            txn.integrity_hash = None
            txn.guardian_integrity_hash = None
            txn.status = S.PENDING_AUTHORIZATION
            for req in txn.guardian_requests:
                if req.outcome == GuardianOutcome.APPROVED:
                    req.outcome = GuardianOutcome.INVALIDATED
                    req.resolution_notes = "Guardian approval invalidated due to transaction details modification."
            db.commit()
            SecurityAuditService.log_event(
                "TRANSACTION_INTEGRITY_VIOLATION",
                user_id=txn.user_id,
                transaction_id=txn.id,
                details={"action": "confirmation_rejected_authorization_invalidated"},
                db=db,
            )
            raise TransactionIntegrityViolationError(
                "Transaction details changed after security approval. Previous authorization has been invalidated."
            )

    if utr_reference:
        txn.utr_reference = utr_reference
        db.commit()
        db.refresh(txn)

    txn = transition(db, txn, S.CONFIRMED)
    SecurityAuditService.log_event("PAYMENT_CONFIRMED", user_id=txn.user_id, transaction_id=txn.id, db=db)

    txn = transition(db, txn, S.COMPLETED)
    SecurityAuditService.log_event("TRANSACTION_COMPLETED", user_id=txn.user_id, transaction_id=txn.id, db=db)

    # Demand-driven trigger for the personalized transaction-pattern engine
    # (app/services/user_pattern_trainer.py) — a cheap counter bump, never
    # allowed to fail the actual payment confirmation it rides on.
    try:
        user_pattern_repository.increment_pending_transactions(db, txn.user_id)
    except Exception:
        pass

    # Explicit "user confirmed this payment" signal for
    # ml/profiles/recurring_pattern.py's confirmation fast path (an
    # alternative to waiting for pure cadence detection to repeat
    # naturally) — UserFeedback.transaction_id has a UNIQUE constraint, so
    # this guards the same idempotent-repeat-confirmation case this
    # function already handles above (txn.status == S.COMPLETED early
    # return) without relying solely on that guard.
    try:
        existing_feedback = (
            db.query(UserFeedback).filter(UserFeedback.transaction_id == txn.id).first()
        )
        if existing_feedback is None:
            db.add(
                UserFeedback(
                    transaction_id=txn.id,
                    user_decision=UserDecision.CONFIRM,
                    feedback_type="user_confirmed_payment",
                )
            )
            db.commit()
    except Exception:
        db.rollback()

    notification_service.notify(
        db,
        user_id=txn.user_id,
        type="TRANSACTION_COMPLETED",
        title="Payment completed",
        body=f"Your payment of ₹{txn.amount} was completed successfully.",
        transaction_id=txn.id,
    )

    return ConfirmResult(transaction=txn, duplicate=False)


def cancel(db: Session, transaction_id: int) -> ConfirmResult:
    txn = _get_transaction_or_raise(db, transaction_id)

    if txn.status == S.CANCELLED:
        return ConfirmResult(transaction=txn, duplicate=True)

    if is_terminal(txn.status):
        raise PaymentNotEligibleError(f"Cannot cancel a transaction in terminal status {txn.status.value}.")

    txn = transition(db, txn, S.CANCELLED)
    SecurityAuditService.log_event("TRANSACTION_CANCELLED", user_id=txn.user_id, transaction_id=txn.id, db=db)
    notification_service.notify(
        db,
        user_id=txn.user_id,
        type="TRANSACTION_CANCELLED",
        title="Payment cancelled",
        body=f"Your payment of ₹{txn.amount} was cancelled. Your money is safe.",
        transaction_id=txn.id,
    )
    return ConfirmResult(transaction=txn, duplicate=False)
