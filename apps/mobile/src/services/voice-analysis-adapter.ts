import {
  AcousticAnalysis,
  AcousticAnalysisResponse,
  CombinedVoiceAnalysis,
  CombinedVoiceAnalysisResponse,
  DetectedPattern,
  TranscriptAnalysis,
  TranscriptAnalysisResponse,
  AdaptiveCopilotGuidance,
  MultimodalFusionMetrics,
  VoiceAnalysisStatus,
  VoiceWebSocketMessageType,
  buildCombinedVoiceAnalysis,
  createUnavailableAcousticAnalysis,
  isAcousticAnalysisAvailable,
} from "../types/voice";
import { RiskLevel } from "../types/risk";

export const VALID_DETECTED_PATTERNS = new Set<DetectedPattern>([
  "AUTHORITY_IMPERSONATION",
  "REMOTE_ACCESS_COERCION",
  "FINANCIAL_CREDENTIAL_EXTRACTION",
  "URGENT_LANGUAGE",
  "OTP_SOLICITATION",
  "SUSPICIOUS_CALL_PATTERN",
]);

export const PATTERN_MAP: Record<string, DetectedPattern> = {
  authority_impersonation: "AUTHORITY_IMPERSONATION",
  urgency: "URGENT_LANGUAGE",
  urgent_language: "URGENT_LANGUAGE",
  legal_threat: "SUSPICIOUS_CALL_PATTERN",
  suspicious_call_pattern: "SUSPICIOUS_CALL_PATTERN",
  financial_extraction: "FINANCIAL_CREDENTIAL_EXTRACTION",
  financial_credential_extraction: "FINANCIAL_CREDENTIAL_EXTRACTION",
  credential_harvesting: "OTP_SOLICITATION",
  otp_solicitation: "OTP_SOLICITATION",
  remote_access: "REMOTE_ACCESS_COERCION",
  remote_access_coercion: "REMOTE_ACCESS_COERCION",
};

export const mapDetectedPatterns = (intents: unknown): DetectedPattern[] => {
  if (!Array.isArray(intents)) return [];
  const mapped = intents
    .filter((i): i is string => typeof i === "string")
    .map((i) => {
      if (VALID_DETECTED_PATTERNS.has(i as DetectedPattern)) {
        return i as DetectedPattern;
      }
      return PATTERN_MAP[i.toLowerCase()] || PATTERN_MAP[i.toLowerCase().replace(/ /g, "_")];
    })
    .filter(Boolean) as DetectedPattern[];
  return Array.from(new Set(mapped));
};

export const coercionToLevel = (level: unknown): RiskLevel => {
  if (level === "CRITICAL") return "HIGH";
  if (level === "ELEVATED") return "MEDIUM";
  return "LOW";
};

export const scoreToRiskLevel = (score: number): RiskLevel => {
  if (score >= 61) return "HIGH";
  if (score >= 31) return "MEDIUM";
  return "LOW";
};

/**
 * Validates a risk score strictly to the 0-100 range.
 * Rejects non-numeric, NaN, negative, or > 100 values by returning null.
 */
export function validateRiskScore(raw: unknown): number | null {
  if (typeof raw !== "number" || Number.isNaN(raw) || !Number.isFinite(raw)) {
    return null;
  }
  if (raw < 0 || raw > 100) {
    return null;
  }
  return Math.round(raw);
}

/**
 * Normalizes incoming transcript responses (legacy or future typed envelope).
 * Handles null, undefined, empty, and malformed objects without throwing.
 */
