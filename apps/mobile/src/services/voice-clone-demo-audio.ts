/**
 * Loads the bundled "AI Voice Clone" demo recording
 * (assets/audio/ai_voice_clone_demo.wav — the same file as
 * demo_recordings/3_ai_voice_clone_deepfake.wav) and runs the on-device
 * audio anti-spoofing detector (services/audio-anti-spoofing.ts) against
 * its REAL samples, so the "AI Voice Cloning" simulation scenario in
 * voice-service.ts shows a genuinely computed result instead of a
 * hardcoded stub. Computed once and cached — the file never changes at
 * runtime, and it's advisory-only demo content either way.
 *
 * Fails safe: any error (asset missing, file read failure, non-native
 * environment) resolves to null rather than throwing or fabricating a
 * result, same doctrine as recipient-risk-service.ts.
 *
 * CONFIRMED WEB LIMITATION: on Expo web specifically, this always
 * resolves to null — verified directly (ERR_UNAVAILABLE: "expo-file-
 * system.readAsStringAsync is not available on this platform"). The
 * legacy expo-file-system API has no web implementation for reading an
 * arbitrary local asset URI. The UI correctly shows "unavailable" rather
 * than crashing or fabricating a score; the underlying detector's
 * correctness was verified separately, offline, against the Python
 * original (audio-anti-spoofing-parity.regression.ts) — this only means
 * the demo can't be visually observed producing a real result in a web
 * preview. Requires a native (iOS/Android) build to see the computed
 * result live, same caveat already documented in
 * recipient-risk-service.ts.
 */

import { decodeWav } from "../utils/wav-decoder";
import { detectAudioSpoof, AudioSpoofResult } from "./audio-anti-spoofing";

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int8Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;

  const clean = base64.replace(/[\r\n]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)];
    const c1 = lookup[clean.charCodeAt(i + 1)];
    const c2 = clean.charCodeAt(i + 2) === 61 ? -1 : lookup[clean.charCodeAt(i + 2)];
    const c3 = clean.charCodeAt(i + 3) === 61 ? -1 : lookup[clean.charCodeAt(i + 3)];

    if (byteIndex < byteLength) bytes[byteIndex++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0 && byteIndex < byteLength) bytes[byteIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 >= 0 && byteIndex < byteLength) bytes[byteIndex++] = ((c2 & 0x03) << 6) | c3;
  }

  return bytes.buffer;
}

let cachedResultPromise: Promise<AudioSpoofResult | null> | null = null;

/** Returns the on-device spoof-detection result for the bundled AI voice-clone demo clip. */
export function getDemoVoiceCloneResult(): Promise<AudioSpoofResult | null> {
  if (!cachedResultPromise) {
    cachedResultPromise = (async () => {
      try {
        // Loaded lazily rather than as a static import: these are native
        // modules that crash on load outside the RN runtime (e.g. Node-based
        // regression scripts) — see recipient-risk-service.ts for the same
        // pattern and why.
        const { Asset } = require("expo-asset");
        const FileSystem = require("expo-file-system/legacy");

        const asset = Asset.fromModule(require("../../assets/audio/ai_voice_clone_demo.wav"));
        await asset.downloadAsync();
        if (!asset.localUri) return null;

        const base64 = await FileSystem.readAsStringAsync(asset.localUri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const arrayBuffer = base64ToArrayBuffer(base64);
        const wav = decodeWav(arrayBuffer);
        return detectAudioSpoof(wav.samples);
      } catch {
        return null;
      }
    })();
  }
  return cachedResultPromise;
}
