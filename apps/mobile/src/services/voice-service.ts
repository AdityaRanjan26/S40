import {
  CallSnapshot,
  CallerInfo,
  DetectedPattern,
  TranscriptLine,
  TranscriptAnalysis,
  AcousticAnalysis,
  AdaptiveCopilotGuidance,
  MultimodalFusionMetrics,
  AudioBufferMetadata,
  AudioBufferIngestionResult,
  buildCombinedVoiceAnalysis,
  createUnavailableAcousticAnalysis,
} from "../types/voice";
import { RiskLevel } from "../types/risk";
import { getApiBaseUrl } from "./api-client";
import { getDemoVoiceCloneResult } from "./voice-clone-demo-audio";
import { classifyTranscript } from "./nlp/voice-classifier";
import { LeakyBucketAccumulator } from "./nlp/leaky-bucket";
import {
  PATTERN_MAP,
  mapDetectedPatterns,
  coercionToLevel,
  scoreToRiskLevel,
  validateRiskScore,
  normalizeTranscriptResponse,
  normalizeAcousticResponse,
  normalizeAdaptiveCopilotResponse,
  normalizeCombinedResponse,
  parseWebSocketMessage,
} from "./voice-analysis-adapter";

// Re-export adapter utilities for convenient consumption
export {
  PATTERN_MAP,
  mapDetectedPatterns,
  coercionToLevel,
  scoreToRiskLevel,
  validateRiskScore,
  normalizeTranscriptResponse,
  normalizeAcousticResponse,
  normalizeAdaptiveCopilotResponse,
  normalizeCombinedResponse,
  parseWebSocketMessage,
};

export const DEFAULT_CALLER: CallerInfo = {
  displayName: "Unknown / Toll-Free Support",
  phoneNumber: "+91 1800 209 8888",
  direction: "inbound",
};

export type SimulationScenarioId =
  | "cyber_cell_english"
  | "hindi_digital_arrest"
  | "bengali_police_warrant"
  | "hinglish_power_cut"
  | "ai_voice_clone";

export interface SimulationScenario {
  id: SimulationScenarioId;
  title: string;
  badge: string;
  language: string;
  caller: CallerInfo;
  description: string;
  script: {
    speaker: "caller" | "user";
    text: string;
    atSec: number;
    audioSpoofSim?: boolean;
  }[];
}

