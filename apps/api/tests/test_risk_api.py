from app.core.security import create_access_token
from app.models.enums import RiskDecision, RiskLevel
from app.models.risk_factor import RiskFactor
from app.models.risk_score import RiskScore


def _create_transaction(client):
    user_id = client.post(
        "/api/v1/users", json={"name": "Suresh Iyer", "phone_number": "+91-90000-77777"}
    ).json()["id"]
    txn = client.post(
        "/api/v1/transactions",
        json={
            "user_id": user_id,
            "recipient_identifier": "suresh.recipient@upi",
            "device_identifier": "device-risk-test",
            "amount": "8000.00",
        },
    ).json()
    token = create_access_token({"sub": str(user_id)})
    return txn, {"Authorization": f"Bearer {token}"}


def test_risk_score_for_nonexistent_transaction_returns_404(client):
    response = client.get("/api/v1/risk/999999")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_risk_score_before_evaluation_returns_404(client):
    transaction, _headers = _create_transaction(client)
    response = client.get(f"/api/v1/risk/{transaction['id']}")
    assert response.status_code == 404
    assert "no risk evaluation" in response.json()["detail"].lower()


def test_risk_score_after_manual_insertion_is_readable(client, db_session):
    transaction, _headers = _create_transaction(client)

    risk_score = RiskScore(
        transaction_id=transaction["id"],
        fraud_probability=0.6,
        final_score=58.0,
        risk_level=RiskLevel.MEDIUM,
        decision=RiskDecision.WARN,
    )
    db_session.add(risk_score)
    db_session.commit()
    db_session.add(
        RiskFactor(
            risk_score_id=risk_score.id,
            factor_type="behaviour",
            factor_name="amount_deviation",
            contribution=35.0,
            explanation="Test factor.",
        )
    )
    db_session.commit()

    response = client.get(f"/api/v1/risk/{transaction['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["risk_level"] == "MEDIUM"
    assert body["decision"] == "WARN"
    assert len(body["risk_factors"]) == 1
    assert body["risk_factors"][0]["factor_name"] == "amount_deviation"


def test_evaluate_endpoint_scores_live_transaction(client):
    transaction, headers = _create_transaction(client)
    response = client.post(
        "/api/v1/risk/evaluate", json={"transaction_id": transaction["id"]}, headers=headers
    )
    assert response.status_code == 200
    body = response.json()
    assert "risk_score" in body
    assert body["risk_level"] in ["LOW", "MEDIUM", "HIGH"]
    assert body["decision"] in ["ALLOW", "WARN_CHOICE", "CONFIRM_OR_CANCEL"]

