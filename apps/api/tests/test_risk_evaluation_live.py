from app.core.security import create_access_token
from app.models.enums import RiskLevel, TransactionStatus


def _setup_user_and_txn(client):
    user_res = client.post("/api/v1/users", json={"name": "Alok Mishra", "phone_number": "+91-98765-88888"})
    user_id = user_res.json()["id"]
    txn_res = client.post(
        "/api/v1/transactions",
        json={
            "user_id": user_id,
            "recipient_identifier": "merchant.flipkart@upi",
            "device_identifier": "device-pixel-8",
            "amount": "12500.00",
            "location": "Bhubaneswar",
        },
    )
    return user_id, txn_res.json()["id"]


def test_live_risk_evaluate_endpoint_scores_transaction(client):
    user_id, txn_id = _setup_user_and_txn(client)
    token = create_access_token({"sub": str(user_id)})
    headers = {"Authorization": f"Bearer {token}"}

    response = client.post("/api/v1/risk/evaluate", json={"transaction_id": txn_id}, headers=headers)
    assert response.status_code == 200
    body = response.json()

    assert "risk_score" in body
    assert 0 <= body["risk_score"] <= 100
    assert body["risk_level"] in ["LOW", "MEDIUM", "HIGH"]
    assert body["decision"] in ["ALLOW", "WARN_CHOICE", "CONFIRM_OR_CANCEL"]
    assert isinstance(body["plain_language_reasons"], list)
    assert isinstance(body["risk_contributions_pct"], dict)
    assert "latency_ms" in body
    assert body["latency_ms"] < 50.0

    # Verify score is now readable via GET /api/v1/risk/{id}
    get_res = client.get(f"/api/v1/risk/{txn_id}")
    assert get_res.status_code == 200
    saved = get_res.json()
    assert saved["final_score"] == float(body["risk_score"])
    assert saved["risk_level"] == body["risk_level"]