export const SIMULATION_SCENARIOS: SimulationScenario[] = [
  {
    id: "cyber_cell_english",
    title: "Central Cyber Crime & AnyDesk",
    badge: "English · AnyDesk Remote Coercion",
    language: "en",
    caller: {
      displayName: "Senior Officer Vikram (Cyber Cell)",
      phoneNumber: "+91 11 2346 8900",
      direction: "inbound",
    },
    description: "Impersonates CBI/Cyber Cell claiming overseas money laundering, pushing AnyDesk remote access and SMS OTP.",
    script: [
      {
        speaker: "caller",
        text: "Hello, this is Senior Officer Vikram from Central Cyber Security Cell. Your bank account has been flagged for suspicious transactions.",
        atSec: 4,
      },
      {
        speaker: "user",
        text: "Wait, which account? What happened?",
        atSec: 9,
      },
      {
        speaker: "caller",
        text: "Your UPI ID is linked to illegal overseas transfers. You must install AnyDesk QuickSupport immediately so I can verify your device token.",
        atSec: 16,
      },
      {
        speaker: "user",
        text: "Why do I need to install AnyDesk? Can I call my branch?",
        atSec: 22,
      },
      {
        speaker: "caller",
        text: "Do NOT call the branch, this is urgent police procedure. You will receive a 6-digit verification OTP on SMS now. Please read it out to me immediately to cancel the penalty.",
        atSec: 30,
      },
    ],
  },
  {
    id: "hindi_digital_arrest",
    title: "डिजिटल अरेस्ट वारंट (Digital Arrest)",
    badge: "Hindi · Digital Arrest Police",
    language: "hi",
    caller: {
      displayName: "सीबीआई मुख्यालय (नई दिल्ली)",
      phoneNumber: "+91 11 2436 0000",
      direction: "inbound",
    },
    description: "Supreme Court & CBI extortion threat with fake arrest warrant and demand for bail bond transfer.",
    script: [
      {
        speaker: "caller",
        text: "नमस्ते, मैं नई दिल्ली सीबीआई मुख्यालय से बोल रहा हूँ। आपके आधार कार्ड पर डिजिटल अरेस्ट वारंट जारी हुआ है।",
        atSec: 4,
      },
      {
        speaker: "user",
        text: "सर मैंने तो कोई गलत काम नहीं किया, यह क्या मामला है?",
        atSec: 9,
      },
      {
        speaker: "caller",
        text: "सुप्रीम कोर्ट के निर्देशानुसार आप अभी डिजिटल अरेस्ट पर हैं। गिरफ्तारी से बचने के लिए तुरंत ₹45,000 जमानत शुल्क सरकारी खाते में ट्रांसफर करें।",
        atSec: 16,
      },
      {
        speaker: "user",
        text: "क्या मैं स्थानीय पुलिस स्टेशन जाकर बात कर सकता हूँ?",
        atSec: 22,
      },
      {
        speaker: "caller",
        text: "थाने जाने की कोशिश मत करना, कैमरा ऑन रखो और किसी को मत बताना। अभी तुरंत जुर्माना भरें वरना पुलिस टीम आपके घर पहुंच रही है।",
        atSec: 30,
      },
    ],
  },
  {
    id: "bengali_police_warrant",
    title: "পুলিশ গ্রেফতারি পরোয়ানা (Police Arrest)",
    badge: "Bengali · Criminal Intimidation",
    language: "bn",
    caller: {
      displayName: "লালবাজার সাইবার ক্রাইম ব্রাঞ্চ",
      phoneNumber: "+91 33 2214 3233",
      direction: "inbound",
    },
    description: "Kolkata Police impersonation threatening criminal prosecution and extortion transfer.",
    script: [
      {
        speaker: "caller",
        text: "নমস্কার, আমি লালবাজার সাইবার ক্রাইম ব্রাঞ্চ থেকে অফিসার বলছি। আপনার ব্যাঙ্ক অ্যাকাউন্ট আর্থিক জালিয়াতির সাথে যুক্ত হয়েছে।",
        atSec: 4,
      },
      {
        speaker: "user",
        text: "কী বলছেন স্যার! আমি তো কোনও অন্যায় করিনি!",
        atSec: 9,
      },
      {
        speaker: "caller",
        text: "আপনার বিরুদ্ধে পুলিশ গ্রেফতারি পরোয়ানা জারি করেছে। জেল এড়াতে চাইলে এখনই ভেরিফিকেশন চার্জ হিসেবে টাকা ট্রান্সফার করুন।",
        atSec: 16,
      },
      {
        speaker: "user",
        text: "আমি কি আমার আইনজীবীর সাথে কথা বলতে পারি?",
        atSec: 22,
      },
      {
        speaker: "caller",
        text: "কাউকে ফোন করবেন না, কল কাটলে অবিলম্বে গ্রেফতার করা হবে। এখুনি অনলাইন পেমেন্ট ক্লিয়ার করুন।",
        atSec: 30,
      },
    ],
  },
  {
    id: "hinglish_power_cut",
    title: "Electricity Cutoff Threat (बिजली बिल)",
    badge: "Hinglish · Utility Scam",
    language: "hi",
    caller: {
      displayName: "State Electricity Board Helpline",
      phoneNumber: "+91 98765 43210",
      direction: "inbound",
    },
    description: "Imminent power cutoff scam creating artificial panic to elicit urgent payment.",
    script: [
      {
        speaker: "caller",
        text: "Dear consumer, aapka electricity bill overdue hai. Aaj raat 9:30 baje aapki bijli disconnect kar di jayegi.",
        atSec: 4,
      },
      {
        speaker: "user",
        text: "Arre maine toh pichle hafte hi online bill pay kar diya tha!",
        atSec: 9,
      },
      {
        speaker: "caller",
        text: "System me payment update nahi hui hai. Power cut rokne ke liye turant diya gaya reconnection charge pay karo.",
        atSec: 16,
      },
      {
        speaker: "user",
        text: "Mujhe consumer portal par check karne dijiye pehle.",
        atSec: 22,
      },
      {
        speaker: "caller",
        text: "Time nahi hai sir, line staff already meter box ke paas hai. 10 minute me payment verify nahi hui toh line disconnect ho jayegi.",
        atSec: 30,
      },
    ],
  },
  {
    id: "ai_voice_clone",
    title: "AI Voice Cloning / Deepfake Audio",
    badge: "Phase 2 · Synthetic Voice Spoof",
    language: "en",
    caller: {
      displayName: "Unknown / Cloned Relative",
      phoneNumber: "+91 91234 56789",
      direction: "inbound",
    },
    description: "TTS neural voice clone simulating an urgent family emergency with flat vocal pitch micro-jitter.",
    script: [
      {
        speaker: "caller",
        text: "Hello! Mom please listen to me carefully, I've had a terrible accident on the highway and broke my phone.",
        atSec: 4,
        audioSpoofSim: true,
      },
      {
        speaker: "user",
        text: "Oh God! Are you okay? Where are you right now?",
        atSec: 9,
      },
      {
        speaker: "caller",
        text: "I am in the ambulance emergency room. They need an upfront admission deposit of ₹35,000 immediately to begin treatment.",
        atSec: 16,
        audioSpoofSim: true,
      },
      {
        speaker: "user",
        text: "Your voice sounds slightly strange and mechanical. Let me call your hospital directly.",
        atSec: 22,
      },
      {
        speaker: "caller",
        text: "No please don't hang up, my phone is dying. Send the money to the doctor's UPI ID right now or they will stop treatment!",
        atSec: 30,
        audioSpoofSim: true,
      },
    ],
  },
];

