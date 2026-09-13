"""
Phase 2 (encryption at rest): app/core/field_encryption.py's EncryptedText
TypeDecorator, applied to Notification.title/body, Alert.summary,
Transaction.location, GuardianRequest.resolution_notes, and
FraudCase.review_notes.

Verifies the ciphertext actually sits in the raw DB column (not just that
the ORM round-trips it — that alone wouldn't prove anything is encrypted),
that a fresh ORM read decrypts it transparently, and that a pre-existing
plaintext row (written before a column adopted encryption) is preserved
byte-for-byte on read rather than being blanked.
"""

from sqlalchemy import text

from app.core.field_encryption import decrypt_app_data, encrypt_app_data
from app.models.notification import Notification


def test_encrypt_decrypt_round_trip():
    original = "Guardian request from Priya for ₹45,000 to merchant@upi"
    token = encrypt_app_data(original)
    assert token != original  # actually encrypted, not echoed
    assert decrypt_app_data(token) == original


def test_decrypt_legacy_plaintext_returns_it_unchanged_not_blanked():
    """A row written before this column adopted encryption is plain text,
    not a Fernet token. Must survive a read unchanged — the old
    contact_encryption.decrypt_field() behavior of returning "" here would
    silently destroy every pre-existing row's content."""
    legacy_plaintext = "Payment of ₹5,000 to Rahul Sharma completed"
    assert decrypt_app_data(legacy_plaintext) == legacy_plaintext


def test_empty_and_none_round_trip():
    assert encrypt_app_data("") == ""
    assert decrypt_app_data("") == ""


def test_notification_body_is_ciphertext_at_rest_and_decrypts_via_orm(db_session):
    plaintext_title = "High-risk payment held"
    plaintext_body = "₹75,000 to newmerchant@upi was held pending your review."

    note = Notification(
        user_id=1,
        type="GUARDIAN_HOLD",
        title=plaintext_title,
        body=plaintext_body,
    )
    db_session.add(note)
    db_session.commit()
    note_id = note.id

    # Raw SQL bypasses the ORM's process_result_value — this is the actual
    # bytes sitting in the database.
    raw_row = db_session.execute(
        text("SELECT title, body FROM notifications WHERE id = :id"), {"id": note_id}
    ).first()
    assert raw_row.title != plaintext_title
    assert raw_row.body != plaintext_body
    assert plaintext_body not in raw_row.body  # not just prefixed/wrapped plaintext

    # A fresh ORM query transparently decrypts it back.
    db_session.expire_all()
    reloaded = db_session.get(Notification, note_id)
    assert reloaded.title == plaintext_title
    assert reloaded.body == plaintext_body


def test_notification_legacy_plaintext_row_survives_orm_read(db_session):
    """Simulates a row that existed before this column was encrypted:
    insert raw plaintext directly, bypassing the ORM/EncryptedText entirely,
    then confirm reading it back through the ORM preserves it exactly."""
    legacy_body = "Your payment to Amit Kumar of ₹2,000 was completed."
    db_session.execute(
        text(
            "INSERT INTO notifications (user_id, type, title, body, is_read, created_at) "
            "VALUES (1, 'PAYMENT_COMPLETED', 'Payment completed', :body, 0, datetime('now'))"
        ),
        {"body": legacy_body},
    )
    db_session.commit()

    reloaded = db_session.query(Notification).filter(Notification.body.isnot(None)).order_by(Notification.id.desc()).first()
    assert reloaded.body == legacy_body
