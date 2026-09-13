import { DetectorResult, RiskLevel } from "./risk";

export type CallStatus = "inactive" | "connecting" | "active" | "fraud_alert" | "disconnected";

export interface CallerInfo {
  displayName: string;
  phoneNumber: string;
  direction: "inbound" | "outbound";
}

export interface TranscriptLine {
  id: string;
  speaker: "caller" | "user";
  text: string;
  atSec: number;
  isFinal: boolean;
}

export type DetectedPattern =
  | "AUTHORITY_IMPERSONATION"
  | "REMOTE_ACCESS_COERCION"
  | "FINANCIAL_CREDENTIAL_EXTRACTION"
  | "URGENT_LANGUAGE"
  | "OTP_SOLICITATION"
  | "SUSPICIOUS_CALL_PATTERN";

export interface FraudAlert {
  triggered: boolean;
  pattern: DetectedPattern | null;
  title: string;
  explanation: string;
  recommendedAction: string;
  scamCategory?: string;
  columboTrapPrompt?: string | null;
  isSyntheticVoice?: boolean;
  copilotGuidance?: AdaptiveCopilotGuidance | null;
}

/**
 * Operational and availability states for voice analysis components.
 * Distinguishes when analysis is available, pending, unavailable, or failed.
 */
export type VoiceAnalysisStatus = "available" | "pending" | "unavailable" | "failed";
export type AnalysisStatus = VoiceAnalysisStatus;

export type CoercionLevel = "SAFE" | "ELEVATED" | "CRITICAL";
export type VoiceRiskSource = "transcript" | "acoustic" | "combined";
export type VoiceAnalysisConfidence = "low" | "medium" | "high";

/**
 * Metadata associated with a voice analysis session.
 */
export interface VoiceAnalysisMetadata {
  sessionId?: string;
  callId?: string;
  timestamp: string | number;
  durationSec?: number;
  speakerCount?: number;
  audioSource?: "microphone" | "call_stream" | "simulation" | "telephony";
  sampleRateHz?: number;
  channelCount?: number;
  clientVersion?: string;
  modelVersions?: {
    nlp?: string;
    acoustic?: string;
  };
  processingTimeMs?: number;
  [key: string]: unknown;
}

/**
 * Model metadata descriptor for ML engines (both transcript and acoustic).
 */
export interface VoiceModelMetadata {
  modelName: string;
  modelVersion?: string;
  engine?: string; // "onnx", "pyannote", "wav2vec2", "whisper", "custom"
  latencyMs?: number;
  device?: string; // "cpu", "gpu", "npu", "cloud"
  [key: string]: unknown;
}

/**
 * Request metadata for acoustic analysis requests.
 */
export interface AcousticAnalysisRequestMetadata {
  sessionId?: string;
  sampleRateHz?: number;
  channelCount?: number;
  audioFormat?: "pcm_s16le" | "pcm_f32le" | "opus" | "aac";
  bufferDurationMs?: number;
  timestamp?: number | string;
  source?: "microphone" | "call_stream" | "simulation" | "telephony";
  [key: string]: unknown;
}

/**
 * Metadata descriptor for captured audio buffer chunks.
 * Strictly non-sensitive telemetry: does not carry raw PCM samples.
 */
export interface AudioBufferMetadata {
  sessionId?: string;
  timestamp: number;
  bufferSize: number; // bytes
  sampleRateHz?: number;
  channelCount?: number;
  audioFormat?: "pcm_s16le" | "pcm_f32le" | "opus" | "aac" | string;
  durationMs?: number;
  source?: "microphone" | "call_stream" | "simulation" | "telephony" | string;
}

/**
 * Status of audio buffer ingestion at the service boundary.
 */
export type AudioBufferIngestionStatus =
  | "unavailable"
  | "pending"
  | "accepted"
  | "rejected"
  | "failed";

export interface AudioBufferIngestionResult {
  status: AudioBufferIngestionStatus;
  reason?: string;
  timestamp: number;
  bufferMetadata?: AudioBufferMetadata;
}


/**
 * Acoustic analysis response payload (from future acoustic ML backend).
 * All score and confidence fields remain nullable/optional — never fabricated.
 */
export interface AcousticAnalysisResponse {
  status: VoiceAnalysisStatus;
  riskScore?: number | null; // strictly 0-100 or null if unavailable / pending / failed
  riskLevel?: RiskLevel | null;
  confidence?: number | null; // 0.0 - 1.0 or null
  features?: AcousticFeatures | null;
  detectedAnomalies?: string[];
  audio_spoof_prob?: number;
  is_synthetic_voice?: boolean;
  acoustic_evidence?: string[];
  modelMetadata?: VoiceModelMetadata;
  reason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  timestamp?: number | string;
}

