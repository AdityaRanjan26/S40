/**
 * Parity check: the on-device TypeScript port of the audio anti-spoofing
 * detector (services/audio-anti-spoofing.ts) must produce the same
 * features and verdict as the Python original
 * (voice/anti_spoofing/detector.py) given the SAME audio samples.
 *
 * Ground truth was captured by running the Python detector directly
 * against demo_recordings/3_ai_voice_clone_deepfake.wav:
 *   python -c "from voice.anti_spoofing.detector import AudioSpoofDetector; ..."
 * -> {
 *   "audio_spoof_prob": 0.3, "is_synthetic_voice": false,
 *   "acoustic_evidence": ["VOCODER_HIGH_FREQUENCY_DISTORTION"],
 *   "features": {"jitter": 0.07653188705444336, "f0_std": 91.0320053100586,
 *     "spectral_flux": 0.04800326508350552, "hf_ratio": 0.6304870907507969,
 *     "centroid_std": 1147.919379542601, "pitch_smoothness": 0.0}
 * }
 * This is not a claim that the algorithm is a good spoof detector (that's
 * the Python original's own concern) — only that this TS port computes
 * the identical thing the Python original does on the same input.
 */

// @ts-ignore — Node-only modules; this script runs under tsx (Node), never bundled into the RN app.
import * as fs from "fs";
// @ts-ignore
import * as path from "path";
import { decodeWav } from "../wav-decoder";
import { detectAudioSpoof } from "../../services/audio-anti-spoofing";

// @ts-ignore — __dirname is provided by tsx's CJS-style transform at runtime.
const WAV_PATH = path.resolve(__dirname, "../../../../../demo_recordings/3_ai_voice_clone_deepfake.wav");

const PYTHON_GROUND_TRUTH = {
  audio_spoof_prob: 0.3,
  is_synthetic_voice: false,
  acoustic_evidence: ["VOCODER_HIGH_FREQUENCY_DISTORTION"],
  features: {
    jitter: 0.07653188705444336,
    f0_std: 91.0320053100586,
    spectral_flux: 0.04800326508350552,
    hf_ratio: 0.6304870907507969,
    centroid_std: 1147.919379542601,
    pitch_smoothness: 0.0,
  },
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log("[OK]  ", name);
  } else {
    fail++;
    console.log("[FAIL]", name, detail ?? "");
  }
}

function relClose(a: number, b: number, relTol = 0.02, absTol = 1e-6): boolean {
  return Math.abs(a - b) <= Math.max(absTol, relTol * Math.max(Math.abs(a), Math.abs(b)));
}

const fileBuffer = fs.readFileSync(WAV_PATH);
const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
const wav = decodeWav(arrayBuffer as ArrayBuffer);

check("decoded WAV sample rate is 16000", wav.sampleRate === 16000, `got ${wav.sampleRate}`);
check("decoded WAV has samples", wav.samples.length > 0);

const result = detectAudioSpoof(wav.samples);

check(
  "jitter matches Python within 2%",
  relClose(result.features.jitter as number, PYTHON_GROUND_TRUTH.features.jitter),
  `TS=${(result.features as any).jitter} PY=${PYTHON_GROUND_TRUTH.features.jitter}`
);
check(
  "f0_std matches Python within 2%",
  relClose((result.features as any).f0Std, PYTHON_GROUND_TRUTH.features.f0_std),
  `TS=${(result.features as any).f0Std} PY=${PYTHON_GROUND_TRUTH.features.f0_std}`
);
check(
  "spectral_flux matches Python within 2%",
  relClose((result.features as any).spectralFlux, PYTHON_GROUND_TRUTH.features.spectral_flux),
  `TS=${(result.features as any).spectralFlux} PY=${PYTHON_GROUND_TRUTH.features.spectral_flux}`
);
check(
  "hf_ratio matches Python within 2%",
  relClose((result.features as any).hfRatio, PYTHON_GROUND_TRUTH.features.hf_ratio),
  `TS=${(result.features as any).hfRatio} PY=${PYTHON_GROUND_TRUTH.features.hf_ratio}`
);
check(
  "centroid_std matches Python within 2%",
  relClose((result.features as any).centroidStd, PYTHON_GROUND_TRUTH.features.centroid_std),
  `TS=${(result.features as any).centroidStd} PY=${PYTHON_GROUND_TRUTH.features.centroid_std}`
);
check(
  "pitch_smoothness matches Python exactly",
  (result.features as any).pitchSmoothness === PYTHON_GROUND_TRUTH.features.pitch_smoothness
);

check(
  "audio_spoof_prob matches Python",
  relClose(result.audioSpoofProb, PYTHON_GROUND_TRUTH.audio_spoof_prob, 0.01),
  `TS=${result.audioSpoofProb} PY=${PYTHON_GROUND_TRUTH.audio_spoof_prob}`
);
check("is_synthetic_voice verdict matches Python", result.isSyntheticVoice === PYTHON_GROUND_TRUTH.is_synthetic_voice);
check(
  "acoustic_evidence tags match Python",
  JSON.stringify(result.acousticEvidence) === JSON.stringify(PYTHON_GROUND_TRUTH.acoustic_evidence),
  `TS=${JSON.stringify(result.acousticEvidence)} PY=${JSON.stringify(PYTHON_GROUND_TRUTH.acoustic_evidence)}`
);

// Sanity: too-short buffer returns the same neutral baseline as the Python detector.
const shortResult = detectAudioSpoof(new Float64Array(100));
check("short buffer returns neutral baseline prob 0.05", shortResult.audioSpoofProb === 0.05);
check("short buffer is never flagged synthetic", shortResult.isSyntheticVoice === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
