"""
/ws/voice-stream — Real-time WebSocket for live speech transcription, audio
anti-spoofing (catches a synthetic/cloned voice of a known person), and
multimodal coercion defense.
"""

import base64
import json
import logging
from typing import Dict, Any, Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from voice.classifier import VoiceClassifier
from voice.leaky_bucket import LeakyBucketAccumulator
from voice.anti_spoofing.detector import AudioSpoofDetector
from ml.inference.multimodal_fusion import MultimodalBayesianFusionEngine
from engine.copilot.adaptive_copilot import AdaptiveCopilot

logger = logging.getLogger("voice_stream")
router = APIRouter(tags=["voice"])

# Session memory for active call streams
sessions: Dict[str, Dict[str, Any]] = {}


@router.websocket("/ws/voice-stream")
async def voice_stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = f"session_{id(websocket)}"

    classifier = VoiceClassifier()
    accumulator = LeakyBucketAccumulator(capacity=1.0, leak_rate=0.02)
    audio_detector = AudioSpoofDetector(sample_rate=16000)
    fusion_engine = MultimodalBayesianFusionEngine()
    copilot = AdaptiveCopilot()

    sessions[session_id] = {
        "classifier": classifier,
        "accumulator": accumulator,
        "audio_detector": audio_detector,
        "fusion_engine": fusion_engine,
        "copilot": copilot,
        "last_audio_res": {"audio_spoof_prob": 0.05, "is_synthetic_voice": False, "acoustic_evidence": []},
    }

    try:
        while True:
            data = await websocket.receive_text()
            packet: Dict[str, Any] = {}
            text = ""

            try:
                packet = json.loads(data)
                text = packet.get("text_chunk", "")
            except Exception:
                text = data

            sess = sessions[session_id]

            # 1. Process Audio PCM Chunk if provided (Base64 encoded 16kHz PCM)
            audio_chunk_b64 = packet.get("audio_chunk_b64") if isinstance(packet, dict) else None
            if audio_chunk_b64:
                try:
                    audio_bytes = base64.b64decode(audio_chunk_b64)
                    sess["last_audio_res"] = sess["audio_detector"].detect_spoof(audio_bytes)
                except Exception as e:
                    logger.warning(f"Failed to process audio chunk in session {session_id}: {e}")

            # 2. Process Text Chunk if provided (Phase 1 Multilingual Trie)
            if text and text.strip():
                result = sess["classifier"].classify_transcript(text)
                chunk_risk = float(result.get("overall_voice_risk", 0.0))
                matched = result.get("matched_phrases", [])
                intents = result.get("active_threat_dimensions", [])
                categories = result.get("scam_categories", [])
                lang = result.get("language_detected", "en")
                trap_prompt = result.get("columbo_trap_prompt")
                accumulated = sess["accumulator"].add_risk(chunk_risk)
            else:
                chunk_risk = 0.0
                matched = []
                intents = []
                categories = []
                lang = "en"
                trap_prompt = None
                accumulated = sess["accumulator"].current_level

            # Determine Coercion Level
            if accumulated >= 0.70:
                coercion_level = "CRITICAL"
                is_scam = True
                msg = "CRITICAL SOCIAL ENGINEERING SCAM DETECTED! High pressure coercive scam call in progress."
            elif accumulated >= 0.35:
                coercion_level = "ELEVATED"
                is_scam = False
                msg = "Elevated caution: scam keywords detected."
            else:
                coercion_level = "SAFE"
                is_scam = False
                msg = "Normal speech pattern."

            audio_res = sess["last_audio_res"]

            # 3. Multimodal Bayesian Fusion across all available signals
            sub_scores = {
                "transaction_fraud": 0.0,
                "behaviour_anomaly": 0.0,
                "device_risk": 0.0,
                "voice_risk": float(accumulated),
                "audio_spoof": float(audio_res.get("audio_spoof_prob", 0.0)),
            }
            fused_result = sess["fusion_engine"].fuse_multimodal(sub_scores)

            # 4. Adaptive Copilot Counter-Inquiry Strategy
            copilot_strategy = sess["copilot"].evaluate_response_strategy(
                risk_score=fused_result["risk_score"],
                scam_categories=categories,
                is_synthetic_voice=audio_res.get("is_synthetic_voice", False),
                language=lang,
            )

            # Build enriched unified response
            response = {
                "accumulated_risk": round(accumulated, 3),
                "coercion_level": coercion_level,
                "detected_intents": intents,
                "matched_phrases": matched,
                "scam_categories": categories,
                "columbo_trap_prompt": trap_prompt if coercion_level in ("ELEVATED", "CRITICAL") else None,
                "language_detected": lang,
                "is_scam_alert": is_scam or fused_result["risk_score"] >= 75,
                "message": msg,
                # Phase 2: Audio Anti-Spoofing (synthetic/cloned voice detection)
                "audio_spoof": {
                    "audio_spoof_prob": round(float(audio_res.get("audio_spoof_prob", 0.0)), 3),
                    "is_synthetic_voice": bool(audio_res.get("is_synthetic_voice", False)),
                    "acoustic_evidence": audio_res.get("acoustic_evidence", []),
                },
                # Phase 4: Multimodal Bayesian Saturation Fusion & Adaptive Copilot
                "multimodal_fusion": {
                    "fused_risk_score": fused_result["risk_score"],
                    "risk_level": fused_result["risk_level"],
                    "decision": fused_result["decision"],
                    "primary_risk_factors": fused_result.get("primary_risk_factors", []),
                },
                "copilot": {
                    "challenge_type": copilot_strategy.get("challenge_type", "NONE"),
                    "escalation_action": copilot_strategy.get("escalation_action", "NONE"),
                    "recommended_challenge": copilot_strategy.get("recommended_challenge"),
                    "explanation": copilot_strategy.get("explanation"),
                },
            }

            await websocket.send_text(json.dumps(response))

    except WebSocketDisconnect:
        sessions.pop(session_id, None)
    except Exception as e:
        logger.error(f"Error in voice stream WebSocket {session_id}: {e}")
        sessions.pop(session_id, None)
