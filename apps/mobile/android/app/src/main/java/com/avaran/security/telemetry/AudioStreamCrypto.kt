package com.avaran.security.telemetry

import android.util.Base64
import com.avaran.security.config.DevConfig
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM encryption for audio chunks sent to apps/api's
 * /ws/voice-stream — matches app/core/audio_stream_crypto.py's decrypting
 * side byte-for-byte. Raw microphone PCM must never cross the wire in the
 * clear; this is the encrypting half of that guarantee.
 *
 * Wire format: base64(nonce[12 bytes] || ciphertext || tag[16 bytes]) —
 * standard AES-GCM framing, one field, no separate nonce parameter needed
 * on the receiving end.
 */
object AudioStreamCrypto {
    private const val ALGORITHM = "AES/GCM/NoPadding"
    private const val NONCE_LEN_BYTES = 12
    private const val TAG_LEN_BITS = 128

    private val secureRandom = SecureRandom()

    private val key: SecretKeySpec by lazy {
        val keyBytes = Base64.decode(DevConfig.VOICE_STREAM_AUDIO_KEY_B64, Base64.NO_WRAP)
        SecretKeySpec(keyBytes, "AES")
    }

    /** Encrypts one PCM chunk, returning the base64 string ready to send
     * as `audio_chunk_b64`. Never throws on a well-formed key/input — any
     * failure here would silently drop real audio-spoof detection for
     * this chunk, so callers should treat a thrown exception as "skip
     * sending this chunk" rather than crash the detection session. */
    fun encrypt(plainBytes: ByteArray): String {
        val nonce = ByteArray(NONCE_LEN_BYTES)
        secureRandom.nextBytes(nonce)

        val cipher = Cipher.getInstance(ALGORITHM)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_LEN_BITS, nonce))
        val ciphertext = cipher.doFinal(plainBytes)

        val combined = ByteArray(nonce.size + ciphertext.size)
        System.arraycopy(nonce, 0, combined, 0, nonce.size)
        System.arraycopy(ciphertext, 0, combined, nonce.size, ciphertext.size)

        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }
}
