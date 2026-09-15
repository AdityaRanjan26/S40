"""
app/core/audio_stream_crypto.py — AES-256-GCM decryption for
/ws/voice-stream's audio chunks. The encrypting side lives in Kotlin
(VoiceClassifierClient.kt / AudioStreamCrypto.kt) and can't be exercised
from here; these tests cover the decrypting half's correctness and its
failure modes using a same-scheme Python-side encrypt helper.
"""

import base64
import os

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.audio_stream_crypto import AudioDecryptionError, decrypt_audio_chunk
from app.core.config import settings


def _encrypt(plaintext: bytes, key: bytes | None = None) -> str:
    key = key if key is not None else base64.b64decode(settings.voice_stream_audio_key_b64)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    return base64.b64encode(nonce + ciphertext).decode()


def test_decrypts_a_real_chunk_correctly():
    pcm = bytes(range(256)) * 40  # arbitrary "PCM-shaped" bytes
    payload = _encrypt(pcm)
    assert decrypt_audio_chunk(payload) == pcm


def test_empty_plaintext_round_trips():
    payload = _encrypt(b"")
    assert decrypt_audio_chunk(payload) == b""


def test_wrong_key_raises_decryption_error():
    payload = _encrypt(b"some pcm bytes", key=os.urandom(32))
    with pytest.raises(AudioDecryptionError):
        decrypt_audio_chunk(payload)


def test_tampered_ciphertext_raises_decryption_error():
    payload = _encrypt(b"some pcm bytes")
    raw = bytearray(base64.b64decode(payload))
    raw[-1] ^= 0xFF  # flip a bit inside the GCM tag
    tampered = base64.b64encode(bytes(raw)).decode()
    with pytest.raises(AudioDecryptionError):
        decrypt_audio_chunk(tampered)


def test_malformed_base64_raises_decryption_error():
    with pytest.raises(AudioDecryptionError):
        decrypt_audio_chunk("not valid base64 !!!")


def test_payload_shorter_than_nonce_raises_decryption_error():
    too_short = base64.b64encode(os.urandom(4)).decode()
    with pytest.raises(AudioDecryptionError):
        decrypt_audio_chunk(too_short)