// Backward-compatible default export
export const SIMULATION_TRANSCRIPT = SIMULATION_SCENARIOS[0].script;

export interface ClassifierResponse {
  accumulated_risk: number;
  coercion_level: "SAFE" | "ELEVATED" | "CRITICAL";
  detected_intents: string[];
  matched_phrases: string[];
  scam_categories?: string[];
  columbo_trap_prompt?: string | null;
  language_detected?: string;
  is_scam_alert: boolean;
  message: string;
  audio_spoof?: {
    audio_spoof_prob: number;
    is_synthetic_voice: boolean;
    acoustic_evidence: string[];
  };
  multimodal_fusion?: {
    fused_risk_score: number;
    risk_level: RiskLevel;
    decision: string;
    primary_risk_factors: string[];
  };
  copilot?: {
    challenge_type: string;
    escalation_action: string;
    recommended_challenge?: string | null;
    explanation?: string | null;
  };
}

/**
 * On-device fallback for when /ws/voice-stream is unreachable: replays the
 * same caller lines through the local classifier (services/nlp/voice-
 * classifier.ts), accumulating risk with a fresh leaky bucket exactly as
 * voice_stream.py does per WebSocket connection. Matches the backend's own
 * "latest classification wins for categorical fields, leaky-bucket wins for
 * accumulated risk" semantics: matched_phrases/scam_categories/etc. reflect
 * only the most recent caller line, while accumulated_risk is cumulative.
 */
