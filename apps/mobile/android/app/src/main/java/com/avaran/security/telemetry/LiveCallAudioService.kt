package com.avaran.security.telemetry

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.IBinder
import android.content.pm.ServiceInfo
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.avaran.security.MainActivity
import com.avaran.security.R
import com.avaran.security.config.DevConfig
import com.avaran.security.net.RiskApiClient
import com.avaran.security.ui.FraudOverlayManager
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Foreground service that watches for an active call and runs live scam
 * detection against it.
 *
 * Real detection path: [OnDeviceSpeechRecognizer] (Android's built-in,
 * free, no-API-key speech recognizer) transcribes speech during the call;
 * each utterance is sent as text to apps/api's real classifier
 * (`/ws/voice-stream`, already verified live) via [VoiceClassifierClient].
 * Concurrently, [startAudioSpoofCapture] runs a second [AudioRecord]
 * session on the same mic and streams raw PCM chunks over the same socket,
 * so the backend's audio anti-spoofing/multimodal-fusion/Adaptive-Copilot
 * signals (previously only reachable from the in-app simulator, never a
 * real call) get real audio to score. A HIGH/CRITICAL/synthetic-voice
 * result triggers [FraudOverlayManager] with the full enriched response.
 * This exists because the original raw-audio design below needs Bhashini
 * credentials that aren't configured — this is the working substitute.
 *
 * Legacy path (kept, not currently invoked): [startRawAudioCapture] streams
 * raw 16kHz PCM to `main.py`'s `/ws/call-stream/{session_id}`
 * (Bhashini-backed). Captured with [AudioRecord] (not [MediaRecorder],
 * which only produces encoded container files) using
 * [MediaRecorder.AudioSource.MIC] — on a call this only reliably picks up
 * the far-end party with speakerphone on, a known Android platform
 * limitation for any non-system app. Re-enable by calling it from
 * [handleCallState] once BHASHINI_API_KEY/USER_ID/PIPELINE_ID are set.
 *
 * Per docs/SECURITY.md §3, neither path writes raw audio or transcripts to
 * disk — everything is forwarded live and discarded.
 */
class LiveCallAudioService : Service() {

    private val sessionId: String = UUID.randomUUID().toString()
    private val isRecording = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var webSocket: WebSocket? = null
    private var recordingThread: Thread? = null
    private lateinit var telephonyManager: TelephonyManager

    private var speechRecognizer: OnDeviceSpeechRecognizer? = null
    private var classifierClient: VoiceClassifierClient? = null
    private val isDetecting = AtomicBoolean(false)
    private var detectionStartedAtMillis: Long = 0

    private var spoofAudioRecord: AudioRecord? = null
    private var spoofRecordingThread: Thread? = null
    private val isCapturingSpoofAudio = AtomicBoolean(false)

    private val legacyPhoneStateListener = object : PhoneStateListener() {
        @Deprecated("Deprecated in Java")
        override fun onCallStateChanged(state: Int, phoneNumber: String?) = handleCallState(state)
    }

