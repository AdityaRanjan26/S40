"""apps/api/app/api/routers/financial_profile.py — statement upload,
model-sync ETag/304 contract, and artifact download, exercised through the
real HTTP app (TestClient) against the synthetic bank-statement PDF
fixtures in tests/fixtures/ (built with reportlab, not hand-crafted —
apps/api/app/services/statement_parser_service.py's own docstring explains
why these are "verified against a synthetic statement, not a real bank's
actual export layout")."""

from pathlib import Path

from app.core.security import create_access_token

FIXTURES = Path(__file__).parent / "fixtures"


_user_counter = 0


def _create_user(client) -> int:
    global _user_counter
    _user_counter += 1
    res = client.post(
        "/api/v1/users",
        json={
            "name": "Statement Test User",
            "phone_number": f"+91-90000-{(id(client) + _user_counter) % 100000:05d}",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _create_user_and_headers(client) -> tuple[int, dict]:
    user_id = _create_user(client)
    token = create_access_token({"sub": str(user_id)})
    return user_id, {"Authorization": f"Bearer {token}"}


def test_upload_statement_parses_and_stores_rows(client):
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["parsed_rows"] == 5  # 4 DEBIT + 1 CREDIT row in the fixture
    assert body["inserted_rows"] == 5
    assert body["duplicate_rows"] == 0
    # First-ever upload for this user -> bootstrap training runs inline.
    assert body["trained"] is True
    assert body["p50_amount"] is not None


def test_upload_statement_with_hdfc_style_headers_parses_via_dynamic_column_matching(client):
    """Different bank, completely different column names/order/count than
    the first fixture (Value Dt / Narration / Withdrawal Amt. / Deposit
    Amt.) — proves columns are resolved by header text, not position."""
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement_hdfc_style.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["parsed_rows"] == 3
    assert body["inserted_rows"] == 3


def test_upload_statement_re_upload_is_deduplicated(client):
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        content = f.read()

    first = client.post(
        f"/api/v1/users/{user_id}/statement/upload",
        files={"file": ("statement.pdf", content, "application/pdf")},
        headers=headers,
    )
    assert first.json()["inserted_rows"] == 5

    second = client.post(
        f"/api/v1/users/{user_id}/statement/upload",
        files={"file": ("statement.pdf", content, "application/pdf")},
        headers=headers,
    )
    assert second.status_code == 200
    body = second.json()
    assert body["inserted_rows"] == 0
    assert body["duplicate_rows"] == 5


def test_upload_password_protected_statement_with_correct_password(client):
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement_protected.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            data={"password": "secret123"},
            headers=headers,
        )
    assert res.status_code == 200, res.text
    assert res.json()["inserted_rows"] == 1


def test_upload_password_protected_statement_with_wrong_password_returns_422(client):
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement_protected.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            data={"password": "wrongpassword"},
            headers=headers,
        )
    assert res.status_code == 422


def test_upload_statement_rejects_oversized_file(client, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "statement_upload_max_bytes", 100)
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )
    assert res.status_code == 413


def test_model_sync_returns_no_model_before_any_training(client):
    user_id, headers = _create_user_and_headers(client)
    res = client.get(f"/api/v1/users/{user_id}/model-sync", headers=headers)
    assert res.status_code == 200
    body = res.json()
    assert body["has_model"] is False


def test_model_sync_then_304_on_matching_etag(client):
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        upload = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )
    assert upload.json()["trained"] is True

    first = client.get(f"/api/v1/users/{user_id}/model-sync", headers=headers)
    assert first.status_code == 200
    body = first.json()
    assert body["has_model"] is True
    assert body["kind"] == "quantile-json"
    checksum = body["sha256_checksum"]
    assert body["p50"] is not None

    second = client.get(
        f"/api/v1/users/{user_id}/model-sync",
        headers={**headers, "If-None-Match": f'"{checksum}"'},
    )
    assert second.status_code == 304
    assert second.content == b""


def test_model_artifact_download_matches_sync_checksum(client):
    import hashlib

    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )

    sync = client.get(f"/api/v1/users/{user_id}/model-sync", headers=headers).json()
    download = client.get(sync["download_url"], headers=headers)
    assert download.status_code == 200
    assert hashlib.sha256(download.content).hexdigest() == sync["sha256_checksum"]


def test_model_artifact_download_404_for_unknown_version(client):
    user_id, headers = _create_user_and_headers(client)
    res = client.get(f"/api/v1/users/{user_id}/model-artifact/v-does-not-exist", headers=headers)
    assert res.status_code == 404


