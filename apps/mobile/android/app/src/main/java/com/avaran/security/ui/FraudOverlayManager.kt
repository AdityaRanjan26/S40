package com.avaran.security.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.CountDownTimer
import android.provider.Settings
import android.telecom.TelecomManager
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import com.avaran.security.R
import com.avaran.security.telemetry.VoiceClassification

/**
 * Draws a [WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY] warning over whatever
 * app is in the foreground when the fused risk score for the current payment screen is
 * >= [HIGH_RISK_THRESHOLD]. Requires SYSTEM_ALERT_WINDOW ("draw over other apps"), which
 * on Android 6+ needs the user to grant it via [Settings.canDrawOverlays] — this is a
 * manual settings-screen grant, not a runtime permission dialog.
 *
 * The dismiss button is disabled for a mandatory 5-second countdown so a panicked user
 * mid-scam-call can't reflexively tap through the warning before reading it.
 */
object FraudOverlayManager {

    const val HIGH_RISK_THRESHOLD = 75
    private const val COUNTDOWN_MS = 5_000L
    private const val COUNTDOWN_TICK_MS = 1_000L
    private const val TAG = "FraudOverlayManager"

    @Volatile
    private var currentOverlayView: View? = null

    /**
     * @param classification the full enriched response (fused risk score,
     * audio-spoof signal, Adaptive Copilot guidance) when available from a
     * real [com.avaran.security.telemetry.VoiceClassifierClient] callback —
     * pass null only for callers that don't have one (e.g. a bare score from
     * elsewhere), which falls back to the plain risk-score-only display.
     */
    fun show(context: Context, riskScore: Int, sessionId: String, classification: VoiceClassification? = null) {
        val appContext = context.applicationContext

        if (!canDrawOverlays(appContext)) {
            Log.w(TAG, "SYSTEM_ALERT_WINDOW not granted; cannot show overlay for session=$sessionId")
            return
        }
        if (currentOverlayView != null) {
            Log.d(TAG, "overlay already showing; ignoring duplicate trigger")
            return
        }

        val windowManager = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        // A bare application Context has no theme attributes resolved (no
        // colorControlNormal/etc.), which makes LayoutInflater fail on
        // themed widgets like Button when this is triggered from a
        // background Service (no Activity theme in the chain) rather than
        // from UI code — wrap it in the app's own theme before inflating.
        val themedContext = ContextThemeWrapper(appContext, R.style.AppTheme)
        val view = try {
            LayoutInflater.from(themedContext).inflate(R.layout.overlay_fraud_warning, null)
        } catch (e: Exception) {
            Log.e(TAG, "failed to inflate overlay layout", e)
            return
        }

        view.findViewById<TextView>(R.id.overlay_risk_score).text = "Risk score: $riskScore / 100"
        populateSignalDetails(view, classification)

        val dismissButton = view.findViewById<Button>(R.id.overlay_dismiss_button)
        val endCallButton = view.findViewById<Button>(R.id.overlay_end_call_button)

        val params = buildLayoutParams()

        dismissButton.isEnabled = false
        startCountdown(dismissButton, appContext)

        dismissButton.setOnClickListener {
            dismiss(windowManager)
        }
        endCallButton.setOnClickListener {
            handleEndCallAndAbort(appContext, sessionId)
            dismiss(windowManager)
        }

        try {
            windowManager.addView(view, params)
            currentOverlayView = view
        } catch (e: Exception) {
            Log.e(TAG, "failed to add overlay view: ${e.message}")
        }
    }

    /**
     * Surfaces the audio-spoof signal and Adaptive Copilot's suggested
     * counter-question — both computed server-side (see voice_stream.py)
     * but previously discarded entirely by the Kotlin client, so a real
     * cloned-voice call and a text-only scam call looked identical to the
     * user despite the backend telling them apart.
     */
    private fun populateSignalDetails(view: View, classification: VoiceClassification?) {
        val detailsView = view.findViewById<TextView>(R.id.overlay_signal_details)
        val promptView = view.findViewById<TextView>(R.id.overlay_copilot_prompt)

        val spoof = classification?.audioSpoof
        if (spoof?.isSyntheticVoice == true) {
            detailsView.text = "⚠ Synthetic / cloned voice detected — this may not be who it sounds like."
            detailsView.visibility = View.VISIBLE
        } else {
            detailsView.visibility = View.GONE
        }

        val challenge = classification?.copilot?.recommendedChallenge
        if (!challenge.isNullOrBlank()) {
            promptView.text = "Try asking: “$challenge”"
            promptView.visibility = View.VISIBLE
        } else {
            promptView.visibility = View.GONE
        }
    }

    private fun startCountdown(dismissButton: Button, context: Context) {
        object : CountDownTimer(COUNTDOWN_MS, COUNTDOWN_TICK_MS) {
            override fun onTick(millisUntilFinished: Long) {
                val secondsLeft = ((millisUntilFinished + 999) / 1000).toInt()
                dismissButton.text = context.getString(R.string.fraud_overlay_countdown_format, secondsLeft)
            }

            override fun onFinish() {
                dismissButton.isEnabled = true
                dismissButton.text = context.getString(R.string.fraud_overlay_dismiss)
            }
        }.start()
    }

    private fun dismiss(windowManager: WindowManager) {
        currentOverlayView?.let {
            try {
                windowManager.removeView(it)
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "overlay view already removed: ${e.message}")
            }
        }
        currentOverlayView = null
    }

    /**
     * Best-effort abort. IMPORTANT: on Android 9+ (API 28+), [TelecomManager.endCall]
     * is restricted to the default Dialer app or an app holding the signature-level
     * MODIFY_PHONE_STATE permission — a normal third-party app generally CANNOT end an
     * active call even with ANSWER_PHONE_CALLS granted. This method tries the API
     * honestly, and falls back to a visible instruction rather than silently pretending
     * the call was ended, per CLAUDE.md's "never fabricate a capability" rule.
     */
    @SuppressLint("MissingPermission")
    private fun handleEndCallAndAbort(context: Context, sessionId: String) {
        Log.i(TAG, "user requested End Call & Abort for session=$sessionId")

        var ended = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
                ended = telecomManager?.endCall() ?: false
            } catch (e: SecurityException) {
                Log.w(TAG, "endCall() denied by platform: ${e.message}")
            }
        }

        if (!ended) {
            Toast.makeText(
                context,
                "AVARAN can't end the call automatically on this device — please hang up now and do not enter your PIN.",
                Toast.LENGTH_LONG,
            ).show()
        }
        // The transaction-abort signal (stop LiveCallAudioService, notify the RN layer
        // to cancel any pending UPI intent) is deliberately out of scope for this PoC —
        // it needs a defined app-to-native bridge contract that doesn't exist yet.
    }

    private fun canDrawOverlays(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

    private fun buildLayoutParams(): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
        }
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        )
    }
}