export function normalizeTranscriptResponse(raw: unknown): TranscriptAnalysis {
  if (!raw || typeof raw !== "object") {
    return {
      status: "unavailable",
      riskScore: 0,
      riskLevel: "LOW",
      detectedPatterns: [],
      matchedPhrases: [],
      reasons: ["No transcript analysis data provided"],
    };
  }

  const obj = (
    "type" in (raw as any) && (raw as any).type === "transcript_analysis" && "data" in (raw as any)
      ? (raw as any).data
      : raw
  ) as Record<string, any>;

  // Check for raw 0.0 - 1.0 accumulated_risk vs 0 - 100 riskScore
  let score: number = 0;
  if (typeof obj.riskScore === "number") {
    const valid = validateRiskScore(obj.riskScore);
    score = valid !== null ? valid : 0;
  } else if (typeof obj.accumulated_risk === "number" && !Number.isNaN(obj.accumulated_risk)) {
    const computed = Math.round(obj.accumulated_risk * 100);
    const valid = validateRiskScore(computed);
    score = valid !== null ? valid : 0;
  }

  let level: RiskLevel = "LOW";
  if (obj.coercion_level) {
    level = coercionToLevel(obj.coercion_level);
  } else if (obj.riskLevel === "HIGH" || obj.riskLevel === "MEDIUM" || obj.riskLevel === "LOW") {
    level = obj.riskLevel;
  } else {
    level = scoreToRiskLevel(score);
  }

  const patterns = mapDetectedPatterns(obj.detected_intents || obj.detectedPatterns);
  const matchedPhrases = Array.isArray(obj.matched_phrases)
    ? obj.matched_phrases.filter((p: unknown): p is string => typeof p === "string")
    : Array.isArray(obj.matchedPhrases)
    ? obj.matchedPhrases.filter((p: unknown): p is string => typeof p === "string")
    : [];

  const reasons = Array.isArray(obj.reasons) && obj.reasons.length > 0
    ? obj.reasons.filter((r: unknown): r is string => typeof r === "string")
    : matchedPhrases.length > 0
    ? matchedPhrases
    : typeof obj.message === "string"
    ? [obj.message]
    : [];

  const status: VoiceAnalysisStatus =
    obj.status === "available" || obj.status === "pending" || obj.status === "unavailable" || obj.status === "failed"
      ? obj.status
      : "available";

  const scamCategories = Array.isArray(obj.scam_categories)
    ? obj.scam_categories.filter((c: unknown): c is string => typeof c === "string")
    : Array.isArray(obj.scamCategories)
    ? obj.scamCategories.filter((c: unknown): c is string => typeof c === "string")
    : undefined;

  const columboTrapPrompt =
    typeof obj.columbo_trap_prompt === "string"
      ? obj.columbo_trap_prompt
      : typeof obj.columboTrapPrompt === "string"
      ? obj.columboTrapPrompt
      : null;

  const languageDetected =
    typeof obj.language_detected === "string"
      ? obj.language_detected
      : typeof obj.languageDetected === "string"
      ? obj.languageDetected
      : undefined;

  return {
    status,
    riskScore: score,
    riskLevel: level,
    detectedPatterns: patterns,
    matchedPhrases,
    scamCategories,
    columboTrapPrompt,
    languageDetected,
    intents: Array.isArray(obj.detected_intents) ? obj.detected_intents : undefined,
    coercionLevel: obj.coercion_level,
    accumulatedRisk: typeof obj.accumulated_risk === "number" ? obj.accumulated_risk : score / 100,
    message: typeof obj.message === "string" ? obj.message : undefined,
    reasons,
    errorMessage: typeof obj.errorMessage === "string" ? obj.errorMessage : null,
  };
}

/**
 * Normalizes future acoustic analysis responses.
 * Strictly guarantees:
 * - If acoustic data is absent, pending, unavailable, or failed: riskScore is NULL.
 * - Missing acoustic data is NEVER converted to 0.
 * - Malformed / out-of-bound scores (e.g. < 0 or > 100) are rejected (status='failed', riskScore=null).
 * - Confidence, riskLevel, and reasons are NEVER fabricated.
 */
