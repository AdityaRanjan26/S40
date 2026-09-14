"""
risk_service — shared risk-evaluation logic behind both the pre-existing
`POST /api/v1/risk/evaluate` and the new `POST /api/v1/payments/{id}/analyse`
(AVARAN PAY spec §4, §11). Extracted verbatim from app/api/routers/risk.py's
evaluate_risk handler so the two entry points can't drift — no behavior
change for the existing endpoint.
"""

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional


from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.security import hash_identifier
from app.models.alert import Alert
from app.models.enums import AlertStatus, PaymentWorkflowStage, RiskDecision, RiskLevel
from app.models.enums import TransactionStatus as S
from app.models.recipient import Recipient
from app.models.transaction import Transaction
from app.models.user import User
from app.repositories import (
    device_repository,
    risk_repository,
    transaction_repository,
    user_feedback_repository,
    user_pattern_repository,
)
from ml.inference.predict import get_predictor

logger = logging.getLogger(__name__)

UPI_REGEX = re.compile(r"^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z0-9.\-_]{2,64}$")
PHONE_REGEX = re.compile(r"^[6-9]\d{9}$")


def parse_and_validate_recipient(recipient_raw: Any) -> tuple[str, str]:
    """Validates recipient format. Returns (normalized_recipient, recipient_type).

    Recipient must be either a valid UPI ID (e.g. name@bank) or a 10-digit Indian mobile number.
    Raises HTTPException(422) if format is invalid.
    """
    if not recipient_raw or not isinstance(recipient_raw, str):
        raise HTTPException(
            status_code=422,
            detail="Invalid recipient: must be a valid UPI ID (e.g. name@bank) or 10-digit Indian mobile number.",
        )

    trimmed = recipient_raw.strip()
    if not trimmed:
        raise HTTPException(
            status_code=422,
            detail="Invalid recipient: must be a valid UPI ID (e.g. name@bank) or 10-digit Indian mobile number.",
        )

    if "@" in trimmed:
        if UPI_REGEX.fullmatch(trimmed) and not re.search(r"\s", trimmed):
            return trimmed.lower(), "UPI_ID"
        raise HTTPException(
            status_code=422,
            detail="Invalid recipient: must be a valid UPI ID (e.g. name@bank) or 10-digit Indian mobile number.",
        )

    clean_phone = re.sub(r"[\s\-\(\)]", "", trimmed)
    if clean_phone.startswith("+91"):
        clean_phone = clean_phone[3:]
    elif clean_phone.startswith("91") and len(clean_phone) == 12:
        clean_phone = clean_phone[2:]

    if PHONE_REGEX.fullmatch(clean_phone):
        return clean_phone, "PHONE"

    raise HTTPException(
        status_code=422,
        detail="Invalid recipient: must be a valid UPI ID (e.g. name@bank) or 10-digit Indian mobile number.",
    )


def resolve_recipient_details(
    db: Session, normalized: str, rec_type: str, user_id: Optional[int] = None
) -> tuple[Optional[str], str]:
    """Resolves recipient against Recipient and User tables using hashed identifiers.

    Returns (display_name, resolution_status).
    Never fabricates names or mutates handles.
    """
    h = hash_identifier(normalized)

    if rec_type == "UPI_ID":
        query = db.query(Recipient).filter(Recipient.recipient_hash == h)
        if user_id is not None:
            user_rec = query.filter(Recipient.user_id == user_id).first()
            if user_rec and user_rec.display_name:
                return user_rec.display_name, "RESOLVED"
        rec = query.first()
        if rec and rec.display_name:
            return rec.display_name, "RESOLVED"
        return None, "UNVERIFIED"

    # rec_type == "PHONE"
    u = db.query(User).filter(User.phone_hash == h).first()
    if u and u.name:
        return u.name, "RESOLVED"

    query = db.query(Recipient).filter(Recipient.recipient_hash == h)
    if user_id is not None:
        user_rec = query.filter(Recipient.user_id == user_id).first()
        if user_rec and user_rec.display_name:
            return user_rec.display_name, "RESOLVED"
    rec = query.first()
    if rec and rec.display_name:
        return rec.display_name, "RESOLVED"

    return None, "UNRESOLVED"


