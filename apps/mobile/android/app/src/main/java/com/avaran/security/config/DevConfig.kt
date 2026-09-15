package com.avaran.security.config

/**
 * Demo/dev-only network config. The FastAPI backend (apps/api) has no discovery
 * mechanism yet, so the LAN IP of the machine running `uvicorn` is hardcoded here
 * for the hackathon demo. Replace with a build-config/remote-config value before
 * this ever ships outside a controlled demo.
 */
object DevConfig {
    /**
     * IP of the machine running the S40 backend(s). "127.0.0.1" (i.e. the
     * phone's own localhost) only works when the phone is USB-connected
     * with the matching ports forwarded via `adb reverse`:
     *   adb reverse tcp:8001 tcp:8001
     *   adb reverse tcp:8090 tcp:8090
     * This avoids guessing a WiFi LAN IP (which changes per network/hotspot
     * and silently breaks connectivity — see docs/ if you hit "unable to
     * connect"). For a real WiFi-only test (no USB), replace this with
     * your dev machine's actual LAN IP instead and drop the adb reverse
     * calls, e.g. "192.168.1.42".
     */
    const val DEV_MACHINE_IP: String = "127.0.0.1"

    /**
     * apps/api — the FastAPI transactions/risk/users/guardian backend.
     * 8001, not 8000: matches apps/mobile/.env's EXPO_PUBLIC_API_URL. Port
     * 8000 was found this session to be occupied by a separate, stale dev
     * server instance outside this app's control — 8001 is the one that's
     * actually kept current. If you're running your own single backend on
     * 8000, change both this and apps/mobile/.env together.
     */
    const val API_PORT: Int = 8001

    /**
     * main.py at the repo root — a SEPARATE standalone server (Bhashini
     * streaming ASR + fraud detector) that only exists to serve
     * /ws/call-stream/{session_id}. It is NOT part of apps/api and must be
     * run on its own port: `python -m uvicorn main:app --host 0.0.0.0
     * --port 8090` from the repo root. Real transcription requires
     * BHASHINI_API_KEY/USER_ID/PIPELINE_ID env vars; without them it still
     * accepts and streams audio (useful for verifying the pipeline itself)
     * but produces no real transcripts or fraud alerts.
     */
    const val CALL_STREAM_PORT: Int = 8090

    const val HTTP_BASE_URL: String = "http://$DEV_MACHINE_IP:$API_PORT"
    private const val API_WS_BASE_URL: String = "ws://$DEV_MACHINE_IP:$API_PORT"
    private const val CALL_STREAM_WS_BASE_URL: String = "ws://$DEV_MACHINE_IP:$CALL_STREAM_PORT"

    /** Matches apps/api's documented risk-evaluation surface (docs/ARCHITECTURE.md §3). */
    const val TRANSACTIONS_EVALUATE_PATH: String = "/api/v1/transactions/evaluate"

    /**
     * Matches main.py's standalone WebSocket entry point. Requires a real
     * BHASHINI_API_KEY to produce transcripts/alerts — without one it's
     * only useful for verifying that audio genuinely streams end-to-end.
     * See voiceStreamWsUrl() below for the working alternative.
     */
    fun callStreamWsUrl(sessionId: String): String = "$CALL_STREAM_WS_BASE_URL/ws/call-stream/$sessionId"

    /**
     * apps/api's real, already-verified-working scam classifier
     * (voice/classifier.py via app/api/routers/voice_stream.py). Takes
     * plain text chunks (`{"text_chunk": "..."}`), not audio — this is
     * what OnDeviceSpeechRecognizer's transcripts get sent to, since it
     * needs no external STT provider and is already proven live (matches
     * apps/mobile's voice-service.ts, which talks to this same endpoint).
     */
    fun voiceStreamWsUrl(): String = "$API_WS_BASE_URL/ws/voice-stream"

    /**
     * AES-256-GCM key (raw 32 bytes, base64) for encrypting audio chunks
     * sent to /ws/voice-stream — MUST match apps/api's
     * settings.voice_stream_audio_key_b64 exactly (see that setting's own
     * docstring for the same "static pre-shared key, not per-session"
     * caveat: a real production rollout would negotiate this per-session
     * rather than check it into source on both ends).
     */
    const val VOICE_STREAM_AUDIO_KEY_B64: String = "/AyplD9wkWaEe/2Mmr+SAQ3bbSV4FFyxFZoQc3G/q/w="
}