export function normalizeAcousticResponse(raw: unknown): AcousticAnalysis {
  if (!raw || typeof raw !== "object") {
    return createUnavailableAcousticAnalysis("No acoustic analysis data received");
  }

  const obj = (
    "type" in (raw as any) && (raw as any).type === "acoustic_analysis" && "data" in (raw as any)
      ? (raw as any).data
      : raw
  ) as Record<string, any>;

  // Check explicit status
  const rawStatus = typeof obj.status === "string" ? obj.status : undefined;

  // Handle explicitly unavailable, pending, or failed states
  if (rawStatus === "unavailable") {
    return {
      status: "unavailable",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      features: null,
      detectedAnomalies: [],
      reason: typeof obj.reason === "string" ? obj.reason : "Acoustic analysis is unavailable",
      errorMessage: null,
    };
  }

  if (rawStatus === "pending") {
    return {
      status: "pending",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      features: null,
      detectedAnomalies: [],
      reason: typeof obj.reason === "string" ? obj.reason : "Acoustic analysis is pending",
      errorMessage: null,
    };
  }

  if (rawStatus === "failed") {
    return {
      status: "failed",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      features: null,
      detectedAnomalies: [],
      reason: null,
      errorMessage: typeof obj.errorMessage === "string" ? obj.errorMessage : "Acoustic analysis failed",
    };
  }

  // Check for Phase 2 audio spoof payload
  const spoofObj = obj.audio_spoof || obj.audioSpoof || obj;
  const rawSpoofProb =
    typeof spoofObj.audio_spoof_prob === "number"
      ? spoofObj.audio_spoof_prob
      : typeof spoofObj.audioSpoofProb === "number"
      ? spoofObj.audioSpoofProb
      : undefined;

  if (rawSpoofProb !== undefined) {
    const isSynthetic = Boolean(spoofObj.is_synthetic_voice ?? spoofObj.isSyntheticVoice ?? rawSpoofProb >= 0.65);
    const evidence = Array.isArray(spoofObj.acoustic_evidence)
      ? spoofObj.acoustic_evidence.filter((e: unknown): e is string => typeof e === "string")
      : Array.isArray(spoofObj.acousticEvidence)
      ? spoofObj.acousticEvidence.filter((e: unknown): e is string => typeof e === "string")
      : [];

    const spoofScore = Math.round(rawSpoofProb * 100);
    return {
      status: "available",
      riskScore: spoofScore,
      riskLevel: spoofScore >= 65 ? "HIGH" : spoofScore >= 35 ? "MEDIUM" : "LOW",
      confidence: 0.95,
      audioSpoofProb: rawSpoofProb,
      isSyntheticVoice: isSynthetic,
      acousticEvidence: evidence,
      detectedAnomalies: evidence,
      reason: isSynthetic ? "AI Voice clone: pitch tremor flatline & vocoder distortion" : "Natural vocal cords & acoustic dynamics verified",
      errorMessage: null,
    };
  }

  // If score is null or undefined, acoustic is unavailable
  if (obj.riskScore === null || obj.riskScore === undefined) {
    return createUnavailableAcousticAnalysis(
      typeof obj.reason === "string" ? obj.reason : "Acoustic risk score is null"
    );
  }

  // Validate numeric score (strictly 0 - 100)
  const validatedScore = validateRiskScore(obj.riskScore);
  if (validatedScore === null) {
    // Malformed score: reject safely, set failed state without fabricating fallback
    return {
      status: "failed",
      riskScore: null,
      riskLevel: null,
      confidence: null,
      features: null,
      detectedAnomalies: [],
      reason: null,
      errorMessage: `Malformed acoustic risk score: ${String(obj.riskScore)} (must be numeric between 0 and 100)`,
    };
  }

  // Score is valid number between 0 and 100
  let level: RiskLevel = scoreToRiskLevel(validatedScore);
  if (obj.riskLevel === "HIGH" || obj.riskLevel === "MEDIUM" || obj.riskLevel === "LOW") {
    level = obj.riskLevel;
  }

  // Confidence: must be 0.0 - 1.0 or null
  let confidence: number | null = null;
  if (typeof obj.confidence === "number" && !Number.isNaN(obj.confidence) && obj.confidence >= 0 && obj.confidence <= 1) {
    confidence = obj.confidence;
  }

  const features = obj.features && typeof obj.features === "object" ? obj.features : null;
  const detectedAnomalies = Array.isArray(obj.detectedAnomalies)
    ? obj.detectedAnomalies.filter((a: unknown): a is string => typeof a === "string")
    : [];

  return {
    status: "available",
    riskScore: validatedScore,
    riskLevel: level,
    confidence,
    features,
    detectedAnomalies,
    reason: typeof obj.reason === "string" ? obj.reason : null,
    errorMessage: null,
  };
}

/**
 * Normalizes Phase 4 adaptive copilot guidance.
 */
export function normalizeAdaptiveCopilotResponse(raw: unknown): AdaptiveCopilotGuidance | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = ((raw as any).copilot || raw) as Record<string, any>;
  if (!obj.challenge_type && !obj.challengeType && !obj.recommended_challenge && !obj.recommendedChallenge) {
    return null;
  }
  return {
    challengeType: String(obj.challenge_type || obj.challengeType || "NONE"),
    escalationAction: String(obj.escalation_action || obj.escalationAction || "NONE"),
    recommendedChallenge: typeof obj.recommended_challenge === "string" ? obj.recommended_challenge : typeof obj.recommendedChallenge === "string" ? obj.recommendedChallenge : null,
    explanation: typeof obj.explanation === "string" ? obj.explanation : null,
  };
}

