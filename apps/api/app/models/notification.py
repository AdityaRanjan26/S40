"""
notifications — AVARAN PAY spec §13. In-app notification records for
Guardian requests/outcomes, cancellations, completions, high-risk
detection, and demo generation. Distinct from `alerts`
(app/models/alert.py), which is the institution analyst console's
false-positive review queue, not a user-facing notification.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.field_encryption import EncryptedText


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    # Encrypted at rest (app/core/field_encryption.py) — these are
    # human-readable messages that routinely name a recipient/amount/
    # guardian, unlike `type`, which is just a short category tag.
    title: Mapped[str] = mapped_column(EncryptedText, nullable=False)
    body: Mapped[str] = mapped_column(EncryptedText, nullable=False)
    transaction_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("transactions.id"), nullable=True, index=True
    )
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True
    )

    user: Mapped["User"] = relationship()
    transaction: Mapped[Optional["Transaction"]] = relationship()
