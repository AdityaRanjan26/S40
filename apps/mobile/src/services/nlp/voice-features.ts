/**
 * On-device port of ml/features/voice_features.py's VoiceFeatureExtractor.
 * Rule-based linguistic risk-marker extraction from transcribed call text.
 * Lexicons (keyword regex lists) are generated directly from the Python
 * source into assets/nlp/voice_lexicons.json — see that file's header
 * comment in the export script for provenance — rather than hand-copied,
 * to guarantee they can't silently drift out of sync.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lexicons = require("../../../assets/nlp/voice_lexicons.json") as {
  urgencyKeywords: string[];
  threatKeywords: string[];
  authorityKeywords: string[];
  financialKeywords: string[];
  credentialKeywords: string[];
  negationMarkerPatterns: string[];
  negationWindowChars: number;
};

const URGENCY_KEYWORDS = lexicons.urgencyKeywords.map((p) => new RegExp(p));
const THREAT_KEYWORDS = lexicons.threatKeywords.map((p) => new RegExp(p));
const AUTHORITY_KEYWORDS = lexicons.authorityKeywords.map((p) => new RegExp(p));
const FINANCIAL_KEYWORDS = lexicons.financialKeywords.map((p) => new RegExp(p));
const CREDENTIAL_KEYWORDS = lexicons.credentialKeywords.map((p) => new RegExp(p));
const NEGATION_MARKER_PATTERNS = lexicons.negationMarkerPatterns.map((p) => new RegExp(p));
const NEGATION_WINDOW_CHARS = lexicons.negationWindowChars;

export interface VoiceFeatures {
  urgencyScore: number;
  threatScore: number;
  authorityImpersonationScore: number;
  financialRequestScore: number;
  coercionScore: number;
  phishingScore: number;
}

/**
 * True if a negation marker appears shortly before or after a keyword
 * match (e.g. "don't share your OTP" vs. a caller demanding the OTP).
 */
export function isNegated(lowerText: string, matchStart: number, matchEnd?: number): boolean {
  const preceding = lowerText.slice(Math.max(0, matchStart - NEGATION_WINDOW_CHARS), matchStart);
  if (NEGATION_MARKER_PATTERNS.some((p) => p.test(preceding))) return true;

  const endPos = matchEnd ?? matchStart + 1;
  const following = lowerText.slice(endPos, Math.min(lowerText.length, endPos + 30));
  return NEGATION_MARKER_PATTERNS.some((p) => p.test(following));
}

function computeLexiconDensity(lowerText: string, lexicon: RegExp[]): number {
  if (lexicon.length === 0) return 0.0;
  let matches = 0;
  for (const pattern of lexicon) {
    const m = pattern.exec(lowerText);
    if (m && !isNegated(lowerText, m.index)) {
      matches += 1;
    }
  }
  // Saturated ratio mapping 1-3 matches to 0.4 - 1.0 (same formula as Python).
  return Math.min(1.0, matches * 0.35);
}

/** Computes normalized 0.0-1.0 social-engineering risk scores from transcribed call text. */
export function extractFeaturesFromText(text: string): VoiceFeatures {
  if (!text) {
    return {
      urgencyScore: 0,
      threatScore: 0,
      authorityImpersonationScore: 0,
      financialRequestScore: 0,
      coercionScore: 0,
      phishingScore: 0,
    };
  }

  const lowerText = text.toLowerCase();

  const urgency = computeLexiconDensity(lowerText, URGENCY_KEYWORDS);
  const threat = computeLexiconDensity(lowerText, THREAT_KEYWORDS);
  const authority = computeLexiconDensity(lowerText, AUTHORITY_KEYWORDS);
  const financial = computeLexiconDensity(lowerText, FINANCIAL_KEYWORDS);
  const phishing = computeLexiconDensity(lowerText, CREDENTIAL_KEYWORDS);

  const coercion = Math.min(1.0, 0.4 * threat + 0.35 * urgency + 0.25 * financial);

  return {
    urgencyScore: urgency,
    threatScore: threat,
    authorityImpersonationScore: authority,
    financialRequestScore: financial,
    coercionScore: coercion,
    phishingScore: phishing,
  };
}
