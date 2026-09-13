"""
fraud_cases — spec §18.

Spec field list: id, transaction_id, status, reviewer, review_notes,
created_at.

`status` uses FraudCaseStatus, modeling the institution investigation
workflow (spec §17 False Positive Review actions: "Mark legitimate",
"Escalate", plus the general fraud-case lifecycle implied by spec §16's
false-positive concept).
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.field_encryption import EncryptedText
from app.models.enums import FraudCaseStatus


class FraudCase(Base):
    __tablename__ = "fraud_cases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), nullable=False, index=True
    )
    status: Mapped[FraudCaseStatus] = mapped_column(
        Enum(FraudCaseStatus, native_enum=False, length=32),
        default=FraudCaseStatus.OPEN,
        nullable=False,
    )
    # Pseudonymous analyst identifier — never a real name/email at this
    # prototype stage, per docs/SECURITY.md's data-minimization principle.
    reviewer: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    # Encrypted at rest (app/core/field_encryption.py) — free-text analyst notes.
    review_notes: Mapped[Optional[str]] = mapped_column(EncryptedText, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), nullable=False
    )

    transaction: Mapped["Transaction"] = relationship(back_populates="fraud_cases")