    private var modernTelephonyCallback: TelephonyCallback? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        telephonyManager = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        registerCallStateWatcher()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            },
        )

        // Manual trigger for the "Detect Current Call" / "Hang Up" buttons
        // (CallGuardModule.kt bridges these from the RN UI). Real speech
        // recognition only gets genuine mic access when the app is
        // foregrounded (confirmed via live device testing — a background-
        // only foreground Service does not reliably get it), so this is
        // deliberately a manual, user-initiated action rather than fully
        // automatic — the user has the app open when they tap it.
        when (intent?.action) {
            ACTION_START_DETECTION -> startSpeechDetection()
            ACTION_STOP_DETECTION -> stopSpeechDetection()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerCallStateWatcher() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "READ_PHONE_STATE not granted; cannot watch call state")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) = handleCallState(state)
            }
            modernTelephonyCallback = callback
            telephonyManager.registerTelephonyCallback(mainExecutor, callback)
        } else {
            @Suppress("DEPRECATION")
            telephonyManager.listen(legacyPhoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
        }
    }

    private fun unregisterCallStateWatcher() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            modernTelephonyCallback?.let { telephonyManager.unregisterTelephonyCallback(it) }
        } else {
            @Suppress("DEPRECATION")
            telephonyManager.listen(legacyPhoneStateListener, PhoneStateListener.LISTEN_NONE)
        }
    }

    private fun handleCallState(state: Int) {
        // Disabled: see AUTO_START_ON_REAL_CALL. Detection during a real
        // (non-test) call is manual-only for now, via ACTION_START_DETECTION/
        // ACTION_STOP_DETECTION from the "Detect Current Call" button.
        if (!AUTO_START_ON_REAL_CALL) return

        when (state) {
            TelephonyManager.CALL_STATE_OFFHOOK -> startSpeechDetection()
            TelephonyManager.CALL_STATE_IDLE, TelephonyManager.CALL_STATE_RINGING -> stopSpeechDetection()
        }
    }

    // -------------------------------------------------------------------
    // Real detection path: on-device STT -> apps/api's real classifier.
    // -------------------------------------------------------------------

    private fun startSpeechDetection() {
        if (!isDetecting.compareAndSet(false, true)) return

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "RECORD_AUDIO not granted; aborting speech detection")
            isDetecting.set(false)
            CallGuardModule.emit(
                CallGuardModule.EVENT_AUDIO_CAPTURE_UNAVAILABLE,
                sessionId = sessionId,
                errorCode = "PERMISSION_DENIED",
                error = "Microphone permission is required to detect a live call."
            )
            return
        }

        detectionStartedAtMillis = System.currentTimeMillis()
        var highestSuppressedRiskPercent = -1

        val classifier = VoiceClassifierClient { classification ->
            Log.i(
                TAG,
                "classification: risk=${classification.accumulatedRisk} level=${classification.coercionLevel} " +
                    "scamAlert=${classification.isScamAlert} fused=${classification.multimodalFusion?.fusedRiskScore} " +
                    "spoof=${classification.audioSpoof?.isSyntheticVoice}",
            )
            // A synthetic/cloned voice is treated as its own trigger,
            // independent of the text-only accumulator/coercion level —
            // audio_spoof only starts reporting once real audio chunks are
            // flowing (see startAudioSpoofCapture below), so this branch is
            // silent until then, same as before this fix on a device where
            // concurrent mic capture isn't available.
            val spoofTriggered = classification.audioSpoof?.isSyntheticVoice == true
            if (classification.isScamAlert || classification.coercionLevel == "CRITICAL" || spoofTriggered) {
                // Prefer the fused multimodal score (text + audio-spoof) once
                // available — it's the authoritative one voice_stream.py
                // computes; the raw text-only accumulator is only a fallback
                // for before the first audio chunk lands.
                val riskScorePercent = classification.displayRiskPercent
                val elapsedMs = System.currentTimeMillis() - detectionStartedAtMillis

                // A single ambiguous line ("calling from SBI") can spike the
                // model's score immediately — confirmed live during testing.
                // Requiring a minimum listening window before the visible
                // warning can fire (the classifier itself keeps scoring the
                // whole time, building real accumulated context) means the
                // alert reflects a sustained pattern across the call, not
                // one early, possibly-innocent line. A synthetic-voice
                // detection is a different kind of signal (an acoustic
                // measurement, not an ambiguous keyword spike) and skips
                // this gate — a cloned voice is worth flagging the moment
                // it's detected, not after 35s of listening to it.
                if (elapsedMs < MIN_LISTEN_BEFORE_ALERT_MS && !spoofTriggered) {
                    highestSuppressedRiskPercent = maxOf(highestSuppressedRiskPercent, riskScorePercent)
                    Log.i(
                        TAG,
                        "risk hit $riskScorePercent within the first ${elapsedMs}ms — still within the " +
                            "${MIN_LISTEN_BEFORE_ALERT_MS}ms minimum listening window, holding off the warning",
                    )
                    return@VoiceClassifierClient
                }

                // VoiceClassifierClient's callback runs on OkHttp's WebSocket
                // dispatcher thread, not the main thread — FraudOverlayManager
                // does real UI work (inflating a Button triggers a
                // StateListAnimator, which requires the main Looper), so it
                // must be dispatched here rather than called directly. Found
                // via a real crash: "Animators may only be run on Looper
                // threads", not assumed upfront.
                mainExecutor.execute {
                    FraudOverlayManager.show(applicationContext, riskScorePercent, sessionId, classification)
                }
            }
        }
        classifier.connect()
        classifierClient = classifier

        val recognizer = OnDeviceSpeechRecognizer(
            context = this,
            onTranscript = { text ->
                Log.i(TAG, "transcript: $text")
                classifierClient?.sendTranscript(text)
            },
        )
        if (!recognizer.isAvailable()) {
            Log.w(TAG, "on-device speech recognition unavailable on this device")
            CallGuardModule.emit(
                CallGuardModule.EVENT_AUDIO_CAPTURE_UNAVAILABLE,
                sessionId = sessionId,
                errorCode = "SPEECH_RECOGNITION_UNAVAILABLE",
                error = "On-device speech recognition is unavailable on this device."
            )
        }
        recognizer.start()
        speechRecognizer = recognizer
        startAudioSpoofCapture(classifier)
        CallGuardModule.emit(
            CallGuardModule.EVENT_AUDIO_CAPTURE_STARTED,
            sessionId = sessionId
        )
    }

    private fun stopSpeechDetection() {
        if (!isDetecting.compareAndSet(true, false)) return
        speechRecognizer?.stop()
        speechRecognizer = null
        stopAudioSpoofCapture()
        classifierClient?.close()
        classifierClient = null
        CallGuardModule.emit(
            CallGuardModule.EVENT_AUDIO_CAPTURE_STOPPED,
            sessionId = sessionId
        )
    }

    /**
     * Feeds raw mic audio to [voice.anti_spoofing.detector.AudioSpoofDetector]
     * (voice_stream.py's `audio_chunk_b64` path) alongside [OnDeviceSpeechRecognizer]'s
     * transcription, over the SAME socket/session as the text classifier —
     * this is what makes `audio_spoof`/synthetic-voice detection actually
     * fire during a real call; before this, no caller of `/ws/voice-stream`
     * ever sent an audio chunk for a live call, so the backend's spoof
     * detector sat permanently at its silence-baseline default.
     *
     * Runs a second, independent [AudioRecord] session on [MediaRecorder.AudioSource.MIC]
     * concurrently with [OnDeviceSpeechRecognizer]'s own internal mic session.
     * Android does not guarantee two concurrent captures on the same source
     * will both succeed on every device/OEM — this degrades gracefully
     * (logs and gives up, same as [startRawAudioCapture]'s own error
     * handling) rather than crashing if the second session can't acquire
     * the mic; text-only classification keeps working unaffected either way.
     */
    private fun startAudioSpoofCapture(classifier: VoiceClassifierClient) {
        if (!isCapturingSpoofAudio.compareAndSet(false, true)) return

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            isCapturingSpoofAudio.set(false)
            return
        }

        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
            Log.w(TAG, "audio-spoof capture: device does not support 16kHz mono PCM")
            isCapturingSpoofAudio.set(false)
            return
        }

        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                minBufferSize * 2,
            )
        } catch (e: SecurityException) {
            Log.w(TAG, "audio-spoof capture: AudioRecord init failed: ${e.message}")
            isCapturingSpoofAudio.set(false)
            return
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            // The expected outcome on a device/OEM where OnDeviceSpeechRecognizer
            // already holds the mic exclusively — not treated as an error,
            // just a graceful no-op. Text-only classification is unaffected.
            Log.i(TAG, "audio-spoof capture: mic unavailable for a second concurrent session; skipping")
            record.release()
            isCapturingSpoofAudio.set(false)
            return
        }

        spoofAudioRecord = record
        try {
            record.startRecording()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "audio-spoof capture: startRecording failed: ${e.message}")
            record.release()
            spoofAudioRecord = null
            isCapturingSpoofAudio.set(false)
            return
        }

        spoofRecordingThread = thread(name = "s40-audio-spoof-capture") {
            // ~1s of 16kHz mono 16-bit PCM per chunk — well above the
            // detector's ~0.25s minimum and its ~0.8s preferred window for
            // its spectral-consistency heuristic (see voice/anti_spoofing/
            // detector.py), without introducing multi-second alert latency.
            val chunkTargetBytes = SAMPLE_RATE_HZ * 2
            val readBuffer = ByteArray(minBufferSize)
            var accumulator = ByteArray(0)

            while (isCapturingSpoofAudio.get()) {
                val read = record.read(readBuffer, 0, readBuffer.size)
                if (read > 0) {
                    accumulator += if (read == readBuffer.size) readBuffer else readBuffer.copyOf(read)
                    if (accumulator.size >= chunkTargetBytes) {
                        classifier.sendAudioChunk(accumulator)
                        accumulator = ByteArray(0)
                    }
                }
            }
        }
    }

    private fun stopAudioSpoofCapture() {
        if (!isCapturingSpoofAudio.compareAndSet(true, false)) return

        spoofRecordingThread?.join(500)
        spoofRecordingThread = null

        spoofAudioRecord?.let {
            try {
                it.stop()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "audio-spoof capture: stop() on non-recording instance: ${e.message}")
            }
            it.release()
        }
        spoofAudioRecord = null
    }

    // -------------------------------------------------------------------
    // Legacy path: raw audio -> main.py -> Bhashini. Not currently invoked
    // (see class KDoc) — kept for when BHASHINI_API_KEY is configured.
    // -------------------------------------------------------------------

    private fun startRawAudioCapture() {
        if (!isRecording.compareAndSet(false, true)) return

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "RECORD_AUDIO not granted; aborting capture")
            isRecording.set(false)
            return
        }

        connectWebSocket()

        val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE_HZ, CHANNEL_CONFIG, AUDIO_FORMAT)
        if (minBufferSize == AudioRecord.ERROR || minBufferSize == AudioRecord.ERROR_BAD_VALUE) {
            Log.e(TAG, "device does not support 16kHz mono PCM capture")
            isRecording.set(false)
            CallGuardModule.emit(
                CallGuardModule.EVENT_AUDIO_CAPTURE_UNAVAILABLE,
                sessionId = sessionId,
                errorCode = "UNSUPPORTED_AUDIO_FORMAT",
                error = "Device does not support 16kHz mono PCM capture"
            )
            return
        }
        val bufferSize = minBufferSize * 2

        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE_HZ,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize,
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "AudioRecord init failed: ${e.message}")
            isRecording.set(false)
            CallGuardModule.emit(
                CallGuardModule.EVENT_AUDIO_CAPTURE_ERROR,
                sessionId = sessionId,
                errorCode = "AUDIO_RECORD_SECURITY_EXCEPTION",
                error = e.message ?: "AudioRecord init failed"
            )
            return
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            record.release()
            isRecording.set(false)
            CallGuardModule.emit(
                CallGuardModule.EVENT_AUDIO_CAPTURE_ERROR,
                sessionId = sessionId,
                errorCode = "AUDIO_RECORD_INIT_FAILED",
                error = "AudioRecord failed to initialize"
            )
            return
        }

        audioRecord = record
        record.startRecording()
        CallGuardModule.emit(
            CallGuardModule.EVENT_AUDIO_CAPTURE_STARTED,
            sessionId = sessionId
        )

        recordingThread = thread(name = "s40-live-call-audio") {
            val buffer = ByteArray(bufferSize)
            while (isRecording.get()) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    val bytesPerSample = 2 // 16-bit PCM mono = 2 bytes per sample
                    val durationMs = (read.toDouble() / (SAMPLE_RATE_HZ * bytesPerSample)) * 1000.0
                    CallGuardModule.emit(
                        eventName = CallGuardModule.EVENT_AUDIO_BUFFER_READY,
                        sessionId = sessionId,
                        bufferSize = read,
                        sampleRateHz = SAMPLE_RATE_HZ,
                        channelCount = 1,
                        audioFormat = "pcm_s16le",
                        durationMs = durationMs,
                        source = "microphone"
                    )
                    val frame = if (read == buffer.size) buffer else buffer.copyOf(read)
                    webSocket?.send(ByteString.of(*frame))
                }
            }
        }
    }

    private fun stopRawAudioCapture() {
        if (!isRecording.compareAndSet(true, false)) return

        recordingThread?.join(500)
        recordingThread = null

        audioRecord?.let {
            try {
                it.stop()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "AudioRecord.stop() on non-recording instance: ${e.message}")
            }
            it.release()
        }
        audioRecord = null

        webSocket?.close(NORMAL_CLOSURE_CODE, "call ended")
        webSocket = null
        CallGuardModule.emit(
            CallGuardModule.EVENT_AUDIO_CAPTURE_STOPPED,
            sessionId = sessionId
        )
    }

    private fun connectWebSocket() {
        val request = Request.Builder()
            .url(DevConfig.callStreamWsUrl(sessionId))
            .build()

        webSocket = RiskApiClient().okHttpClient().newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.i(TAG, "call-stream WebSocket open (session=$sessionId)")
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "call-stream WebSocket failed: ${t.message}")
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.i(TAG, "call-stream WebSocket closed: $reason")
                }
            },
        )
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.call_guard_notification_channel),
                NotificationManager.IMPORTANCE_LOW,
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.call_guard_notification_title))
        .setContentText(getString(R.string.call_guard_notification_text))
        .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this, 0, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()

    override fun onDestroy() {
        stopSpeechDetection()
        stopRawAudioCapture()
        unregisterCallStateWatcher()
        CallGuardModule.emit(
            CallGuardModule.EVENT_CALL_STOPPED,
            sessionId = sessionId
        )
        super.onDestroy()
    }

    companion object {
        private const val TAG = "LiveCallAudioService"
        private const val CHANNEL_ID = "s40_call_guard"
        private const val NOTIFICATION_ID = 4201
        private const val NORMAL_CLOSURE_CODE = 1000

        // Minimum time listening before a CRITICAL/scam-alert classification
        // is allowed to actually show the warning overlay — chosen to sit in
        // the 30-45s window requested after live testing showed a single
        // early line (e.g. "calling from SBI") could otherwise trigger it
        // immediately. The classifier keeps scoring every utterance from the
        // very first one regardless — this only gates the visible alert.
        private const val MIN_LISTEN_BEFORE_ALERT_MS = 35_000L

        // Real (non-test) calls don't get genuine background mic access on
        // this Android version regardless — confirmed empirically via live
        // testing (RMS/onBeginningOfSpeech only fired with the app
        // foregrounded). Until there's a real access path for that (e.g. a
        // CallScreeningService entitlement or similar), automatically
        // starting detection off TelephonyManager's call-state callback is
        // pointless and just means the service silently tries and requests
        // permissions/notification state around every real call the user
        // makes. Flip this to true once that real access path exists —
        // handleCallState() already has the correct start/stop logic, it's
        // just gated off.
        private const val AUTO_START_ON_REAL_CALL = false

        const val SAMPLE_RATE_HZ = 16_000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT

        const val ACTION_START_DETECTION = "com.avaran.security.action.START_DETECTION"
        const val ACTION_STOP_DETECTION = "com.avaran.security.action.STOP_DETECTION"
    }
}
