"""
guardian_requests — spec §6 (Guardian Approval Subsystem).

Represents a hold approval request routed to a trusted contact when a
HIGH-risk payment is detected.
"""

from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.field_encryption import EncryptedText
from app.models.enums import GuardianOutcome


class GuardianRequest(Base):
    __tablename__ = "guardian_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    trusted_contact_id: Mapped[int] = mapped_column(
        ForeignKey("trusted_contacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    outcome: Mapped[GuardianOutcome] = mapped_column(
        Enum(GuardianOutcome, native_enum=False, length=32),
        default=GuardianOutcome.PENDING,
        nullable=False,
    )
    # Encrypted at rest (app/core/field_encryption.py) — free-text notes a
    # guardian may write when approving/rejecting.
    resolution_notes: Mapped[Optional[str]] = mapped_column(EncryptedText, nullable=True)
    resolution_channel: Mapped[str] = mapped_column(String(50), nullable=False, default="WEB_CONSOLE")
    integrity_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    transaction: Mapped["Transaction"] = relationship(back_populates="guardian_requests")
    trusted_contact: Mapped["TrustedContact"] = relationship(back_populates="guardian_requests")

