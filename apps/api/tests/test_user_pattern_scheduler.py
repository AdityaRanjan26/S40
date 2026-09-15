"""
app/services/user_pattern_scheduler.py — the scalable retraining sweep
(concurrent batch processing, atomic per-profile claiming, adaptive
busy/idle pacing) and its claim primitive in user_pattern_repository.py.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models.enums import UserPersonaArchetype
from app.models.user import User
from app.models.user_financial_profile import UserFinancialProfile
from app.repositories import user_pattern_repository
from app.services import user_pattern_scheduler


def _make_user(db_session, suffix: str) -> User:
    user = User(name="Scheduler Test User", phone_hash=f"hash-scheduler-{suffix}")
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _eligible_profile(db_session, user: User) -> UserFinancialProfile:
    profile = user_pattern_repository.get_or_create_profile(db_session, user.id)
    profile.last_active_at = datetime.now(timezone.utc)
    profile.needs_retrain = True
    profile.pending_transactions_count = settings.user_pattern_min_new_transactions
    profile.last_retrained_at = None
    db_session.commit()
    return profile


# ---------------------------------------------------------------------------
# claim_profile_for_retrain — the atomic mutual-exclusion primitive
# ---------------------------------------------------------------------------

def test_claim_succeeds_once_for_an_eligible_profile(db_session):
    user = _make_user(db_session, "claim-1")
    _eligible_profile(db_session, user)

    assert user_pattern_repository.claim_profile_for_retrain(db_session, user_id=user.id) is True

    refreshed = user_pattern_repository.get_or_create_profile(db_session, user.id)
    assert refreshed.needs_retrain is False


def test_second_claim_on_the_same_profile_fails(db_session):
    """The core race-safety guarantee: two concurrent callers (two
    asyncio.gather tasks in one sweep, or two separate server processes)
    must never both win the claim for the same profile."""
    user = _make_user(db_session, "claim-2")
    _eligible_profile(db_session, user)

    first = user_pattern_repository.claim_profile_for_retrain(db_session, user_id=user.id)
    second = user_pattern_repository.claim_profile_for_retrain(db_session, user_id=user.id)

    assert first is True
    assert second is False


def test_claim_fails_for_a_profile_that_was_never_flagged(db_session):
    user = _make_user(db_session, "claim-3")
    user_pattern_repository.get_or_create_profile(db_session, user.id)  # needs_retrain defaults False

    assert user_pattern_repository.claim_profile_for_retrain(db_session, user_id=user.id) is False


# ---------------------------------------------------------------------------
# sweep_once — concurrent batch processing end to end
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sweep_once_retrains_all_eligible_profiles_in_one_pass(db_session):
    users = [_make_user(db_session, f"sweep-{i}") for i in range(3)]
    for u in users:
        _eligible_profile(db_session, u)

    retrained_count = await user_pattern_scheduler.sweep_once()

    assert retrained_count == 3
    for u in users:
        refreshed = user_pattern_repository.get_or_create_profile(db_session, u.id)
        assert refreshed.needs_retrain is False
        assert refreshed.last_retrained_at is not None


@pytest.mark.asyncio
async def test_sweep_once_skips_profiles_outside_the_active_window(db_session):
    user = _make_user(db_session, "dormant")
    profile = _eligible_profile(db_session, user)
    profile.last_active_at = datetime.now(timezone.utc) - timedelta(
        days=settings.user_pattern_active_within_days + 1
    )
    db_session.commit()

    retrained_count = await user_pattern_scheduler.sweep_once()

    assert retrained_count == 0
    refreshed = user_pattern_repository.get_or_create_profile(db_session, user.id)
    assert refreshed.needs_retrain is True  # never claimed, still waiting


@pytest.mark.asyncio
async def test_sweep_once_respects_the_cooldown(db_session):
    user = _make_user(db_session, "cooldown")
    profile = _eligible_profile(db_session, user)
    profile.last_retrained_at = datetime.now(timezone.utc) - timedelta(
        hours=settings.user_pattern_retrain_cooldown_hours - 1
    )
    db_session.commit()

    retrained_count = await user_pattern_scheduler.sweep_once()

    assert retrained_count == 0


@pytest.mark.asyncio
async def test_sweep_once_returns_zero_on_an_empty_queue(db_session):
    assert await user_pattern_scheduler.sweep_once() == 0
