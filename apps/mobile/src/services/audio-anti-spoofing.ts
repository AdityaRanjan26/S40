/**
 * On-device Audio Anti-Spoofing & Synthetic Speech Detector.
 *
 * A faithful TypeScript port of voice/anti_spoofing/acoustic_analyzer.py and
 * voice/anti_spoofing/detector.py (same frame size, hop size, thresholds,
 * and score-component weights). Runs entirely on-device against raw 16kHz
 * mono PCM samples — no audio bytes or telemetry need to leave the phone
 * for this signal. This is the ADVISORY-ONLY on-device counterpart to the
 * server-side detector still used by /ws/voice-stream for the authoritative
 * fusion decision (same "local advisory, never gates/blocks" doctrine as
 * recipient-risk-service.ts).
 *
 * Verified against the Python original: fed the same 16kHz mono PCM samples
 * from demo_recordings/3_ai_voice_clone_deepfake.wav through both
 * implementations and confirmed matching feature values and verdict (see
 * apps/mobile/src/utils/__tests__/audio-anti-spoofing-parity.regression.ts).
 */

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;
const HOP_SIZE = 256;
const SPOOF_THRESHOLD = 0.65;

export interface AcousticFeatures {
  jitter: number;
  f0Std: number;
  spectralFlux: number;
  hfRatio: number;
  centroidStd: number;
  pitchSmoothness: number;
}

export interface AudioSpoofResult {
  audioSpoofProb: number;
  isSyntheticVoice: boolean;
  acousticEvidence: string[];
  features: AcousticFeatures | Record<string, never>;
}

/** Precomputed Hanning window cache, keyed by length. */
const hanningCache = new Map<number, Float64Array>();
function hanningWindow(n: number): Float64Array {
  let w = hanningCache.get(n);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  hanningCache.set(n, w);
  return w;
}

/**
 * Iterative radix-2 Cooley-Tukey FFT. `re`/`im` are mutated in place.
 * `n` must be a power of two.
 */
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}

/** Real-input FFT magnitude spectrum, first N/2+1 bins (mirrors numpy's rfft). */
function rfftMagnitude(frame: Float64Array): Float64Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(frame);
  fftInPlace(re, im);
  const bins = n / 2 + 1;
  const mag = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

function mean(arr: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length > 0 ? s / arr.length : 0;
}

function stdDev(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / arr.length);
}

/**
 * Estimates the fundamental frequency (F0) per frame via autocorrelation.
 * Human speech range: 75 Hz to 450 Hz.
 */