def test_upload_freeform_text_statement_uses_ocr_fallback_path(client):
    """No table structure at all (plain drawString text lines, not a
    reportlab Table) — pdfplumber finds zero tables (verified directly:
    `pdfplumber.open(...).pages[0].extract_tables() == []`), so this
    exercises statement_parser_service.py's fallback: text extraction via
    statement_extraction_service.py's shared primitive, then the
    line-based date+keyword+amount parser. This is the non-OCR half of
    that fallback (digital text, not a scanned image) — Tesseract isn't
    installed on this dev machine (confirmed via
    GET /api/v1/statements/ocr/status returning available=False), so the
    image-OCR half of the same fallback function isn't exercised by this
    test; it shares the same extract_pdf_page_texts() call path, just the
    OCR branch inside it rather than the digital-text branch this test
    does cover."""
    user_id, headers = _create_user_and_headers(client)
    with open(FIXTURES / "sample_statement_freeform_text.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers,
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["parse_method"] == "ocr_fallback"
    assert body["parsed_rows"] == 5
    assert body["inserted_rows"] == 5


def test_ocr_status_endpoint_reports_tesseract_availability_honestly(client):
    """Not asserting True or False — this dev machine may or may not have
    Tesseract installed; the point is the endpoint responds and reports
    whatever the real state is, matching statement_extraction_service.py's
    own graceful-degradation design (never crashes when OCR is
    unavailable, never claims it's available when it isn't)."""
    user_id = _create_user(client)
    token = create_access_token({"sub": str(user_id)})
    res = client.get("/api/v1/statements/ocr/status", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert "available" in body
    assert isinstance(body["available"], bool)


# --- Auth / ownership enforcement -----------------------------------------


def test_upload_statement_without_token_returns_401(client):
    user_id = _create_user(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
        )
    assert res.status_code == 401


def test_upload_statement_for_different_user_returns_403(client):
    _user_a_id, headers_a = _create_user_and_headers(client)
    user_b_id = _create_user(client)
    with open(FIXTURES / "sample_statement.pdf", "rb") as f:
        res = client.post(
            f"/api/v1/users/{user_b_id}/statement/upload",
            files={"file": ("statement.pdf", f, "application/pdf")},
            headers=headers_a,
        )
    assert res.status_code == 403


def test_model_sync_without_token_returns_401(client):
    user_id = _create_user(client)
    res = client.get(f"/api/v1/users/{user_id}/model-sync")
    assert res.status_code == 401


def test_model_sync_for_different_user_returns_403(client):
    _user_a_id, headers_a = _create_user_and_headers(client)
    user_b_id = _create_user(client)
    res = client.get(f"/api/v1/users/{user_b_id}/model-sync", headers=headers_a)
    assert res.status_code == 403


def test_model_artifact_download_without_token_returns_401(client):
    user_id = _create_user(client)
    res = client.get(f"/api/v1/users/{user_id}/model-artifact/v-does-not-exist")
    assert res.status_code == 401


def test_model_artifact_download_for_different_user_returns_403(client):
    _user_a_id, headers_a = _create_user_and_headers(client)
    user_b_id = _create_user(client)
    res = client.get(
        f"/api/v1/users/{user_b_id}/model-artifact/v-does-not-exist",
        headers=headers_a,
    )
    assert res.status_code == 403


def test_model_sync_authenticates_with_real_session_token_from_verify_otp(client):
    """Regression: get_current_user was JWT-only, but every real mobile
    session uses the OPAQUE session token /auth/verify-otp (and /login)
    actually issue via SessionService.create_session, not a JWT — the
    other tests in this file all mint JWTs directly via create_access_token,
    which masked this. This goes through the real signup -> verify-otp
    flow a live user takes and uses exactly the token that flow returns,
    catching the auth-scheme mismatch found during manual end-to-end
    testing (every real logged-in user got a 401 from model-sync)."""
    from app.services.otp_service import otp_delivery_provider

    phone = f"+91-98000-{_user_counter:05d}"
    signup = client.post(
        "/api/v1/auth/signup",
        json={"fullName": "Real Session Flow User", "mobileNumber": phone, "password": "StrongPassword123!"},
    )
    assert signup.status_code in (200, 201), signup.text
    user_id = signup.json()["userId"]

    otp = otp_delivery_provider.get_last_otp_for_target(phone)
    assert otp is not None
    verify = client.post("/api/v1/auth/verify-otp", json={"userId": user_id, "otp": otp})
    assert verify.status_code == 200, verify.text
    session_token = verify.json()["token"]
    assert not session_token.startswith("eyJ"), "expected an opaque session token, not a JWT"

    res = client.get(f"/api/v1/users/{user_id}/model-sync", headers={"Authorization": f"Bearer {session_token}"})
    assert res.status_code == 200, res.text
    assert res.json()["has_model"] is False
