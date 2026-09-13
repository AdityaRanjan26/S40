/**
 * Minimal PCM WAV decoder (16-bit signed, mono or interpreted as mono via
 * the first channel) — just enough to feed a bundled demo recording or a
 * captured audio buffer into audio-anti-spoofing.ts. Not a general-purpose
 * audio library: rejects anything other than uncompressed PCM.
 */

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Normalized to [-1.0, 1.0], first channel only if multi-channel. */
  samples: Float64Array;
}

function readString(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Decodes a PCM WAV file's bytes into normalized float samples. Throws on non-PCM or malformed input. */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);

  if (readString(view, 0, 4) !== "RIFF" || readString(view, 8, 4) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file.");
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;

    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataLength = chunkSize;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset === -1) throw new Error("WAV file has no data chunk.");
  if (audioFormat !== 1) throw new Error(`Unsupported WAV audio format ${audioFormat} (only PCM=1 is supported).`);
  if (bitsPerSample !== 16) throw new Error(`Unsupported bits-per-sample ${bitsPerSample} (only 16-bit is supported).`);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float64Array(frameCount);

  for (let i = 0; i < frameCount; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample * channels;
    samples[i] = view.getInt16(sampleOffset, true) / 32768.0;
  }

  return { sampleRate, channels, samples };
}