function estimatePitchTrack(audio: Float64Array): Float64Array {
  const minLag = Math.floor(SAMPLE_RATE / 450);
  const maxLag = Math.floor(SAMPLE_RATE / 75);
  const numFrames = Math.max(1, Math.floor((audio.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const window = hanningWindow(FRAME_SIZE);
  const f0Track: number[] = [];

  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SIZE;
    if (start + FRAME_SIZE > audio.length) break;

    const raw = audio.subarray(start, start + FRAME_SIZE);
    const m = mean(raw);
    const frame = new Float64Array(FRAME_SIZE);
    for (let j = 0; j < FRAME_SIZE; j++) frame[j] = (raw[j] - m) * window[j];

    let energy = 0;
    for (let j = 0; j < FRAME_SIZE; j++) energy += frame[j] * frame[j];

    if (energy < 1e-4) {
      f0Track.push(0.0);
      continue;
    }

    // Zero-lag autocorrelation == energy (used as the peak-strength reference).
    const corr0 = energy;
    if (maxLag >= FRAME_SIZE) {
      f0Track.push(0.0);
      continue;
    }

    let bestLag = -1;
    let bestVal = -Infinity;
    for (let lag = minLag; lag < maxLag; lag++) {
      let sum = 0;
      for (let j = 0; j < FRAME_SIZE - lag; j++) sum += frame[j] * frame[j + lag];
      if (sum > bestVal) {
        bestVal = sum;
        bestLag = lag;
      }
    }

    if (bestLag === -1) {
      f0Track.push(0.0);
      continue;
    }

    if (bestVal > 0.3 * corr0) {
      f0Track.push(SAMPLE_RATE / bestLag);
    } else {
      f0Track.push(0.0);
    }
  }

  return Float64Array.from(f0Track);
}

/**
 * Pitch period jitter (relative fundamental frequency variation).
 * Human speech: ~0.01-0.04. Synthetic TTS/vocoders: typically < 0.005.
 */
function computeJitter(f0Track: Float64Array): number {
  const voiced: number[] = [];
  for (let i = 0; i < f0Track.length; i++) if (f0Track[i] > 0) voiced.push(f0Track[i]);
  if (voiced.length < 5) return 0.02; // Insufficient data, neutral default

  const diffs: number[] = [];
  for (let i = 1; i < voiced.length; i++) diffs.push(Math.abs(voiced[i] - voiced[i - 1]));
  const meanDiff = mean(diffs);
  const meanF0 = mean(voiced);
  if (meanF0 === 0) return 0.0;
  return meanDiff / meanF0;
}

interface SpectralFeatures {
  spectralFlux: number;
  hfRatio: number;
  centroidStd: number;
}

function computeSpectralFeatures(audio: Float64Array): SpectralFeatures {
  if (audio.length < FRAME_SIZE) {
    return { spectralFlux: 0.0, hfRatio: 0.0, centroidStd: 0.0 };
  }

  const numFrames = Math.floor((audio.length - FRAME_SIZE) / HOP_SIZE) + 1;
  const window = hanningWindow(FRAME_SIZE);
  const cutoffBin = Math.floor((4000.0 / (SAMPLE_RATE / 2.0)) * (FRAME_SIZE / 2));
  const bins = FRAME_SIZE / 2 + 1;
  const freqs = new Float64Array(bins);
  for (let k = 0; k < bins; k++) freqs[k] = (k * SAMPLE_RATE) / FRAME_SIZE;

  const centroids: number[] = [];
  const hfEnergies: number[] = [];
  const totalEnergies: number[] = [];
  const fluxValues: number[] = [];
  let prevMag: Float64Array | null = null;

  for (let i = 0; i < numFrames; i++) {
    const start = i * HOP_SIZE;
    if (start + FRAME_SIZE > audio.length) break;

    const frame = new Float64Array(FRAME_SIZE);
    for (let j = 0; j < FRAME_SIZE; j++) frame[j] = audio[start + j] * window[j];

    const mag = rfftMagnitude(frame);
    let totalEnergy = 0;
    for (let k = 0; k < mag.length; k++) totalEnergy += mag[k] * mag[k];

    if (totalEnergy > 1e-4) {
      let weighted = 0;
      let magSum = 0;
      for (let k = 0; k < mag.length; k++) {
        weighted += freqs[k] * mag[k];
        magSum += mag[k];
      }
      centroids.push(weighted / (magSum + 1e-8));

      let hfEnergy = 0;
      for (let k = cutoffBin; k < mag.length; k++) hfEnergy += mag[k] * mag[k];
      hfEnergies.push(hfEnergy);
      totalEnergies.push(totalEnergy);

      if (prevMag) {
        let normCurrNorm = 0;
        let normPrevNorm = 0;
        for (let k = 0; k < mag.length; k++) {
          normCurrNorm += mag[k] * mag[k];
          normPrevNorm += prevMag[k] * prevMag[k];
        }
        normCurrNorm = Math.sqrt(normCurrNorm) + 1e-8;
        normPrevNorm = Math.sqrt(normPrevNorm) + 1e-8;
        let flux = 0;
        for (let k = 0; k < mag.length; k++) {
          const d = mag[k] / normCurrNorm - prevMag[k] / normPrevNorm;
          flux += d * d;
        }
        fluxValues.push(flux);
      }
      prevMag = mag;
    }
  }

  const avgFlux = fluxValues.length > 0 ? mean(fluxValues) : 0.0;
  const sumHf = hfEnergies.reduce((a, b) => a + b, 0);
  const sumTotal = totalEnergies.reduce((a, b) => a + b, 0);
  const hfRatio = totalEnergies.length > 0 ? sumHf / (sumTotal + 1e-8) : 0.0;
  const centroidStd = centroids.length > 0 ? stdDev(centroids) : 0.0;

  return { spectralFlux: avgFlux, hfRatio, centroidStd };
}

/** Extracts all acoustic spoof indicators from a 16kHz mono PCM buffer. */
export function extractAcousticFeatures(audio: Float64Array): AcousticFeatures {
  if (audio.length === 0) {
    return { jitter: 0.02, f0Std: 15.0, spectralFlux: 0.0, hfRatio: 0.0, centroidStd: 0.0, pitchSmoothness: 0.0 };
  }

  const f0Track = estimatePitchTrack(audio);
  const jitter = computeJitter(f0Track);
  const spec = computeSpectralFeatures(audio);

  const voicedF0: number[] = [];
  for (let i = 0; i < f0Track.length; i++) if (f0Track[i] > 0) voicedF0.push(f0Track[i]);
  const f0Std = voicedF0.length > 5 ? stdDev(voicedF0) : 15.0;
  // Unnatural pitch smoothness flag: synthetic TTS pitch variance is tiny (<1.5 Hz std)
  const pitchSmoothness = f0Std < 2.0 ? 1.0 : Math.max(0.0, 1.0 - f0Std / 20.0);

  return {
    jitter,
    f0Std,
    spectralFlux: spec.spectralFlux,
    hfRatio: spec.hfRatio,
    centroidStd: spec.centroidStd,
    pitchSmoothness,
  };
}

/**
 * Analyzes a 16kHz mono PCM buffer and returns a spoof probability and
 * explainable acoustic evidence tags. Mirrors
 * voice/anti_spoofing/detector.py's AudioSpoofDetector.detect_spoof exactly
 * (same thresholds and score-component weights) so the on-device advisory
 * verdict matches what the server-side detector would say given the same
 * audio.
 */
export function detectAudioSpoof(audio: Float64Array): AudioSpoofResult {
  if (audio.length < SAMPLE_RATE * 0.25) {
    // Buffer too short (<250ms) — neutral baseline, matches the Python detector.
    return { audioSpoofProb: 0.05, isSyntheticVoice: false, acousticEvidence: [], features: {} };
  }

  const feats = extractAcousticFeatures(audio);
  const evidence: string[] = [];
  const scoreComponents: number[] = [];

  // 1. Pitch Jitter Analysis: synthetic TTS lacks natural involuntary micro-jitter
  if (feats.jitter < 0.006) {
    evidence.push("PITCH_MICRO_TREMOR_ABSENT");
    scoreComponents.push(0.35);
  } else if (feats.jitter < 0.012) {
    scoreComponents.push(0.15);
  } else {
    scoreComponents.push(0.0);
  }

  // 2. Fundamental Frequency Range / Monotone Flatness
  if (feats.f0Std < 2.5) {
    evidence.push("SYNTHETIC_PITCH_FLATNESS");
    scoreComponents.push(0.35);
  } else if (feats.f0Std < 6.0) {
    scoreComponents.push(0.15);
  } else {
    scoreComponents.push(0.0);
  }

  // 3. Vocoder High-Frequency Energy Artifacts (>4kHz band distortion)
  if (feats.hfRatio > 0.45) {
    evidence.push("VOCODER_HIGH_FREQUENCY_DISTORTION");
    scoreComponents.push(0.3);
  } else if (feats.hfRatio > 0.3) {
    scoreComponents.push(0.15);
  } else {
    scoreComponents.push(0.0);
  }

  // 4. Spectral Centroid Rigidity
  if (feats.centroidStd < 150.0 && audio.length > SAMPLE_RATE * 0.8) {
    evidence.push("VOCAL_TRACT_SPECTRAL_RIGIDITY");
    scoreComponents.push(0.2);
  } else {
    scoreComponents.push(0.0);
  }

  const rawProb = scoreComponents.reduce((a, b) => a + b, 0);
  const audioSpoofProb = Math.min(1.0, Math.max(0.02, rawProb));
  const isSyntheticVoice = audioSpoofProb >= SPOOF_THRESHOLD;

  return {
    audioSpoofProb: Math.round(audioSpoofProb * 10000) / 10000,
    isSyntheticVoice,
    acousticEvidence: evidence,
    features: feats,
  };
}
