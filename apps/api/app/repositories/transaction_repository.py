from decimal import Decimal
from typing import Optional
from sqlalchemy.orm import Session

from app.models.enums import TransactionStatus
from app.models.transaction import Transaction


def create_transaction(
    db: Session,
    *,
    user_id: int,
    recipient_id: int,
    device_id: int,
    amount: Decimal,
    location: Optional[str],
    payment_method: Optional[str],
) -> Transaction:
    transaction = Transaction(
        user_id=user_id,
        recipient_id=recipient_id,
        device_id=device_id,
        amount=amount,
        location=location,
        payment_method=payment_method,
    )
    db.add(transaction)
    db.commit()
    db.refresh(transaction)
    return transaction


def get_transaction(db: Session, transaction_id: int) -> Optional[Transaction]:
    return db.get(Transaction, transaction_id)


def update_transaction_status(
    db: Session, transaction_id: int, status: TransactionStatus
) -> Optional[Transaction]:
    txn = db.get(Transaction, transaction_id)
    if txn is None:
        return None
    txn.status = status
    db.commit()
    db.refresh(txn)
    return txn


def list_transactions(
    db: Session,
    limit: int = 50,
    offset: int = 0,
    status: Optional[TransactionStatus] = None,
) -> list[Transaction]:
    query = db.query(Transaction)
    if status is not None:
        query = query.filter(Transaction.status == status)
    return query.order_by(Transaction.timestamp.desc()).offset(offset).limit(limit).all()


def get_transactions_for_recipient(
    db: Session, user_id: int, recipient_id: int, limit: int = 24
) -> list[Transaction]:
    """Confirmed/completed transaction history for one (user, recipient)
    pair, oldest first — feeds ml/profiles/recurring_pattern.py's cadence
    detection (recipient_pattern_features.py). Same terminal-status
    convention as get_confirmed_transactions: a PENDING/BLOCKED row was
    never actually an example of this recipient's real payment cadence.
    """
    return (
        db.query(Transaction)
        .filter(
            Transaction.user_id == user_id,
            Transaction.recipient_id == recipient_id,
            Transaction.status.in_(
                [TransactionStatus.CONFIRMED, TransactionStatus.COMPLETED]
            ),
        )
        .order_by(Transaction.timestamp.asc())
        .limit(limit)
        .all()
    )


def get_confirmed_transactions(db: Session, user_id: int) -> list[Transaction]:
    """Confirmed/completed transactions for one user — the live-history
    half of the personalized transaction-pattern baseline (see
    ml/profiles/user_pattern.py, app/services/user_pattern_trainer.py).
    Only these two terminal-success statuses count: a PENDING or BLOCKED
    row was never actually an example of "how this user normally spends."
    """
    return (
        db.query(Transaction)
        .filter(
            Transaction.user_id == user_id,
            Transaction.status.in_(
                [TransactionStatus.CONFIRMED, TransactionStatus.COMPLETED]
            ),
        )
        .order_by(Transaction.timestamp.asc())
        .all()
    )