/**
 * Transcript analysis response payload (from NLP classifier backend).
 */
export interface TranscriptAnalysisResponse {
  status?: VoiceAnalysisStatus;
  accumulated_risk?: number;
  coercion_level?: CoercionLevel;
  detected_intents?: string[];
  matched_phrases?: string[];
  scam_categories?: string[];
  columbo_trap_prompt?: string | null;
  language_detected?: string;
  is_scam_alert?: boolean;
  message?: string;
  riskScore?: number;
  riskLevel?: RiskLevel;
  modelMetadata?: VoiceModelMetadata;
  errorMessage?: string | null;
}

export interface AdaptiveCopilotResponse {
  challenge_type?: string;
  escalation_action?: string;
  recommended_challenge?: string | null;
  explanation?: string | null;
}

export interface MultimodalFusionResponse {
  fused_risk_score?: number;
  risk_level?: RiskLevel | string;
  decision?: "ALLOW" | "WARN_CHOICE" | "CONFIRM_OR_CANCEL" | string;
  primary_risk_factors?: string[];
}

/**
 * Combined voice analysis response payload.
 */
export interface CombinedVoiceAnalysisResponse {
  status: VoiceAnalysisStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  transcriptAnalysis: TranscriptAnalysisResponse;
  acousticAnalysis?: AcousticAnalysisResponse | null;
  copilot?: AdaptiveCopilotResponse | null;
  multimodalFusion?: MultimodalFusionResponse | null;
  hasAcousticData?: boolean;
  detectedPatterns?: DetectedPattern[];
  metadata?: VoiceAnalysisMetadata;
  errorMessage?: string | null;
}

/**
 * Error response structure for voice analysis.
 */
export interface VoiceAnalysisErrorResponse {
  status: "failed" | "unavailable";
  category: "transcript" | "acoustic" | "combined" | "transport";
  errorCode: string;
  errorMessage: string;
  timestamp?: number | string;
  retryable?: boolean;
}

/**
 * Categories of WebSocket messages supported by the real-time voice endpoint.
 */
export type VoiceWebSocketMessageType =
  | "transcript_analysis"
  | "acoustic_analysis"
  | "combined_analysis"
  | "analysis_status"
  | "analysis_error";

export interface VoiceWsOutgoingTextChunk {
  text_chunk: string;
  [key: string]: unknown;
}

export interface VoiceWsTranscriptAnalysisMessage {
  type: "transcript_analysis";
  data: TranscriptAnalysisResponse;
  timestamp?: number | string;
}

export interface VoiceWsAcousticAnalysisMessage {
  type: "acoustic_analysis";
  data: AcousticAnalysisResponse;
  timestamp?: number | string;
}

export interface VoiceWsCombinedAnalysisMessage {
  type: "combined_analysis";
  data: CombinedVoiceAnalysisResponse;
  timestamp?: number | string;
}

export interface VoiceWsAnalysisStatusMessage {
  type: "analysis_status";
  status: VoiceAnalysisStatus;
  subsystem?: "transcript" | "acoustic" | "combined";
  message?: string;
  timestamp?: number | string;
}

export interface VoiceWsAnalysisErrorMessage {
  type: "analysis_error";
  error: VoiceAnalysisErrorResponse;
  timestamp?: number | string;
}

export type VoiceWsIncomingMessage =
  | VoiceWsTranscriptAnalysisMessage
  | VoiceWsAcousticAnalysisMessage
  | VoiceWsCombinedAnalysisMessage
  | VoiceWsAnalysisStatusMessage
  | VoiceWsAnalysisErrorMessage;


/**
 * Strongly typed linguistic / transcript analysis.
 * Represents NLP evaluation of the conversation text.
 */
export interface TranscriptAnalysis {
  status: VoiceAnalysisStatus;
  riskScore: number; // 0-100
  riskLevel: RiskLevel; // LOW, MEDIUM, HIGH
  detectedPatterns: DetectedPattern[];
  matchedPhrases: string[];
  scamCategories?: string[];
  columboTrapPrompt?: string | null;
  languageDetected?: string;
  intents?: string[];
  coercionLevel?: CoercionLevel;
  accumulatedRisk?: number; // 0.0 - 1.0 raw score from classifier
  transcript?: TranscriptLine[];
  message?: string;
  reasons?: string[];
  errorMessage?: string | null;
}