def evaluate_prepayment(db: Session, payload: dict, device_id: Optional[str] = None) -> dict:
    """Authoritative pre-payment evaluation endpoint logic.

    Evaluates a payment draft BEFORE transaction creation:
    1. Validates recipient format (UPI ID or Indian mobile) and amount (> 0).
    2. Resolves recipient against DB (never invents names or appends @upi).
    3. Runs ML prediction engine with feature extraction.
    4. Returns stage: EVALUATION_COMPLETED, risk score, risk level, decision, reasons.
    5. Purely advisory: guarantees NO transaction is created or mutated, NO alert is created,
       and NO guardian approval is triggered.

    `device_id` is the caller's raw per-install identifier (the mobile
    client's X-Device-Id header, already sent on every request — see
    api-client.ts's getDevicePayload()). It's hashed the same way
    transaction_service.create_transaction hashes a device identifier
    before it's ever compared against this user's known device_hash rows,
    so DeviceFeatureExtractor's `new_device` flag reflects whether this is
    genuinely a device this user has transacted from before, instead of
    being permanently stuck at "new" for every call (see device_features.py
    docstring / the prior hardcoded "MOBILE_APP" placeholder this replaced).
    """
    recipient_raw = payload.get("recipient")
    normalized_recipient, rec_type = parse_and_validate_recipient(recipient_raw)

    raw_amount = payload.get("amount")
    if raw_amount is None:
        raise HTTPException(status_code=422, detail="Amount is required.")
    try:
        amount = float(raw_amount)
    except (ValueError, TypeError):
        raise HTTPException(status_code=422, detail="Amount must be a valid number.")

    if amount <= 0:
        raise HTTPException(status_code=422, detail="Amount must be greater than zero.")

    user_id = payload.get("user_id")
    user_id_int = int(user_id) if (user_id is not None and str(user_id).isdigit()) else None

    display_name, resolution_status = resolve_recipient_details(
        db, normalized_recipient, rec_type, user_id=user_id_int
    )

    user = db.query(User).filter(User.id == user_id_int).first() if user_id_int else None
    user_profile = dict(user.risk_profile) if (user and user.risk_profile) else {}

    if resolution_status == "RESOLVED":
        frequent = user_profile.get("frequent_recipients", [])
        if isinstance(frequent, list) and normalized_recipient not in frequent:
            frequent = list(frequent) + [normalized_recipient]
        user_profile["frequent_recipients"] = frequent

    # Real per-user device history: same hash space transaction_service
    # writes device_hash in, so DeviceFeatureExtractor's raw-equality
    # `device_id in known_devices` check actually means something instead
    # of always missing.
    hashed_device_id = hash_identifier(device_id) if device_id else None
    if user_id_int:
        user_profile["known_devices"] = device_repository.list_device_hashes(db, user_id=user_id_int)

    # Real trained spending baseline (statement_parser_service.py /
    # user_pattern_trainer.py) instead of BehaviourFeatureExtractor's
    # generic ₹1000/₹500 defaults — only overridden once this user has an
    # actual trained percentile, so a genuinely cold-start user still gets
    # the extractor's own sane defaults rather than a fabricated zero.
    if user_id_int:
        profile = user_pattern_repository.get_or_create_profile(db, user_id_int)
        if profile.p50_amount is not None:
            user_profile["normal_avg_amount"] = float(profile.p50_amount)
            if profile.p90_amount is not None:
                # p90 sits ~1.2816 standard deviations above the mean for a
                # normal distribution — a standard, honest way to back out
                # an implied std-dev from two percentiles when the raw
                # per-transaction values aren't retained (see
                # user_pattern_trainer.py; only percentiles are stored).
                user_profile["normal_std_amount"] = max(
                    (float(profile.p90_amount) - float(profile.p50_amount)) / 1.2816, 100.0
                )

    # Real per-recipient payment history + explicit-confirmation count, for
    # ml/profiles/recurring_pattern.py's cadence detection — lets a
    # recognized recurring payment (e.g. monthly rent) score LOW instead of
    # being flagged every time it deviates from the user's GLOBAL average.
    recipient_db_id: Optional[int] = None
    if user_id_int:
        recipient_row = (
            db.query(Recipient)
            .filter(
                Recipient.user_id == user_id_int,
                Recipient.recipient_hash == hash_identifier(normalized_recipient),
            )
            .first()
        )
        if recipient_row is not None:
            recipient_db_id = recipient_row.id
            user_profile["recipient_history"] = transaction_repository.get_transactions_for_recipient(
                db, user_id=user_id_int, recipient_id=recipient_db_id
            )
            user_profile["recipient_confirmations"] = user_feedback_repository.count_confirmations_for_recipient(
                db, user_id=user_id_int, recipient_id=recipient_db_id
            )

    predictor = get_predictor()
    inference_input = {
        "transaction": {
            "transaction_id": "PREPAYMENT_EVAL",
            "amount": amount,
            "recipient_id": normalized_recipient,
            "recipient_db_id": recipient_db_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "device_id": hashed_device_id or "MOBILE_APP",
            "location": "",
            "voice_transcript": "",
            "note": payload.get("note") or "",
        },
        "user_profile": user_profile,
    }

    try:
        decision_package = predictor.predict(inference_input)
    except Exception:
        logger.exception("ML pre-payment risk scoring failed for recipient=%s", normalized_recipient)
        raise HTTPException(
            status_code=503,
            detail="Risk scoring is temporarily unavailable. Please try again.",
        )

    # Advisory-only check: determine if Guardian would be required if payment were authorized/submitted
    guardian_required = False
    if str(decision_package["risk_level"]) == "HIGH" and user_id_int:
        from app.repositories import guardian_repository
        contacts = guardian_repository.get_trusted_contacts_by_user(db, user_id_int)
        if contacts:
            guardian_required = True

    eval_time = datetime.now(timezone.utc)
    expires_at = eval_time + timedelta(minutes=15)
    eval_id = f"EVAL-{uuid.uuid4().hex[:12]}"

    return {
        "evaluation_id": eval_id,
        "stage": PaymentWorkflowStage.EVALUATION_COMPLETED.value,
        "risk_score": float(decision_package["risk_score"]),
        "risk_level": str(decision_package["risk_level"]),
        "decision": str(decision_package["decision"]),
        "plain_language_reasons": decision_package.get("plain_language_reasons", []),
        "risk_factors": decision_package.get("risk_factors", []),
        "risk_contributions_pct": decision_package.get("risk_contributions_pct", {}),
        "sub_scores": decision_package.get("sub_scores", {}),
        "recipient": {
            "raw_input": str(recipient_raw),
            "normalized": normalized_recipient,
            "recipient_type": rec_type,
            "display_name": display_name,
            "resolution_status": resolution_status,
        },
        "amount": amount,
        "note": payload.get("note"),
        "qr_data": payload.get("qr_data"),
        "latency_ms": decision_package.get("latency_ms", 0.0),
        "timestamp": eval_time.isoformat(),
        "expires_at": expires_at.isoformat(),
        "guardian_required": guardian_required,
        "disclaimer": "Advisory pre-payment evaluation only. No payment authorized or initiated.",
    }



