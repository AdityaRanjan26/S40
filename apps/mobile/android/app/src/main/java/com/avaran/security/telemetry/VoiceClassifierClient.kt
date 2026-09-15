package com.avaran.security.telemetry

import android.util.Log
import com.avaran.security.config.DevConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Phase 2 (voice_stream.py's `audio_spoof`): synthetic/cloned-voice signal
 * from [voice.anti_spoofing.detector.AudioSpoofDetector]. Null until at
 * least one audio chunk has been sent — see [VoiceClassifierClient.sendAudioChunk].
 */
data class AudioSpoofSignal(
    val spoofProbability: Double,
    val isSyntheticVoice: Boolean,
    val acousticEvidence: List<String>,
)

/**
 * Phase 4 (voice_stream.py's `multimodal_fusion`): the authoritative,
 * fused risk score across text + audio-spoof signals from
 * [ml.inference.multimodal_fusion.MultimodalBayesianFusionEngine]. This is
 * always the more complete score once available — prefer it over
 * [VoiceClassification.accumulatedRisk] (text-only) wherever both exist.
 */
data class MultimodalFusion(
    val fusedRiskScore: Int,
    val riskLevel: String,
    val decision: String,
    val primaryRiskFactors: List<String>,
)

/**
 * Phase 4 (voice_stream.py's `copilot`): the Adaptive Copilot's suggested
 * "Columbo trap" counter-question strategy from
 * [engine.copilot.adaptive_copilot.AdaptiveCopilot].
 */
data class CopilotGuidance(
    val challengeType: String,
    val escalationAction: String,
    val recommendedChallenge: String?,
    val explanation: String?,
)

/** One classification response from apps/api's real voice-scam classifier. */
data class VoiceClassification(
    val accumulatedRisk: Double,
    val coercionLevel: String, // "SAFE" | "ELEVATED" | "CRITICAL"
    val detectedIntents: List<String>,
    val matchedPhrases: List<String>,
    val scamCategories: List<String>,
    val columboTrapPrompt: String?,
    val languageDetected: String,
    val isScamAlert: Boolean,
    val message: String,
    val audioSpoof: AudioSpoofSignal?,
    val multimodalFusion: MultimodalFusion?,
    val copilot: CopilotGuidance?,
) {
    /**
     * The score to actually show the user: the fused multimodal score once
     * available (text + audio-spoof combined), falling back to the raw
     * text-only accumulator only when no audio has been fused in yet (e.g.
     * before the first audio chunk lands, or on a device where mic capture
     * during a call fails — see LiveCallAudioService's audio-capture path).
     */
    val displayRiskPercent: Int
        get() = multimodalFusion?.fusedRiskScore
            ?: (accumulatedRisk * 100).toInt().coerceIn(0, 100)
}

/**
 * Streams transcript text chunks to apps/api's `/ws/voice-stream` — the
 * same real, ML-backed classifier already verified working from the mobile
 * app's own Voice Shield demo (docs/PROFILE_CONTACT_INFO_DECISION.md's
 * sibling verification pass). One socket per call; the backend keeps a
 * stateful leaky-bucket risk accumulator per connection, so risk genuinely
 * builds up across utterances the way it would for a real scam call.
 */
class VoiceClassifierClient(
    private val onClassification: (VoiceClassification) -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // WS stays open indefinitely
        .build()

    private var socket: WebSocket? = null

    fun connect() {
        if (socket != null) return
        val request = Request.Builder().url(DevConfig.voiceStreamWsUrl()).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "voice classifier connected")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                parseAndDeliver(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "voice classifier connection failed: ${t.message}")
                socket = null
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "voice classifier closed: $reason")
                socket = null
            }
        })
    }

    fun sendTranscript(text: String) {
        if (text.isBlank()) return
        val payload = JSONObject().apply { put("text_chunk", text) }
        val sent = socket?.send(payload.toString()) ?: false
        if (!sent) {
            Log.w(TAG, "classifier socket not open; dropping transcript chunk")
        }
    }

    /**
     * Sends one raw 16kHz mono 16-bit PCM chunk for
     * [voice.anti_spoofing.detector.AudioSpoofDetector] to score
     * (voice_stream.py's `audio_chunk_b64` field). At least ~0.25s of audio
     * per chunk (the detector's own minimum — shorter chunks are silently
     * ignored server-side); ~1s is the target, batched by the caller.
     *
     * The chunk is AES-256-GCM encrypted before it ever leaves the device
     * (see [AudioStreamCrypto]) — raw microphone audio must never cross
     * the wire in the clear. `audio_chunk_b64` carries the encrypted
     * payload; the server decrypts it (app/core/audio_stream_crypto.py)
     * before it reaches the spoof detector.
     */
    fun sendAudioChunk(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        val encryptedB64 = try {
            AudioStreamCrypto.encrypt(pcm)
        } catch (e: Exception) {
            Log.w(TAG, "failed to encrypt audio chunk; dropping: ${e.message}")
            return
        }
        val payload = JSONObject().apply {
            put("audio_chunk_b64", encryptedB64)
        }
        val sent = socket?.send(payload.toString()) ?: false
        if (!sent) {
            Log.w(TAG, "classifier socket not open; dropping audio chunk")
        }
    }

    fun close() {
        socket?.close(1000, "call ended")
        socket = null
    }

    private fun parseAndDeliver(raw: String) {
        // Parsing and delivering the result are kept in separate try/catch
        // blocks deliberately: an exception thrown by onClassification's
        // callback (e.g. FraudOverlayManager failing to inflate its view)
        // must never be logged as a JSON parse failure — that mislabeling
        // cost real debugging time once already.
        val classification = try {
            val json = JSONObject(raw)
            val intents = jsonStringList(json, "detected_intents")
            val phrases = jsonStringList(json, "matched_phrases")
            val categories = jsonStringList(json, "scam_categories")

            val audioSpoof = json.optJSONObject("audio_spoof")?.let { spoof ->
                AudioSpoofSignal(
                    spoofProbability = spoof.optDouble("audio_spoof_prob", 0.0),
                    isSyntheticVoice = spoof.optBoolean("is_synthetic_voice", false),
                    acousticEvidence = jsonStringList(spoof, "acoustic_evidence"),
                )
            }

            val multimodalFusion = json.optJSONObject("multimodal_fusion")?.let { fusion ->
                MultimodalFusion(
                    fusedRiskScore = fusion.optInt("fused_risk_score", 0),
                    riskLevel = fusion.optString("risk_level", "LOW"),
                    decision = fusion.optString("decision", ""),
                    primaryRiskFactors = jsonStringList(fusion, "primary_risk_factors"),
                )
            }

            val copilot = json.optJSONObject("copilot")?.let { cp ->
                CopilotGuidance(
                    challengeType = cp.optString("challenge_type", "NONE"),
                    escalationAction = cp.optString("escalation_action", "NONE"),
                    recommendedChallenge = jsonNullableString(cp, "recommended_challenge"),
                    explanation = jsonNullableString(cp, "explanation"),
                )
            }

            VoiceClassification(
                accumulatedRisk = json.optDouble("accumulated_risk", 0.0),
                coercionLevel = json.optString("coercion_level", "SAFE"),
                detectedIntents = intents,
                matchedPhrases = phrases,
                scamCategories = categories,
                columboTrapPrompt = jsonNullableString(json, "columbo_trap_prompt"),
                languageDetected = json.optString("language_detected", "en"),
                isScamAlert = json.optBoolean("is_scam_alert", false),
                message = json.optString("message", ""),
                audioSpoof = audioSpoof,
                multimodalFusion = multimodalFusion,
                copilot = copilot,
            )
        } catch (e: Exception) {
            Log.w(TAG, "failed to parse classifier response: ${e.message}")
            return
        }

        try {
            onClassification(classification)
        } catch (e: Exception) {
            Log.e(TAG, "onClassification callback threw", e)
        }
    }

    private fun jsonStringList(json: JSONObject, key: String): List<String> {
        val out = mutableListOf<String>()
        json.optJSONArray(key)?.let { arr ->
            for (i in 0 until arr.length()) out.add(arr.getString(i))
        }
        return out
    }

    private fun jsonNullableString(json: JSONObject, key: String): String? =
        if (json.has(key) && !json.isNull(key)) json.getString(key) else null

    companion object {
        private const val TAG = "VoiceClassifierClient"
    }
}