/**
 * Acoustic features extracted from audio.
 */
export interface AcousticFeatures {
  stressScore?: number | null;
  syntheticVoiceScore?: number | null; // Deepfake / synthetic voice detection
  backgroundNoiseCategory?: string | null;
  spectralAnomalies?: string[] | null;
  jitter?: number | null;
  shimmer?: number | null;
  snrDb?: number | null;
  [key: string]: unknown;
}

/**
 * Strongly typed acoustic analysis.
 */
export interface AcousticAnalysis {
  status: VoiceAnalysisStatus;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  confidence?: number | null;
  features?: AcousticFeatures | null;
  detectedAnomalies?: string[];
  audioSpoofProb?: number;
  isSyntheticVoice?: boolean;
  acousticEvidence?: string[];
  reason?: string | null;
  errorMessage?: string | null;
}

/**
 * Phase 4: Adaptive Copilot Counter-Inquiry Guidance.
 */
export interface AdaptiveCopilotGuidance {
  challengeType: "VOICE_LIVENESS" | "ADMINISTRATIVE_TRAP" | "NONE" | string;
  escalationAction: "NONE" | "PROMPT_CHALLENGE" | "TERMINATE_CALL" | string;
  recommendedChallenge?: string | null;
  explanation?: string | null;
}

/**
 * Phase 4: Multimodal Bayesian Saturation Fusion Metrics.
 */
export interface MultimodalFusionMetrics {
  fusedRiskScore: number;
  riskLevel: RiskLevel;
  decision: "ALLOW" | "WARN_CHOICE" | "CONFIRM_OR_CANCEL" | string;
  primaryRiskFactors: string[];
}

/**
 * Combined voice and multimodal call analysis.
 */
export interface CombinedVoiceAnalysis {
  status: VoiceAnalysisStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  transcriptAnalysis: TranscriptAnalysis;
  acousticAnalysis: AcousticAnalysis | null;
  copilotGuidance?: AdaptiveCopilotGuidance | null;
  multimodalFusion?: MultimodalFusionMetrics | null;
  hasAcousticData: boolean;
  detectedPatterns: DetectedPattern[];
  scamCategories?: string[];
  columboTrapPrompt?: string | null;
  signals: DetectorResult[];
  reasons: string[];
  alert: FraudAlert;
  metadata?: VoiceAnalysisMetadata;
}

/**
 * Snapshot of an active or recent call state.
 */
export interface CallSnapshot {
  status: CallStatus;
  caller: CallerInfo;
  durationSec: number;
  transcript: TranscriptLine[];
  riskScore: number;
  riskLevel: RiskLevel;
  detectedPatterns: DetectedPattern[];
  scamCategories?: string[];
  columboTrapPrompt?: string | null;
  copilotGuidance?: AdaptiveCopilotGuidance | null;
  signals: DetectorResult[];
  reasons: string[];
  alert: FraudAlert;
  analysis?: CombinedVoiceAnalysis;
}

// ─────────────────────────────────────────────────────────────
// Pure Helper & Factory Functions (Zero External Dependencies)
// ─────────────────────────────────────────────────────────────

/**
 * Creates an authoritative "unavailable" acoustic analysis result.
 * Strictly sets riskScore and riskLevel to null without fabricating dummy numbers.
 */
export function createUnavailableAcousticAnalysis(
  reason = "Acoustic analysis backend is not implemented yet"
): AcousticAnalysis {
  return {
    status: "unavailable",
    riskScore: null,
    riskLevel: null,
    confidence: null,
    features: null,
    detectedAnomalies: [],
    reason,
    errorMessage: null,
  };
}

/**
 * Type guard to check if acoustic analysis is genuinely available with a valid computed score.
 */
export function isAcousticAnalysisAvailable(
  acoustic?: AcousticAnalysis | null
): acoustic is AcousticAnalysis & { riskScore: number; riskLevel: RiskLevel } {
  return (
    acoustic !== null &&
    acoustic !== undefined &&
    acoustic.status === "available" &&
    typeof acoustic.riskScore === "number" &&
    !Number.isNaN(acoustic.riskScore) &&
    acoustic.riskLevel !== null &&
    acoustic.riskLevel !== undefined
  );
}

