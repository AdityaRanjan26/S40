"""
transactions — spec §18.

Spec field list: id, user_id, recipient_id, device_id, amount, timestamp,
location, status.

`payment_method` is a documented addition, not in spec §18's literal field
list, but present in the spec's own canonical transaction-event example
(spec §5, e.g. "payment_method": "UPI"). Kept nullable so it's additive,
not required — the smallest reversible way to avoid silently discarding a
field the spec's own example transaction includes.

`status` uses TransactionStatus (app/models/enums.py), derived from the
Allow/Warn/Confirm-or-Cancel decision flow (spec §13, §15) and the
confirm/cancel/report APIs (spec §19) — not a literal spec enum, since the
spec doesn't enumerate transaction status values itself.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.field_encryption import EncryptedText
from app.models.enums import TransactionStatus


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    recipient_id: Mapped[int] = mapped_column(
        ForeignKey("recipients.id"), nullable=False, index=True
    )
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), nullable=False, index=True)

    # Numeric (not Float) for currency — avoids floating-point rounding on
    # monetary amounts. Two decimal places matches paise/cents precision.
    amount: Mapped[Numeric] = mapped_column(Numeric(12, 2), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True
    )
    # Encrypted at rest (app/core/field_encryption.py) — free-text
    # location, potentially city/GPS-identifying.
    location: Mapped[Optional[str]] = mapped_column(EncryptedText, nullable=True)
    payment_method: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    status: Mapped[TransactionStatus] = mapped_column(
        Enum(TransactionStatus, native_enum=False, length=32),
        default=TransactionStatus.PENDING,
        nullable=False,
    )
    authorization_required: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )
    authorization_status: Mapped[Optional[str]] = mapped_column(
        String(32), default="NONE", nullable=True
    )  # "NONE", "PENDING", "AUTHORIZED", "REJECTED"
    authorized_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    authorization_method: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # "BIOMETRIC", "DEVICE_CREDENTIAL"
    integrity_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )  # Cryptographic hash bound at biometric authorization
    guardian_integrity_hash: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )  # Cryptographic hash bound at Guardian approval

    # AVARAN PAY spec additions (spec §3, §8, §9): unified payment-intake
    # source tag, idempotency dedupe key, dynamic-demo flag, and UPI-handoff
    # bookkeeping. Additive/nullable so existing rows and callers are
    # unaffected.
    source: Mapped[Optional[str]] = mapped_column(
        String(20), nullable=True
    )  # "QR" | "UPI_ID" | "MOBILE" | "PAYMENT_REQUEST" | "LINK"
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(120), nullable=True, index=True)
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    upi_app: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    upi_launch_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    upi_launch_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    utr_reference: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    user: Mapped["User"] = relationship(back_populates="transactions")
    recipient: Mapped["Recipient"] = relationship(back_populates="transactions")
    device: Mapped["Device"] = relationship(back_populates="transactions")
    risk_scores: Mapped[list["RiskScore"]] = relationship(back_populates="transaction")
    guardian_requests: Mapped[list["GuardianRequest"]] = relationship(
        "GuardianRequest", back_populates="transaction", cascade="all, delete-orphan"
    )
    voice_analyses: Mapped[list["VoiceAnalysis"]] = relationship(back_populates="transaction")

    alerts: Mapped[list["Alert"]] = relationship(back_populates="transaction")
    feedback_entries: Mapped[list["UserFeedback"]] = relationship(back_populates="transaction")
    fraud_cases: Mapped[list["FraudCase"]] = relationship(back_populates="transaction")
    model_predictions: Mapped[list["ModelPrediction"]] = relationship(
        back_populates="transaction"
    )