def evaluate(db: Session, txn_id: Optional[int], raw_payload: Optional[dict] = None) -> dict:
    """Run live ML risk scoring for an existing transaction (txn_id) or a raw
    payload (raw_payload, used when no persisted transaction exists yet).
    Persists RiskScore/RiskFactor rows and mutates the transaction's status/
    authorization flags by risk band when a transaction is given. Returns the
    raw decision package from the predictor."""
    predictor = get_predictor()

    txn: Optional[Transaction] = transaction_repository.get_transaction(db, txn_id) if txn_id else None

    if txn:
        user_risk_profile = dict(txn.user.risk_profile) if txn.user and txn.user.risk_profile else {}

        # Same recurring-payment wiring as evaluate_prepayment (see that
        # function's comment) — this is the path that actually creates
        # Alerts and mutates transaction status, so it matters at least as
        # much that a recognized recurring payment scores LOW here.
        user_risk_profile["recipient_history"] = transaction_repository.get_transactions_for_recipient(
            db, user_id=txn.user_id, recipient_id=txn.recipient_id
        )
        user_risk_profile["recipient_confirmations"] = user_feedback_repository.count_confirmations_for_recipient(
            db, user_id=txn.user_id, recipient_id=txn.recipient_id
        )

        inference_input = {
            "transaction": {
                "transaction_id": str(txn.id),
                "amount": float(txn.amount),
                "recipient_id": str(txn.recipient_id),
                "recipient_db_id": txn.recipient_id,
                "timestamp": txn.timestamp.isoformat() if txn.timestamp else "",
                "device_id": str(txn.device_id),
                "location": txn.location or "",
                "voice_transcript": "",
            },
            "user_profile": user_risk_profile,
        }
    else:
        payload = raw_payload or {}
        inference_input = payload if "transaction" in payload else {"transaction": payload, "user_profile": payload.get("user_profile", {})}

    try:
        decision_package = predictor.predict(inference_input)
    except Exception:
        logger.exception("ML risk scoring failed for transaction_id=%s", txn.id if txn else txn_id)
        raise

    level_map = {"LOW": RiskLevel.LOW, "MEDIUM": RiskLevel.MEDIUM, "HIGH": RiskLevel.HIGH}
    decision_map = {
        "ALLOW": RiskDecision.ALLOW,
        "WARN_CHOICE": RiskDecision.WARN,
        "CONFIRM_OR_CANCEL": RiskDecision.CONFIRM_OR_CANCEL,
    }
    r_level = level_map.get(decision_package["risk_level"], RiskLevel.LOW)
    r_dec = decision_map.get(decision_package["decision"], RiskDecision.ALLOW)

    factors_to_save = []
    for factor_name in decision_package.get("risk_factors", []):
        pct = decision_package.get("risk_contributions_pct", {}).get(factor_name, 0.0)
        factors_to_save.append(
            {
                "factor_type": "ml_signal",
                "name": factor_name,
                "contribution": pct,
                "explanation": factor_name.replace("_", " ").title(),
            }
        )

    if txn:
        saved_score = risk_repository.save_risk_evaluation(
            db,
            transaction_id=txn.id,
            fraud_probability=float(decision_package.get("sub_scores", {}).get("transaction_fraud", 0.0)),
            final_score=float(decision_package["risk_score"]),
            risk_level=r_level,
            decision=r_dec,
            risk_factors=factors_to_save,
        )

        if r_level == RiskLevel.HIGH:
            txn.authorization_required = True
            txn.authorization_status = "PENDING"
            txn.status = S.PENDING_AUTHORIZATION
        elif r_level == RiskLevel.LOW and txn.status == S.PENDING:
            txn.authorization_required = False
            txn.authorization_status = "NONE"
            txn.status = S.ALLOWED
        elif r_level == RiskLevel.MEDIUM and txn.status == S.PENDING:
            txn.authorization_required = False
            txn.authorization_status = "NONE"
            txn.status = S.AWAITING_CONFIRMATION

        if r_level in (RiskLevel.HIGH, RiskLevel.MEDIUM):
            alert = Alert(
                transaction_id=txn.id,
                risk_score_id=saved_score.id,
                severity=r_level,
                summary="; ".join(decision_package.get("plain_language_reasons", []))
                or f"Flagged {r_level.value} Risk UPI Payment (₹{txn.amount})",
                status=AlertStatus.OPEN,
            )
            db.add(alert)
        db.commit()

    return decision_package