/**
 * Combines transcript analysis with optional acoustic analysis.
 * If acoustic analysis is unavailable or null:
 * - hasAcousticData is strictly false.
 * - Overall riskScore and riskLevel are derived entirely from transcript analysis.
 * - No fake acoustic score is ever assigned.
 */
export function buildCombinedVoiceAnalysis(
  transcript: TranscriptAnalysis,
  acoustic?: AcousticAnalysis | null,
  metadata?: VoiceAnalysisMetadata,
  copilotGuidance?: AdaptiveCopilotGuidance | null,
  multimodalFusion?: MultimodalFusionMetrics | null
): CombinedVoiceAnalysis {
  const acousticResult = acoustic ?? createUnavailableAcousticAnalysis();
  const hasAcoustic = isAcousticAnalysisAvailable(acousticResult);

  // When multimodal fusion is provided, its calibrated score takes authoritative precedence
  const overallRiskScore = multimodalFusion && typeof multimodalFusion.fusedRiskScore === "number"
    ? multimodalFusion.fusedRiskScore
    : hasAcoustic && typeof acousticResult.riskScore === "number"
    ? Math.round(0.7 * transcript.riskScore + 0.3 * acousticResult.riskScore)
    : transcript.riskScore;

  const overallRiskLevel = multimodalFusion
    ? (multimodalFusion.riskLevel as RiskLevel)
    : transcript.riskLevel;

  const patterns = Array.from(new Set([
    ...transcript.detectedPatterns,
  ]));

  const reasons = transcript.reasons && transcript.reasons.length > 0
    ? transcript.reasons
    : transcript.matchedPhrases.length > 0
    ? transcript.matchedPhrases
    : [transcript.message || "Voice analysis completed"];

  const signals: DetectorResult[] = [
    {
      key: "voice",
      label: "Live Voice Scam Classifier",
      score: transcript.riskScore / 100,
      status: transcript.status === "available" ? "ok" : "unavailable",
      factors: transcript.matchedPhrases.map((phrase) => ({
        label: `Matched phrase: "${phrase}"`,
        contribution: transcript.riskScore / 100,
        direction: "increases" as const,
      })),
    },
  ];

  if (hasAcoustic && typeof acousticResult.riskScore === "number") {
    signals.push({
      key: "acoustic",
      label: "Audio Anti-Spoofing Detector",
      score: acousticResult.riskScore / 100,
      status: acousticResult.status === "available" ? "ok" : "unavailable",
      factors: (acousticResult.acousticEvidence || []).map((ev) => ({
        label: ev.replace(/_/g, " "),
        contribution: (acousticResult.riskScore || 0) / 100,
        direction: "increases" as const,
      })),
    });
  }

  const isAlertTriggered =
    overallRiskScore >= 61 ||
    transcript.coercionLevel === "CRITICAL" ||
    acousticResult.isSyntheticVoice;

  const alertTitle = acousticResult.isSyntheticVoice
    ? "Synthetic AI Voice Clone Detected"
    : transcript.scamCategories && transcript.scamCategories.length > 0
    ? `${transcript.scamCategories[0].replace(/_/g, " ")} In Progress`
    : "High-Threat Social Engineering Attack";

  const alert: FraudAlert = isAlertTriggered
    ? {
        triggered: true,
        pattern: patterns[0] || "SUSPICIOUS_CALL_PATTERN",
        title: alertTitle,
        explanation: transcript.message || "High-risk social engineering patterns detected.",
        recommendedAction: copilotGuidance?.recommendedChallenge || "Refuse any OTP/PIN request, end this call immediately, and report the caller.",
        scamCategory: transcript.scamCategories ? transcript.scamCategories[0] : undefined,
        columboTrapPrompt: transcript.columboTrapPrompt,
        isSyntheticVoice: acousticResult.isSyntheticVoice,
        copilotGuidance,
      }
    : {
        triggered: false,
        pattern: null,
        title: "",
        explanation: "",
        recommendedAction: "",
      };

  return {
    status: transcript.status,
    riskScore: overallRiskScore,
    riskLevel: overallRiskLevel,
    transcriptAnalysis: transcript,
    acousticAnalysis: acousticResult,
    copilotGuidance,
    multimodalFusion,
    hasAcousticData: hasAcoustic,
    detectedPatterns: patterns,
    scamCategories: transcript.scamCategories,
    columboTrapPrompt: transcript.columboTrapPrompt,
    signals,
    reasons,
    alert,
    metadata,
  };
}

/**
 * Defensive normalizer for voice analysis payloads.
 * Handles empty, null, malformed, or missing inputs safely without throwing.
 */
