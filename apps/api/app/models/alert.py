"""
alerts — listed among spec §3's core entities, no field list in §18 (same
documented gap as `recipients`). Fields below are the minimum needed to
support the Institution Dashboard's Live Risk Feed and alert APIs
(spec §17, §19: GET /api/v1/institution/alerts).

`severity` reuses RiskLevel (LOW/MEDIUM/HIGH) rather than a separate enum,
since spec's dashboard examples show the same three-level vocabulary for
alerts as for risk scores (spec §17 Live Risk Feed: 🔴 91, 🟢 12, 🟡 64).

`status` uses AlertStatus, modeling the false-positive review workflow
(spec §17: "Mark legitimate", "Escalate", "Add investigation note").
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DateTime, Enum, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.field_encryption import EncryptedText
from app.models.enums import AlertStatus, RiskLevel


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transactions.id"), nullable=False, index=True
    )
    risk_score_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("risk_scores.id"), nullable=True, index=True
    )
    severity: Mapped[RiskLevel] = mapped_column(
        Enum(RiskLevel, native_enum=False, length=16), nullable=False
    )
    status: Mapped[AlertStatus] = mapped_column(
        Enum(AlertStatus, native_enum=False, length=32),
        default=AlertStatus.OPEN,
        nullable=False,
    )
    # Encrypted at rest (app/core/field_encryption.py) — a human-readable
    # explanation that names recipients/amounts/risk factors.
    summary: Mapped[str] = mapped_column(EncryptedText, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True
    )

    transaction: Mapped["Transaction"] = relationship(back_populates="alerts")
    risk_score: Mapped[Optional["RiskScore"]] = relationship(back_populates="alerts")
