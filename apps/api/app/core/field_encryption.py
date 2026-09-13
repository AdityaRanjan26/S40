"""
Transparent field-level encryption at rest for general application data —
Phase 2 of the on-device/E2E-encryption roadmap (see conversation history,
not a spec section): TLS already covers data in transit; this covers data
sitting in the database. Distinct from app/core/contact_encryption.py,
which guards a narrower, always-encrypted-since-inception surface (email/
phone); this module is for broader free-text columns (notification bodies,
alert summaries, resolution notes, transaction location) that pre-date
this decision and therefore already hold PLAINTEXT rows.

EncryptedText is a SQLAlchemy TypeDecorator: encryption/decryption happens
transparently at the ORM boundary (process_bind_param / process_result_value),
so callers — including Pydantic's `from_attributes` schema serialization,
which reads ORM attributes directly with no decrypt call site to hook —
never need to know a column is encrypted. Apply it by using EncryptedText
in place of Text/String in a model's mapped_column(...), nothing else
changes.

Legacy-safe by design: decrypting a value that isn't a valid Fernet token
(i.e. a plaintext row written before this column adopted encryption)
returns that value UNCHANGED rather than blanking it. This is a genuine
behavioral difference from contact_encryption.decrypt_field(), which
returns "" on failure — appropriate there because that field has never
held plaintext, but wrong here, where "failed to decrypt" mostly just
means "this row predates encryption" and returning "" would silently
destroy existing data on first read.
"""

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.types import Text, TypeDecorator

from app.core.config import settings

_fernet = Fernet(settings.app_data_encryption_key.encode())


def encrypt_app_data(value: str) -> str:
    """Encrypts a plaintext string for storage. Empty string in, empty string out."""
    if not value:
        return ""
    return _fernet.encrypt(value.encode()).decode()


def decrypt_app_data(token: str) -> str:
    """Decrypts a value previously produced by encrypt_app_data(). A value
    that isn't a valid Fernet token is treated as pre-encryption legacy
    plaintext and returned as-is, not blanked."""
    if not token:
        return ""
    try:
        return _fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        return token


class EncryptedText(TypeDecorator):
    """Text column that's encrypted at rest and transparently decrypted on read."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt_app_data(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return decrypt_app_data(value)
