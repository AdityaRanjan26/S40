"""
Opportunistic retraining sweep for the personalized transaction-pattern
engine — the backstop that eventually retrains a user who hit the volume
gate but hasn't opened the app since (the primary, demand-driven triggers
are user_pattern_repository.increment_pending_transactions on a confirmed
transaction, and the inline bootstrap train on a user's first statement
upload — see statement_parser_service.py).

SCALING DESIGN (target: every active user retrained roughly twice a week,
without overloading the server as user count grows toward millions):

The earlier version of this sweep processed profiles ONE AT A TIME with a
fixed 2s pause between each, inside a loop that only ran once per
`user_pattern_sweep_interval_seconds` (30 min) regardless of backlog size.
That caps total throughput at
    user_pattern_sweep_batch_size / user_pattern_sweep_interval_seconds
independent of how many users actually need retraining — for the
defaults that existed before this change (10 users / 1800s), that's
~480 retrains/day, enough for roughly 1,400 active users on a 3-day
cooldown and nowhere close to "millions."

This version fixes that by making the sweep's OWN throughput scale with
backlog instead of being hardcoded:
  1. One sweep batch is retrained CONCURRENTLY (asyncio.gather), not
     sequentially with an artificial pause — the actual CPU-bound work
     already goes through TRAINING_SEMAPHORE (app/core/concurrency.py,
     currently 2 concurrent fits) inside retrain_user_pattern itself, so
     that semaphore — not a sleep — is what bounds real resource usage.
  2. The outer loop is ADAPTIVE: a full batch (more backlog likely
     waiting) is followed by only a brief pause before sweeping again; an
     empty batch (caught up) backs off to the full configured interval.
     This means the worker naturally runs hot when there's a backlog and
     idles cheaply when there isn't, instead of a human having to
     re-tune batch_size/interval by hand every time the user base grows.
  3. Each profile is claimed atomically (user_pattern_repository
     .claim_profile_for_retrain, a single UPDATE...WHERE) before being
     retrained — required for #1's concurrency to be race-free within one
     process, and it ALSO makes it safe to run this same worker on
     multiple API server processes/pods against the same database (a
     real requirement at "millions of users" scale, where one process
     sweeping alone eventually becomes the bottleneck regardless of how
     fast its own loop is) — the database's row lock is the mutual-
     exclusion primitive, not anything in this process's memory.

Capacity math (PROPOSED, not load-tested — re-check against a real
measured avg-fit-duration before relying on this at production scale):
  required_retrains_per_second = (2 * total_active_users) / (7 * 86400)
  achievable_retrains_per_second ≈ TRAINING_SEMAPHORE_LIMIT / avg_fit_seconds
For 1,000,000 active users needing 2 retrains/week each, required ≈ 3.3/s.
fit_user_pattern (train_user_pattern.py) is a quantile/percentile
computation, not a full model fit, for the common case (see that
module's "sklearn entirely" note) — cheap relative to the 2-way
TRAINING_SEMAPHORE cap, but this has not been benchmarked here; if this
sweep's dashboard/logs ever show it consistently backlogged, the first
lever is TRAINING_SEMAPHORE (more concurrent fits), the second is running
this worker on more than one process (already race-safe per #3 above),
not a bigger user_pattern_sweep_batch_size (that only reduces DB
round-trips, it doesn't add throughput once concurrency is the bottleneck).
"""

import asyncio
import logging

from app.core.config import settings
from app.core.database import SessionLocal
from app.repositories import user_pattern_repository
from app.services.user_pattern_trainer import retrain_user_pattern

logger = logging.getLogger(__name__)


async def _retrain_one(user_id: int) -> bool:
    """Claims and retrains one profile. Returns True iff this call
    actually performed a retrain (False if another worker already claimed
    it, or if retraining itself failed after a successful claim)."""
    claim_db = SessionLocal()
    try:
        claimed = user_pattern_repository.claim_profile_for_retrain(claim_db, user_id=user_id)
    finally:
        claim_db.close()

    if not claimed:
        return False

    db = SessionLocal()
    try:
        await retrain_user_pattern(db, user_id)
        return True
    except Exception:
        logger.exception(
            "user pattern retrain failed for user_id=%s after a successful claim; "
            "re-flagging for retry on a later sweep",
            user_id,
        )
        # Without this, a transient failure (a DB hiccup, a bad statement
        # row) would silently drop the user from needs_retrain forever —
        # claim_profile_for_retrain already flipped it False, so put it
        # back rather than let them go stale until their next confirmed
        # transaction happens to cross the volume gate again.
        try:
            user_pattern_repository.get_or_create_profile(db, user_id).needs_retrain = True
            db.commit()
        except Exception:
            logger.exception("failed to re-flag user_id=%s for retry", user_id)
        return False
    finally:
        db.close()


async def sweep_once() -> int:
    """One sweep pass: claims and retrains up to
    `user_pattern_sweep_batch_size` eligible profiles CONCURRENTLY.
    Returns the count actually retrained. Split out from the loop below
    so tests can call it directly without waiting on asyncio.sleep."""
    db = SessionLocal()
    try:
        eligible = user_pattern_repository.list_eligible_profiles(
            db,
            cooldown_hours=settings.user_pattern_retrain_cooldown_hours,
            active_within_days=settings.user_pattern_active_within_days,
            limit=settings.user_pattern_sweep_batch_size,
        )
    finally:
        db.close()

    if not eligible:
        return 0

    results = await asyncio.gather(
        *(_retrain_one(profile.user_id) for profile in eligible),
        return_exceptions=False,
    )
    return sum(1 for ok in results if ok)


async def user_pattern_sweep_worker() -> None:
    """Registered in app/main.py's lifespan alongside the guardian expiry
    worker, gated by settings.enable_user_pattern_scheduler."""
    while True:
        try:
            retrained = await sweep_once()
            # A full batch suggests more backlog is likely waiting right
            # behind it — keep working with only a brief breather so
            # throughput tracks backlog size. An empty/partial batch means
            # the queue is caught up for now — back off to the full
            # interval instead of hot-looping against an empty query.
            if retrained >= settings.user_pattern_sweep_batch_size:
                await asyncio.sleep(settings.user_pattern_sweep_busy_pause_seconds)
            else:
                await asyncio.sleep(settings.user_pattern_sweep_interval_seconds)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("user pattern sweep failed; will retry next interval.")
            await asyncio.sleep(settings.user_pattern_sweep_interval_seconds)
