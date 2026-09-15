from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.models.enums import UserPersonaArchetype
from app.models.statement_ledger_transaction import StatementLedgerTransaction
from app.models.user_financial_profile import UserFinancialProfile
from app.models.user_model_artifact import UserModelArtifact


def get_or_create_profile(db: Session, user_id: int) -> UserFinancialProfile:
    profile = (
        db.query(UserFinancialProfile)
        .filter(UserFinancialProfile.user_id == user_id)
        .first()
    )
    if profile is None:
        profile = UserFinancialProfile(user_id=user_id, archetype=UserPersonaArchetype.GENERAL)
        db.add(profile)
        db.commit()
        db.refresh(profile)
    return profile


def touch_last_active(db: Session, profile: UserFinancialProfile) -> None:
    """Cheap 'user is active' signal — bumped on every model-sync call and
    every confirmed transaction. Feeds is_eligible_for_retrain's 14-day
    dormancy gate without any extra query."""
    profile.last_active_at = datetime.now(timezone.utc)
    db.commit()


def increment_pending_transactions(db: Session, user_id: int) -> UserFinancialProfile:
    """Bumped once per confirmed/completed transaction — the volume gate
    (>=15) in is_eligible_for_retrain reads this directly, no COUNT query
    needed at retrain-check time."""
    profile = get_or_create_profile(db, user_id)
    profile.pending_transactions_count += 1
    profile.last_active_at = datetime.now(timezone.utc)
    if profile.last_retrained_at is None or profile.pending_transactions_count >= 15:
        profile.needs_retrain = True
    db.commit()
    db.refresh(profile)
    return profile


def list_eligible_profiles(
    db: Session,
    *,
    cooldown_hours: int,
    active_within_days: int,
    limit: int,
) -> list[UserFinancialProfile]:
    """Backs the opportunistic scheduler's sweep query (app/services/
    user_pattern_scheduler.py) — needs_retrain + not-dormant + past cooldown,
    oldest-active-first, capped at `limit` per sweep.

    The cooldown/dormancy comparisons are done in Python rather than SQL:
    this repo's SQLite DateTime columns are stored naive (no tz), and
    mixing naive-stored values with an aware `now()` in a raw SQL WHERE
    would silently compare wrong. Correctness over cleverness for a query
    that runs at most once every 30 minutes.
    """
    now = datetime.now(timezone.utc)
    cooldown_cutoff = now - timedelta(hours=cooldown_hours)
    active_cutoff = now - timedelta(days=active_within_days)

    candidates = (
        db.query(UserFinancialProfile)
        .filter(UserFinancialProfile.needs_retrain.is_(True))
        .order_by(UserFinancialProfile.last_active_at.desc())
        .limit(limit * 4)  # over-fetch a little before the Python-side time filter
        .all()
    )

    def _aware(dt: Optional[datetime]) -> Optional[datetime]:
        if dt is None:
            return None
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)

    eligible = [
        p
        for p in candidates
        if _aware(p.last_active_at) is not None
        and _aware(p.last_active_at) >= active_cutoff
        and (_aware(p.last_retrained_at) is None or _aware(p.last_retrained_at) <= cooldown_cutoff)
    ]
    return eligible[:limit]


def claim_profile_for_retrain(db: Session, *, user_id: int) -> bool:
    """Atomically claims one profile for retraining: flips needs_retrain
    True->False in a single UPDATE...WHERE, returning whether THIS caller
    won the claim (rowcount == 1).

    Exists so user_pattern_scheduler.py's sweep can safely run several
    retrains concurrently (asyncio.gather over one sweep's whole batch,
    bounded by TRAINING_SEMAPHORE) — and, at real scale, so multiple API
    server processes/pods each running their own scheduler loop against
    the same database never double-train the same user in the same
    window. The UPDATE's row-level lock is the mutual-exclusion primitive
    here, not anything in application code, so it holds across processes.
    A lost race (rowcount == 0) is not an error — it means another worker
    already has this profile; the sweep just skips it.
    """
    result = db.execute(
        UserFinancialProfile.__table__.update()
        .where(
            UserFinancialProfile.user_id == user_id,
            UserFinancialProfile.needs_retrain.is_(True),
        )
        .values(needs_retrain=False)
    )
    db.commit()
    return result.rowcount == 1


def get_statement_amounts_and_hours(
    db: Session, user_id: int
) -> tuple[list[float], list[int]]:
    rows = (
        db.query(StatementLedgerTransaction)
        .filter(
            StatementLedgerTransaction.user_id == user_id,
            StatementLedgerTransaction.transaction_type == "DEBIT",
        )
        .all()
    )
    amounts = [float(r.amount) for r in rows]
    hours = [r.transaction_timestamp.hour for r in rows]
    return amounts, hours


def dedup_hash_exists(db: Session, dedup_hash: str) -> bool:
    return (
        db.query(StatementLedgerTransaction)
        .filter(StatementLedgerTransaction.dedup_hash == dedup_hash)
        .first()
        is not None
    )


def insert_statement_transaction(
    db: Session,
    *,
    user_id: int,
    amount: float,
    transaction_timestamp: datetime,
    transaction_type: str,
    dedup_hash: str,
) -> Optional[StatementLedgerTransaction]:
    if dedup_hash_exists(db, dedup_hash):
        return None
    row = StatementLedgerTransaction(
        user_id=user_id,
        amount=amount,
        transaction_timestamp=transaction_timestamp,
        transaction_type=transaction_type,
        dedup_hash=dedup_hash,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_artifact(
    db: Session,
    *,
    profile: UserFinancialProfile,
    version: str,
    kind: str,
    sha256_checksum: str,
    file_size_bytes: int,
    artifact_path: str,
) -> UserModelArtifact:
    """Deactivates any prior artifact for this user and inserts the new
    active one, in the same transaction as the profile update — a reader
    of user_model_artifacts never sees two rows marked active at once."""
    db.query(UserModelArtifact).filter(
        UserModelArtifact.user_id == profile.user_id,
        UserModelArtifact.is_active.is_(True),
    ).update({"is_active": False})

    artifact = UserModelArtifact(
        user_id=profile.user_id,
        version=version,
        kind=kind,
        sha256_checksum=sha256_checksum,
        file_size_bytes=file_size_bytes,
        artifact_path=artifact_path,
        is_active=True,
    )
    db.add(artifact)
    db.flush()

    profile.active_artifact_id = artifact.id
    db.commit()
    db.refresh(artifact)
    return artifact


def get_active_artifact(db: Session, user_id: int) -> Optional[UserModelArtifact]:
    return (
        db.query(UserModelArtifact)
        .filter(UserModelArtifact.user_id == user_id, UserModelArtifact.is_active.is_(True))
        .first()
    )


def get_artifact_by_version(
    db: Session, user_id: int, version: str
) -> Optional[UserModelArtifact]:
    return (
        db.query(UserModelArtifact)
        .filter(UserModelArtifact.user_id == user_id, UserModelArtifact.version == version)
        .first()
    )
