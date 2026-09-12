"""
Unified FastAPI Server for AVARAN Shield.

Combines:
1. Core S40 APIs (Auth, Users, Transactions, Risk, Guardian, Alerts, Payments, Simulator, Demo, Notifications)
2. Bhashini Streaming ASR Call-Stream WebSocket (/ws/call-stream/{session_id})
3. Real-Time Voice Classifier WebSocket (/ws/voice-stream)
4. Automatic cold-start database migration & demo seeding
"""

import asyncio
import contextlib
import json
import logging
import sys
from pathlib import Path
import os
from pathlib import Path
from typing import Optional

# If deployed on Railway without injected production secrets, default to development
# to prevent startup abort while preserving full functionality for demo/testing.
if (os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_SERVICE_NAME")) and not os.getenv("SECRET_KEY"):
    os.environ["ENVIRONMENT"] = "development"

# Ensure apps/api and root are in python path
REPO_ROOT = Path(__file__).resolve().parent
API_DIR = REPO_ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.routers import (
    alerts,
    auth,
    demo,
    financial_profile,
    guardian,
    institution,
    notifications,
    payments,
    risk,
    simulator,
    statements,
    transactions,
    users,
    voice_stream,
)
from app.core.config import settings
from app.core.database import SessionLocal, get_db
from app.services import guardian_service
from session_manager import session_manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("main")


async def _guardian_expiry_worker() -> None:
    """AVARAN PAY spec §6: proactively expire Guardian requests past their
    120s deadline, independent of whether the frontend is polling."""
    while True:
        try:
            await asyncio.sleep(settings.guardian_expiry_sweep_interval_seconds)
            db = SessionLocal()
            try:
                guardian_service.sweep_expired_requests(db)
            finally:
                db.close()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Guardian expiry sweep failed; will retry on next interval.")


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    # Auto-seed database if empty or missing (e.g. fresh Railway or Docker deploy)
    try:
        from scripts.seed_database import seed
        with SessionLocal() as db:
            try:
                user_count = db.execute(text("SELECT count(*) FROM users")).scalar()
            except Exception:
                user_count = 0
        if not user_count:
            logger.info("Initializing and seeding database on startup...")
            seed()
    except Exception as e:
        logger.warning(f"Database auto-seed check skipped or encountered: {e}")

    task = asyncio.create_task(_guardian_expiry_worker()) if settings.enable_guardian_expiry_worker else None
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = FastAPI(
    title="AVARAN Full Security & Payment Shield Engine",
    description="Unified API Engine powering live risk evaluation, authorization, transactions, guardian protection, and streaming speech ASR.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all authoritative routers from apps/api
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(transactions.router)
app.include_router(risk.router)
app.include_router(alerts.router)
app.include_router(guardian.router)
app.include_router(institution.router)
app.include_router(simulator.router)
app.include_router(voice_stream.router)
app.include_router(payments.router)
app.include_router(demo.router)
app.include_router(notifications.router)
app.include_router(financial_profile.router)
app.include_router(statements.router)


@app.get("/", include_in_schema=False)
def root():
    """Redirect root to Swagger documentation UI."""
    return RedirectResponse(url="/docs")


@app.get("/health")
@app.get("/api/v1/health")
def health() -> dict:
    """Liveness check: returns system health and active sessions."""
    active_count = len(session_manager.active_sessions)
    return {
        "status": "ok",
        "app": settings.app_name,
        "environment": settings.environment,
        "active_sessions": active_count,
        "pipeline": "Bhashini Streaming ASR + Stateful Leaky Bucket Fraud Detector",
    }


@app.get("/health/db")
@app.get("/api/v1/health/db")
def health_db(db: Session = Depends(get_db)) -> dict:
    """Readiness check: verifies round-trip query against Avaran.db."""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "database": "connected"}


@app.websocket("/ws/call-stream/{session_id}")
async def call_stream_endpoint(
    websocket: WebSocket,
    session_id: str,
    mock: Optional[bool] = Query(default=False),
):
    """
    WebSocket endpoint for live 16kHz PCM call audio streaming.
    Receives binary audio frames from active call clients, forwards them to Bhashini STT,
    runs the Stateful Fraud Detector, and pushes real-time FRAUD_ALERT payloads if triggered.
    """
    await websocket.accept()
    logger.info(f"WebSocket client connected for session_id: {session_id} (mock={mock})")

    session = await session_manager.create_session(
        session_id=session_id, websocket=websocket, mock_mode=mock
    )

    try:
        while True:
            message = await websocket.receive()

            if "bytes" in message and message["bytes"]:
                pcm_data: bytes = message["bytes"]
                await session.process_audio_chunk(pcm_data)

            elif "text" in message and message["text"]:
                text_msg: str = message["text"]
                try:
                    payload = json.loads(text_msg)
                    event_type = payload.get("event", "")

                    if event_type == "inject_mock":
                        mock_text = payload.get("text", "")
                        is_final = payload.get("is_final", True)
                        await session.inject_transcript_mock(mock_text, is_final=is_final)

                    elif event_type == "ping":
                        await websocket.send_json({"event": "pong", "session_id": session_id})

                    elif event_type == "stop":
                        logger.info(f"Received stop command for session: {session_id}")
                        break
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON text received on session {session_id}: {text_msg[:100]}")

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session_id: {session_id}")
    except Exception as e:
        logger.error(f"Unexpected error in WebSocket endpoint for session {session_id}: {e}")
    finally:
        await session_manager.remove_session(session_id)
        logger.info(f"Cleaned up session_id: {session_id}")
