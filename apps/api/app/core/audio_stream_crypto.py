"""
AES-256-GCM decryption for /ws/voice-stream's audio chunks (spec: encrypt
on-device, decrypt server-side, so raw microphone audio is never sent in
the clear over the wire — see VoiceClassifierClient.kt's sendAudioChunk
for the encrypting side).

Wire format (matches the Kotlin side byte-for-byte): the client sends
base64(nonce[12 bytes] || ciphertext || tag[16 bytes]) as `audio_chunk_b64`
— AES-GCM's standard 12-byte nonce prepended to its own authenticated
ciphertext, one field, no separate nonce parameter needed.

Key: settings.voice_stream_audio_key_b64, a static pre-shared 32-byte key
(see config.py's own caveat on this — not a per-session negotiated key,
a stated scope limitation for this project's current stage).
"""

import base64
import logging

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import settings

logger = logging.getLogger("audio_stream_crypto")

_NONCE_LEN = 12


class AudioDecryptionError(Exception):
    """Raised when an audio chunk fails to decrypt — wrong/rotated key,
    truncated payload, or a tampered/corrupted chunk. Callers must treat
    this the same as "no audio chunk was sent" (see voice_stream.py),
    never crash the whole call-detection session over one bad chunk."""


def decrypt_audio_chunk(payload_b64: str) -> bytes:
    """Decrypts one base64(nonce || ciphertext || tag) chunk. Raises
    AudioDecryptionError on any failure — malformed base64, too-short
    payload, or a failed GCM authentication tag check (wrong key or
    tampered data)."""
    try:
        raw = base64.b64decode(payload_b64)
    except Exception as exc:
        raise AudioDecryptionError(f"invalid base64: {exc}") from exc

    if len(raw) <= _NONCE_LEN:
        raise AudioDecryptionError("payload shorter than the nonce alone — not a real encrypted chunk")

    nonce, ciphertext = raw[:_NONCE_LEN], raw[_NONCE_LEN:]

    try:
        key = base64.b64decode(settings.voice_stream_audio_key_b64)
        aesgcm = AESGCM(key)
        return aesgcm.decrypt(nonce, ciphertext, associated_data=None)
    except InvalidTag as exc:
        raise AudioDecryptionError("GCM authentication failed — wrong key or corrupted/tampered chunk") from exc
    except Exception as exc:
        raise AudioDecryptionError(f"decryption failed: {exc}") from exc
