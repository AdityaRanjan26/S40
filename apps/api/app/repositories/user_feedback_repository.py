from sqlalchemy.orm import Session

from app.models.enums import UserDecision
from app.models.transaction import Transaction
from app.models.user_feedback import UserFeedback


def count_confirmations_for_recipient(db: Session, user_id: int, recipient_id: int) -> int:
    """How many times this user has explicitly confirmed (via
    payment_lifecycle_service.confirm's UserFeedback write) a payment to
    this recipient — the "explicit trust" fast path in
    ml/profiles/recurring_pattern.py's MIN_CONFIRMATIONS_FOR_TRUST, an
    alternative to purely cadence-based pattern establishment."""
    return (
        db.query(UserFeedback)
        .join(Transaction, UserFeedback.transaction_id == Transaction.id)
        .filter(
            Transaction.user_id == user_id,
            Transaction.recipient_id == recipient_id,
            UserFeedback.user_decision == UserDecision.CONFIRM,
        )
        .count()
    )