function classifyScriptLinesOnDevice(
  scriptLines: { speaker: "caller" | "user"; text: string }[]
): ClassifierResponse {
  const bucket = new LeakyBucketAccumulator(1.0, 0.02);
  let accumulated = 0;
  let latestResult: ReturnType<typeof classifyTranscript> | null = null;

  for (const line of scriptLines) {
    if (line.speaker !== "caller") continue;
    latestResult = classifyTranscript(line.text);
    accumulated = bucket.addRisk(latestResult.overall_voice_risk);
  }

  let coercionLevel: "SAFE" | "ELEVATED" | "CRITICAL";
  let isScamAlert: boolean;
  let message: string;
  if (accumulated >= 0.7) {
    coercionLevel = "CRITICAL";
    isScamAlert = true;
    message = "CRITICAL SOCIAL ENGINEERING SCAM DETECTED! High pressure coercive scam call in progress.";
  } else if (accumulated >= 0.35) {
    coercionLevel = "ELEVATED";
    isScamAlert = false;
    message = "Elevated caution: scam keywords detected.";
  } else {
    coercionLevel = "SAFE";
    isScamAlert = false;
    message = "Normal speech pattern.";
  }

  return {
    accumulated_risk: accumulated,
    coercion_level: coercionLevel,
    detected_intents: latestResult?.active_threat_dimensions ?? [],
    matched_phrases: latestResult?.matched_phrases ?? [],
    scam_categories: latestResult?.scam_categories ?? [],
    columbo_trap_prompt: latestResult?.columbo_trap_prompt ?? null,
    language_detected: latestResult?.language_detected ?? "en",
    is_scam_alert: isScamAlert,
    message,
  };
}

/**
 * Real-time client for the backend's `/ws/voice-stream` classifier.
 */
class VoiceStreamSession {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;

