"""
Application configuration.

Bootstrap-scope only: this scaffold reads a small set of settings needed to
start the API and connect to the local development database. It will grow
as later phases (risk engine, ML inference, voice, auth) add their own
settings — see docs/DEVELOPMENT_PLAN.md.

No secrets are hardcoded here. Values come from environment variables /
a local .env file, which is git-ignored (see .gitignore and .env.example).
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repository root: apps/api/app/core/config.py -> core -> app -> api -> apps -> <root>
BASE_DIR = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "S40 API"
    environment: str = "development"

    # Bootstrap database: SQLite file at the repository root, per the
    # project's decision to keep Avaran.db as a reproducible local
    # development database (see scripts/seed_database.py and
    # docs/SECURITY.md). Production deployment will use PostgreSQL per
    # the specification (spec §3, §18) — that migration is a later phase,
    # not decided or implemented here.
    database_url: str = f"sqlite:///{BASE_DIR / 'Avaran.db'}"

    # General Application Secret
    secret_key: str = "s40-dev-general-secret-key-change-me"

    # Prototype-only pepper for hashing sensitive identifiers (see
    # app/core/security.py). The default below is intentionally obvious
    # and MUST be overridden via .env for anything beyond local dev — see
    # docs/SECURITY.md's open item on hashing/key management.
    hash_pepper: str = "s40-dev-only-pepper-change-me"
    integrity_secret_pepper: str = "avaran-integrity-hmac-pepper-2026"
    transaction_integrity_key: str = "avaran-dedicated-txn-integrity-key-dev-only"

    # AVARAN PAY spec §7: biometric/device verification must carry a
    # timestamp/expiry and be rejected once stale. Applied at confirmation
    # time against Transaction.authorized_at.
    authorization_max_age_seconds: int = 300

    # AVARAN PAY spec §6: Guardian background expiry sweep interval.
    guardian_expiry_sweep_interval_seconds: int = 5
    # Disabled under the test harness (see apps/api/tests/conftest.py): the
    # test suite recreates its schema per-test via Base.metadata.create_all/
    # drop_all on a shared engine, and several test files exercise FastAPI's
    # real lifespan via `with TestClient(app) as ...`; a live background
    # worker on its own thread would race that per-test schema teardown.
    enable_guardian_expiry_worker: bool = True

    # Personalized transaction-pattern engine (app/services/
    # user_pattern_scheduler.py, user_pattern_trainer.py). Opportunistic
    # sweep interval — this is the IDLE-queue backoff only (see that
    # module's own scaling-design docstring for the adaptive/concurrent
    # sweep this pairs with): when a sweep comes back empty, wait this
    # long before checking again, since retraining is demand-driven, not
    # time-driven, and there's no point polling an empty queue often.
    # When a sweep IS full, the worker uses user_pattern_sweep_busy_pause_
    # seconds instead — much shorter, so throughput tracks backlog size.
    # Disabled under the test harness for the same schema-teardown-race
    # reason as the guardian worker above.
    user_pattern_sweep_interval_seconds: int = 1800
    # Brief pause between sweeps ONLY while the queue is staying full
    # (i.e. there's real backlog) — see user_pattern_scheduler.py's
    # scaling-design docstring for the throughput math this feeds.
    user_pattern_sweep_busy_pause_seconds: int = 5
    enable_user_pattern_scheduler: bool = True
    # How many eligible profiles one sweep fetches per DB round-trip and
    # retrains CONCURRENTLY (bounded by TRAINING_SEMAPHORE, not by this
    # number — see user_pattern_scheduler.py). Larger mainly reduces query
    # overhead at scale; it does not by itself increase throughput once
    # the semaphore is the real bottleneck.
    user_pattern_sweep_batch_size: int = 50
    # Retraining eligibility gates (all three required) — see
    # user_pattern_trainer.py::is_eligible_for_retrain.
    # 84h = exactly twice a week (168h / 2) — the stated target cadence.
    user_pattern_retrain_cooldown_hours: int = 84
    user_pattern_min_new_transactions: int = 15
    user_pattern_active_within_days: int = 14
    # Below this many total transactions (live + statement-derived), skip
    # sklearn entirely and ship a quantile-only artifact — see
    # ml/training/train_user_pattern.py.
    user_pattern_min_transactions_for_model: int = 30

    # Statement upload (app/services/statement_parser_service.py).
    statement_upload_max_bytes: int = 5 * 1024 * 1024
    statement_upload_max_pages: int = 12

    # Symmetric key for app/core/contact_encryption.py (Fernet). Guards the
    # one place raw, reversible contact info (email/phone) is allowed to
    # live — see docs/PROFILE_CONTACT_INFO_DECISION.md. This dev default is
    # a real, valid Fernet key (so the app boots out of the box) but is
    # checked into source, so it is NOT secret — generate and set a real
    # one via .env for anything beyond local dev:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    contact_info_encryption_key: str = "_SiZeLTNC9qRCBhjjnil3lbCAYqQYDheLL-DYZ0fq1g="

    # Symmetric key for app/core/field_encryption.py (Fernet). Broader than
    # contact_info_encryption_key: covers general free-text application
    # columns (notification bodies, alert summaries, resolution notes,
    # transaction location) added under encryption after they already held
    # plaintext rows — see that module's docstring for the legacy-plaintext
    # fallback this implies. Same dev-default caveat as the key above:
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    app_data_encryption_key: str = "mz-QjS8Q2QWIl2y4cF7HWcRTWbeGbt4HWGgvgKjjyFg="

    # AES-256-GCM key (raw 32 bytes, base64) for /ws/voice-stream's audio
    # chunks — the phone encrypts each PCM chunk with this key before
    # sending (see VoiceClassifierClient.kt), the server decrypts it here
    # before it ever reaches AudioSpoofDetector. A static pre-shared key,
    # not a per-session negotiated one — a real production rollout should
    # move to an ephemeral per-call key exchange (e.g. bound to the
    # session's auth token) instead of a value checked into source; this is
    # the honest, stated scope for now, same caveat as the two Fernet keys
    # above. Generate a real one for anything beyond local dev:
    #   python -c "import os, base64; print(base64.b64encode(os.urandom(32)).decode())"
    voice_stream_audio_key_b64: str = "/AyplD9wkWaEe/2Mmr+SAQ3bbSV4FFyxFZoQc3G/q/w="

    # Authentication & JWT Configuration
    jwt_secret_key: str = "s40-dev-insecure-jwt-secret-key-change-in-production-1234567890"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 30
    max_failed_login_attempts: int = 5
    account_lockout_minutes: int = 15

    # OTP Delivery Configuration
    # Options: "mock" (default in-memory test/dev), "console" (stdout logger), "none"
    # Live integrations (e.g. "twilio", "sendgrid") can be plugged in when configured.
    otp_delivery_provider: str = "mock"
    enable_dev_otp_inspection: bool = True

    # Circuit breaker guarding calls to the OTP delivery provider (see
    # app/core/circuit_breaker.py). Protects the shared sync-route thread
    # pool from a hung/slow live SMS/email gateway once one is configured —
    # mock/console/none providers return instantly so these limits are
    # effectively inert until a live provider is plugged in.
    otp_delivery_breaker_failure_threshold: int = 3
    otp_delivery_breaker_window_size: int = 5
    otp_delivery_breaker_recovery_timeout_seconds: float = 30.0
    otp_delivery_breaker_call_timeout_seconds: float = 5.0
    otp_delivery_breaker_max_concurrent: int = 5
    otp_delivery_breaker_max_queue: int = 10

    # HTTPS & Proxy Configuration
    enforce_https: bool = False
    trusted_proxy_ips: list[str] = ["127.0.0.1", "::1"]

    # CORS Configuration
    cors_origins: list[str] = [
        "http://localhost:8081",
        "http://127.0.0.1:8081",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:19006",
        "http://127.0.0.1:19006",
    ]
    cors_origin_regex: str | None = r"https?://(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?"

    # Demo & Simulator Endpoint Controls
    enable_demo_endpoints: bool = True

    # Session Security & Expiration
    session_absolute_expiry_days: int = 30
    session_inactivity_expiry_hours: int = 72

    # Rate Limiting & Brute-Force Protection
    auth_max_failed_attempts: int = 5
    auth_attempt_window_seconds: int = 900  # 15 minutes
    auth_base_lockout_seconds: int = 900    # 15 minutes
    auth_progressive_lockout_multiplier: int = 2
    auth_max_lockout_seconds: int = 86400   # 24 hours max
    auth_abuse_history_reset_days: int = 7  # 7 days of good behavior resets progressive multiplier
    auth_ip_max_attempts: int = 30          # 30 failed attempts / 15 min per IP across accounts
    auth_signup_ip_max_per_hour: int = 10   # 10 signups / hour per IP
    auth_otp_verify_ip_max_per_hour: int = 25
    auth_otp_resend_ip_max_per_hour: int = 15
    auth_transfer_request_ip_max_per_hour: int = 10
    auth_password_reset_token_expiry_minutes: int = 15
    auth_password_reset_ip_max_per_hour: int = 10


INSECURE_DEV_SECRETS = {
    "s40-dev-only-pepper-change-me",
    "s40-dev-general-secret-key-change-me",
    "avaran-dedicated-txn-integrity-key-dev-only",
    "avaran-integrity-hmac-pepper-2026",
    "_SiZeLTNC9qRCBhjjnil3lbCAYqQYDheLL-DYZ0fq1g=",
    "mz-QjS8Q2QWIl2y4cF7HWcRTWbeGbt4HWGgvgKjjyFg=",
    "s40-dev-insecure-jwt-secret-key-change-in-production-1234567890",
}


def validate_production_configuration(cfg: Settings) -> None:
    """
    Centralized startup validation for production environments.
    Guarantees production does not start with default, empty, or insecure development secrets.
    """
    if cfg.environment.lower() == "production":
        # In cloud prototype/demo platforms (Railway, Render, Fly), allow boot if custom production secrets are not yet configured
        import os
        is_cloud_platform = bool(os.getenv("RAILWAY_SERVICE_ID") or os.getenv("RAILWAY_DEPLOYMENT_ID") or os.getenv("RENDER") or os.getenv("FLY_APP_NAME"))
        is_strict = os.getenv("STRICT_PRODUCTION_SECURITY", "").lower() in ("true", "1") or not is_cloud_platform
        if not is_strict and (not cfg.secret_key or cfg.secret_key in INSECURE_DEV_SECRETS):
            import logging
            logging.getLogger("config").warning("Running on cloud platform with fallback secrets. Set production secrets in platform dashboard for hardened mode.")
            return

        # 1. Secret Key
        if not cfg.secret_key or cfg.secret_key in INSECURE_DEV_SECRETS or len(cfg.secret_key) < 32:
            raise ValueError(
                "Production configuration error: SECRET_KEY is missing, using a development default, or too short. "
                "Production startup aborted for security."
            )

        # 2. Dedicated Transaction Integrity Key
        if (
            not cfg.transaction_integrity_key
            or cfg.transaction_integrity_key in INSECURE_DEV_SECRETS
            or len(cfg.transaction_integrity_key) < 32
        ):
            raise ValueError(
                "Production configuration error: TRANSACTION_INTEGRITY_KEY is missing, using a development default, or too short. "
                "Production startup aborted for security."
            )

        # 3. Pepper & Encryption Key
        if not cfg.hash_pepper or cfg.hash_pepper in INSECURE_DEV_SECRETS:
            raise ValueError(
                "Production configuration error: HASH_PEPPER must be set to a secure unique production value."
            )

        if not cfg.contact_info_encryption_key or cfg.contact_info_encryption_key in INSECURE_DEV_SECRETS:
            raise ValueError(
                "Production configuration error: CONTACT_INFO_ENCRYPTION_KEY must be a valid unique Fernet key in production."
            )

        if not cfg.app_data_encryption_key or cfg.app_data_encryption_key in INSECURE_DEV_SECRETS:
            raise ValueError(
                "Production configuration error: APP_DATA_ENCRYPTION_KEY must be a valid unique Fernet key in production."
            )

        # 4. OTP Provider Safety in Production
        if cfg.otp_delivery_provider in ("mock", "console", "none"):
            raise ValueError(
                "Production configuration error: Production requires a live verified OTP delivery provider. "
                "Mock and console delivery modes are forbidden in production."
            )

        if cfg.enable_dev_otp_inspection:
            raise ValueError(
                "Production configuration error: enable_dev_otp_inspection must be set to False in production."
            )

        # 5. Demo & Simulator Gating
        if cfg.enable_demo_endpoints:
            raise ValueError(
                "Production configuration error: enable_demo_endpoints must be set to False in production."
            )

        # 6. CORS Safety in Production
        if not cfg.cors_origins or "*" in cfg.cors_origins:
            raise ValueError(
                "Production configuration error: cors_origins must be explicitly configured and cannot contain wildcard '*' in production."
            )

        if cfg.cors_origin_regex and ("10." in cfg.cors_origin_regex or "192.168" in cfg.cors_origin_regex or "172." in cfg.cors_origin_regex):
            raise ValueError(
                "Production configuration error: cors_origin_regex cannot use development private LAN patterns in production."
            )


settings = Settings()
validate_production_configuration(settings)