export function safeNormalizeVoiceAnalysis(input: unknown): CombinedVoiceAnalysis {
  if (!input || typeof input !== "object") {
    const defaultTranscript: TranscriptAnalysis = {
      status: "unavailable",
      riskScore: 0,
      riskLevel: "LOW",
      detectedPatterns: [],
      matchedPhrases: [],
      reasons: ["No analysis data available"],
    };
    return buildCombinedVoiceAnalysis(defaultTranscript, createUnavailableAcousticAnalysis("No acoustic data provided"));
  }

  const obj = input as Record<string, any>;

  // Check if input is already a CombinedVoiceAnalysis
  if ("transcriptAnalysis" in obj && obj.transcriptAnalysis && typeof obj.transcriptAnalysis === "object") {
    const rawTranscript = obj.transcriptAnalysis;
    const rawScore = typeof rawTranscript.riskScore === "number" && !Number.isNaN(rawTranscript.riskScore)
      ? rawTranscript.riskScore
      : typeof obj.riskScore === "number" && !Number.isNaN(obj.riskScore)
      ? obj.riskScore
      : 0;

    const transcript: TranscriptAnalysis = {
      status: typeof rawTranscript.status === "string" ? rawTranscript.status : "available",
      riskScore: rawScore,
      riskLevel: rawTranscript.riskLevel === "HIGH" || rawTranscript.riskLevel === "MEDIUM" ? rawTranscript.riskLevel : "LOW",
      detectedPatterns: Array.isArray(rawTranscript.detectedPatterns) ? rawTranscript.detectedPatterns : [],
      matchedPhrases: Array.isArray(rawTranscript.matchedPhrases) ? rawTranscript.matchedPhrases : [],
      intents: Array.isArray(rawTranscript.intents) ? rawTranscript.intents : undefined,
      message: typeof rawTranscript.message === "string" ? rawTranscript.message : undefined,
      reasons: Array.isArray(rawTranscript.reasons) ? rawTranscript.reasons : undefined,
    };

    let acoustic: AcousticAnalysis | null = null;
    if (obj.acousticAnalysis && typeof obj.acousticAnalysis === "object") {
      const rawAcoustic = obj.acousticAnalysis;
      acoustic = {
        status: typeof rawAcoustic.status === "string" ? rawAcoustic.status : "unavailable",
        riskScore: typeof rawAcoustic.riskScore === "number" && !Number.isNaN(rawAcoustic.riskScore) ? rawAcoustic.riskScore : null,
        riskLevel: rawAcoustic.riskLevel === "HIGH" || rawAcoustic.riskLevel === "MEDIUM" || rawAcoustic.riskLevel === "LOW" ? rawAcoustic.riskLevel : null,
        confidence: typeof rawAcoustic.confidence === "number" ? rawAcoustic.confidence : null,
        features: rawAcoustic.features && typeof rawAcoustic.features === "object" ? rawAcoustic.features : null,
        detectedAnomalies: Array.isArray(rawAcoustic.detectedAnomalies) ? rawAcoustic.detectedAnomalies : [],
        reason: typeof rawAcoustic.reason === "string" ? rawAcoustic.reason : null,
        errorMessage: typeof rawAcoustic.errorMessage === "string" ? rawAcoustic.errorMessage : null,
      };
    } else {
      acoustic = createUnavailableAcousticAnalysis();
    }

    return buildCombinedVoiceAnalysis(transcript, acoustic, obj.metadata);
  }

  // Fallback: construct from flat object if present
  const score = typeof obj.riskScore === "number" && !Number.isNaN(obj.riskScore) ? obj.riskScore : 0;
  const level: RiskLevel = obj.riskLevel === "HIGH" || obj.riskLevel === "MEDIUM" ? obj.riskLevel : "LOW";
  const patterns = Array.isArray(obj.detectedPatterns) ? obj.detectedPatterns : [];
  const phrases = Array.isArray(obj.matchedPhrases) ? obj.matchedPhrases : [];

  const fallbackTranscript: TranscriptAnalysis = {
    status: obj.status === "active" || obj.status === "available" ? "available" : "unavailable",
    riskScore: score,
    riskLevel: level,
    detectedPatterns: patterns,
    matchedPhrases: phrases,
    reasons: Array.isArray(obj.reasons) ? obj.reasons : [],
  };

  return buildCombinedVoiceAnalysis(fallbackTranscript, createUnavailableAcousticAnalysis());
}