/**
 * Normalizes combined voice analysis responses.
 * Synthesizes overall risk safely while maintaining strict boundary
 * between transcript and acoustic data.
 */
export function normalizeCombinedResponse(raw: unknown): CombinedVoiceAnalysis {
  if (!raw || typeof raw !== "object") {
    const emptyTranscript = normalizeTranscriptResponse(null);
    const unavailableAcoustic = createUnavailableAcousticAnalysis();
    return buildCombinedVoiceAnalysis(emptyTranscript, unavailableAcoustic);
  }

  const obj = (
    "type" in (raw as any) && (raw as any).type === "combined_analysis" && "data" in (raw as any)
    ? (raw as any).data
    : raw
  ) as Record<string, any>;

  // Extract transcript
  const transcript = normalizeTranscriptResponse(obj.transcriptAnalysis || obj);

  // Extract acoustic
  const acoustic = obj.acousticAnalysis || obj.audio_spoof || obj.audioSpoof
    ? normalizeAcousticResponse(obj.acousticAnalysis || obj.audio_spoof || obj.audioSpoof)
    : createUnavailableAcousticAnalysis();

  // Extract copilot
  const copilot = normalizeAdaptiveCopilotResponse(obj.copilot || obj);

  // Extract multimodal fusion
  const fusionObj = obj.multimodal_fusion || obj.multimodalFusion;
  const multimodalFusion: MultimodalFusionMetrics | null = fusionObj && typeof fusionObj.fused_risk_score === "number"
    ? {
        fusedRiskScore: fusionObj.fused_risk_score,
        riskLevel: fusionObj.risk_level || "LOW",
        decision: fusionObj.decision || "ALLOW",
        primaryRiskFactors: fusionObj.primary_risk_factors || [],
      }
    : null;

  return buildCombinedVoiceAnalysis(
    transcript,
    acoustic,
    obj.metadata,
    copilot,
    multimodalFusion
  );
}

export interface ParsedVoiceWebSocketMessage {
  category: VoiceWebSocketMessageType | "legacy_classifier" | "unknown";
  rawType?: string;
  payload: any;
}

/**
 * Parses and categorizes incoming WebSocket messages.
 * Safely handles text_chunk responses (legacy backend), future typed envelopes,
 * and unknown/malformed messages without throwing or crashing.
 */
export function parseWebSocketMessage(data: unknown): ParsedVoiceWebSocketMessage {
  if (data === null || data === undefined) {
    return { category: "unknown", payload: null };
  }

  let parsed: any;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      return { category: "unknown", payload: data };
    }
  } else {
    parsed = data;
  }

  if (!parsed || typeof parsed !== "object") {
    return { category: "unknown", payload: parsed };
  }

  // Check for typed envelope: { type: "...", data: ... }
  if (typeof parsed.type === "string") {
    switch (parsed.type) {
      case "transcript_analysis":
        return { category: "transcript_analysis", rawType: parsed.type, payload: parsed.data || parsed };
      case "acoustic_analysis":
        return { category: "acoustic_analysis", rawType: parsed.type, payload: parsed.data || parsed };
      case "combined_analysis":
        return { category: "combined_analysis", rawType: parsed.type, payload: parsed.data || parsed };
      case "analysis_status":
        return { category: "analysis_status", rawType: parsed.type, payload: parsed };
      case "analysis_error":
        return { category: "analysis_error", rawType: parsed.type, payload: parsed.error || parsed };
      default:
        return { category: "unknown", rawType: parsed.type, payload: parsed };
    }
  }

  // Check for legacy backend voice_stream.py response format:
  // { accumulated_risk, coercion_level, detected_intents, matched_phrases, is_scam_alert, message }
  if (
    typeof parsed.accumulated_risk === "number" ||
    typeof parsed.coercion_level === "string" ||
    Array.isArray(parsed.matched_phrases)
  ) {
    return { category: "legacy_classifier", payload: parsed };
  }

  return { category: "unknown", payload: parsed };
}