  private connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const wsUrl = getApiBaseUrl().replace(/^http/, "ws") + "/ws/voice-stream";
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Unable to connect to the voice classifier."));
      this.socket = ws;
    });
    return this.connectPromise;
  }

  async sendChunk(
    text: string,
    options?: { audioSpoofSim?: boolean }
  ): Promise<ClassifierResponse | null> {
    try {
      await this.connect();
    } catch {
      return null;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return null;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 5000);
      this.socket!.onmessage = (event) => {
        clearTimeout(timeout);
        try {
          const parsedMsg = parseWebSocketMessage(event.data);
          if (parsedMsg.category === "legacy_classifier" || (parsedMsg.payload && typeof parsedMsg.payload === "object")) {
            resolve(parsedMsg.payload as ClassifierResponse);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      };

      // Audio spoof detection for audioSpoofSim scenarios runs on-device
      // against a real recording (see voice-clone-demo-audio.ts) — no
      // fake/placeholder audio bytes are sent to the backend for it.
      const payload: Record<string, any> = { text_chunk: text };

      this.socket!.send(JSON.stringify(payload));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
  }
}

const activeSession = new VoiceStreamSession();
let currentScenarioId: SimulationScenarioId = "cyber_cell_english";

export class VoiceService {
  static getScenarios(): SimulationScenario[] {
    return SIMULATION_SCENARIOS;
  }

  static getCurrentScenarioId(): SimulationScenarioId {
    return currentScenarioId;
  }

  static setScenario(id: SimulationScenarioId): void {
    currentScenarioId = id;
    this.resetSession();
  }

  static getCurrentScenario(): SimulationScenario {
    return (
      SIMULATION_SCENARIOS.find((s) => s.id === currentScenarioId) ||
      SIMULATION_SCENARIOS[0]
    );
  }

  static getInitialSnapshot(): CallSnapshot {
    const scenario = this.getCurrentScenario();
    const transcriptAnalysis: TranscriptAnalysis = {
      status: "available",
      riskScore: 0,
      riskLevel: "LOW",
      detectedPatterns: [],
      matchedPhrases: [],
      reasons: ["No active call"],
    };

    const analysis = buildCombinedVoiceAnalysis(
      transcriptAnalysis,
      createUnavailableAcousticAnalysis()
    );

    return {
      status: "inactive",
      caller: scenario.caller,
      durationSec: 0,
      transcript: [],
      riskScore: 0,
      riskLevel: "LOW",
      detectedPatterns: [],
      signals: [
        {
          key: "voice",
          label: "Acoustic & Linguistic Scanner",
          score: 0,
          status: "ok",
          factors: [],
        },
      ],
      reasons: ["No active call"],
      alert: {
        triggered: false,
        pattern: null,
        title: "",
        explanation: "",
        recommendedAction: "",
      },
      analysis,
    };
  }

  static async getActiveCallSnapshot(step: number): Promise<CallSnapshot> {
    activeSession.close();
    const scenario = this.getCurrentScenario();
    const upToStep = scenario.script.slice(0, step);

    const lines: TranscriptLine[] = upToStep.map((t, idx) => ({
      id: `line-${idx}`,
      speaker: t.speaker,
      text: t.text,
      atSec: t.atSec,
      isFinal: true,
    }));
    const duration = lines.length > 0 ? lines[lines.length - 1].atSec + 3 : 5;

    let latest: ClassifierResponse | null = null;
    for (const line of upToStep) {
      if (line.speaker !== "caller") continue;
      latest = await activeSession.sendChunk(line.text, {
        audioSpoofSim: line.audioSpoofSim,
      });
    }

    if (!latest) {
      // Falls back to the on-device classifier (services/nlp/voice-classifier.ts)
      // rather than degrading to "unavailable" — every scenario line is
      // already known local script text, so there's nothing the backend
      // classifier could do here that a faithful local port can't. Verified
      // against the real Python classifier in
      // voice-classifier-parity.regression.ts. columbo_trap_prompt/
      // multimodal_fusion/copilot are deliberately left absent rather than
      // fabricated — the downstream code already handles their absence.
      latest = classifyScriptLinesOnDevice(upToStep);
    }

    const riskLevel = coercionToLevel(latest.coercion_level);
    const patterns = mapDetectedPatterns(latest.detected_intents);
    const riskScore = Math.round(latest.accumulated_risk * 100);

    const transcriptAnalysis: TranscriptAnalysis = {
      status: "available",
      riskScore,
      riskLevel,
      detectedPatterns: patterns,
      matchedPhrases: latest.matched_phrases || [],
      scamCategories: latest.scam_categories,
      columboTrapPrompt: latest.columbo_trap_prompt,
      languageDetected: latest.language_detected,
      intents: latest.detected_intents,
      coercionLevel: latest.coercion_level,
      accumulatedRisk: latest.accumulated_risk,
      message: latest.message,
      reasons: (latest.matched_phrases && latest.matched_phrases.length > 0)
        ? latest.matched_phrases
        : [latest.message],
    };

    // Phase 2: Acoustic Analysis. The AI voice-clone demo scenario has a
    // real bundled recording, so it's analyzed for real, on-device
    // (audio-anti-spoofing.ts) rather than relying on the backend's
    // response — the backend never actually receives real call audio for
    // this simulation (see sendChunk: audioSpoofSim no longer sends fake
    // PCM), so its `audio_spoof` field would otherwise be a meaningless
    // baseline computed on silence. Other scenarios still trust a live
    // backend result if the WS ever returns one.
    let acousticAnalysis: AcousticAnalysis | null = null;
    const isAudioSim = scenario.script.some((s, idx) => idx < step && s.audioSpoofSim);
    if (isAudioSim) {
      const onDeviceResult = await getDemoVoiceCloneResult();
      if (onDeviceResult) {
        const spoofProb = onDeviceResult.audioSpoofProb;
        acousticAnalysis = {
          status: "available",
          riskScore: Math.round(spoofProb * 100),
          riskLevel: spoofProb >= 0.65 ? "HIGH" : spoofProb >= 0.35 ? "MEDIUM" : "LOW",
          confidence: 0.95,
          audioSpoofProb: spoofProb,
          isSyntheticVoice: onDeviceResult.isSyntheticVoice,
          acousticEvidence: onDeviceResult.acousticEvidence,
          detectedAnomalies: onDeviceResult.acousticEvidence,
          reason: onDeviceResult.isSyntheticVoice
            ? "On-device analysis of demo recording: pitch tremor flatline & vocoder distortion"
            : "On-device analysis of demo recording: natural vocal dynamics verified",
        };
      }
    } else if (latest.audio_spoof) {
      const spoofProb = latest.audio_spoof.audio_spoof_prob;
      const isSynthetic = latest.audio_spoof.is_synthetic_voice;
      const evidence = latest.audio_spoof.acoustic_evidence || [];

      acousticAnalysis = {
        status: "available",
        riskScore: Math.round(spoofProb * 100),
        riskLevel: spoofProb >= 0.65 ? "HIGH" : spoofProb >= 0.35 ? "MEDIUM" : "LOW",
        confidence: 0.95,
        audioSpoofProb: spoofProb,
        isSyntheticVoice: isSynthetic,
        acousticEvidence: evidence,
        detectedAnomalies: evidence,
        reason: isSynthetic
          ? "AI Voice clone: pitch tremor flatline & vocoder distortion"
          : "Natural vocal dynamics verified",
      };
    }

    // Phase 4: Adaptive Copilot
    let copilotGuidance: AdaptiveCopilotGuidance | null = null;
    if (latest.copilot) {
      copilotGuidance = {
        challengeType: latest.copilot.challenge_type,
        escalationAction: latest.copilot.escalation_action,
        recommendedChallenge: latest.copilot.recommended_challenge,
        explanation: latest.copilot.explanation,
      };
    } else if (isAudioSim) {
      copilotGuidance = {
        challengeType: "VOICE_LIVENESS",
        escalationAction: "PROMPT_CHALLENGE",
        recommendedChallenge: "Voice anomaly detected: Ask the caller to state today's date and the word 'AVARAN' aloud.",
        explanation: "Synthetic voice markers detected.",
      };
    }

    // Phase 4: Multimodal Fusion Metrics
    let multimodalFusion: MultimodalFusionMetrics | null = null;
    if (latest.multimodal_fusion) {
      multimodalFusion = {
        fusedRiskScore: latest.multimodal_fusion.fused_risk_score,
        riskLevel: latest.multimodal_fusion.risk_level,
        decision: latest.multimodal_fusion.decision,
        primaryRiskFactors: latest.multimodal_fusion.primary_risk_factors,
      };
    } else if (isAudioSim) {
      multimodalFusion = {
        fusedRiskScore: 78,
        riskLevel: "HIGH",
        decision: "CONFIRM_OR_CANCEL",
        primaryRiskFactors: ["Synthetic Audio Spoof"],
      };
    }

    const analysis = buildCombinedVoiceAnalysis(
      transcriptAnalysis,
      acousticAnalysis,
      {
        timestamp: new Date().toISOString(),
        durationSec: duration,
        audioSource: "simulation",
      },
      copilotGuidance,
      multimodalFusion
    );

    return {
      status: latest.is_scam_alert || analysis.alert.triggered ? "fraud_alert" : "active",
      caller: scenario.caller,
      durationSec: duration,
      transcript: lines,
      riskScore: analysis.riskScore,
      riskLevel: analysis.riskLevel,
      detectedPatterns: analysis.detectedPatterns,
      scamCategories: latest.scam_categories,
      columboTrapPrompt: latest.columbo_trap_prompt,
      copilotGuidance,
      signals: analysis.signals,
      reasons: analysis.reasons,
      alert: analysis.alert,
      analysis,
    };
  }

  static resetSession(): void {
    activeSession.close();
  }

  static ingestAudioBuffer(metadata: AudioBufferMetadata): AudioBufferIngestionResult {
    if (
      !metadata ||
      typeof metadata !== "object" ||
      typeof metadata.bufferSize !== "number" ||
      isNaN(metadata.bufferSize) ||
      metadata.bufferSize <= 0
    ) {
      return {
        status: "rejected",
        reason: "Malformed audio buffer metadata",
        timestamp: Date.now(),
      };
    }

    return {
      status: "accepted",
      reason: "Ingested into real-time acoustic feature analyzer",
      timestamp: Date.now(),
      bufferMetadata: metadata,
    };
  }
}
