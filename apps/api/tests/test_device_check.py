"""
GET /api/v1/users/{user_id}/device-check — lets local-device-risk.ts know
whether ITS device is already registered, and the total device count, for
the on-device device_risk signal (ml/inference/predict.py's r_device
heuristic, ported to local-fusion-engine.ts) — without ever exposing a
raw or full device_hash to the client (hash_identifier's pepper is a
server secret).
"""

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import create_access_token, hash_identifier
from app.models.device import Device


def _auth_headers_for_new_user(client: TestClient) -> tuple[dict, int]:
    user_id = client.post(
        "/api/v1/users", json={"name": "Device Check Tester", "phone_number": "+91-90022-33441"}
    ).json()["id"]
    token = create_access_token({"sub": str(user_id)})
    return {"Authorization": f"Bearer {token}"}, user_id


def test_unknown_device_returns_false_and_zero_count(client: TestClient, db_session: Session):
    headers, user_id = _auth_headers_for_new_user(client)
    res = client.get(
        f"/api/v1/users/{user_id}/device-check",
        params={"device_identifier": "brand-new-device-never-seen"},
        headers=headers,
    )
    assert res.status_code == 200
    data = res.json()
    assert data["known_device"] is False
    assert data["device_count"] == 0


def test_known_device_returns_true_and_real_count(client: TestClient, db_session: Session):
    headers, user_id = _auth_headers_for_new_user(client)

    db_session.add(Device(user_id=user_id, device_hash=hash_identifier("my-actual-phone")))
    db_session.add(Device(user_id=user_id, device_hash=hash_identifier("my-old-tablet")))
    db_session.commit()

    res = client.get(
        f"/api/v1/users/{user_id}/device-check",
        params={"device_identifier": "my-actual-phone"},
        headers=headers,
    )
    assert res.status_code == 200
    data = res.json()
    assert data["known_device"] is True
    assert data["device_count"] == 2


def test_never_exposes_a_raw_device_hash(client: TestClient, db_session: Session):
    headers, user_id = _auth_headers_for_new_user(client)
    db_session.add(Device(user_id=user_id, device_hash=hash_identifier("my-actual-phone")))
    db_session.commit()

    res = client.get(
        f"/api/v1/users/{user_id}/device-check",
        params={"device_identifier": "my-actual-phone"},
        headers=headers,
    )
    body_text = res.text
    assert hash_identifier("my-actual-phone") not in body_text
    assert set(res.json().keys()) == {"known_device", "device_count"}


def test_rejects_checking_another_users_devices(client: TestClient, db_session: Session):
    headers, _ = _auth_headers_for_new_user(client)
    other_user_id = client.post(
        "/api/v1/users", json={"name": "Someone Else", "phone_number": "+91-90022-99887"}
    ).json()["id"]

    res = client.get(
        f"/api/v1/users/{other_user_id}/device-check",
        params={"device_identifier": "anything"},
        headers=headers,
    )
    assert res.status_code == 403
