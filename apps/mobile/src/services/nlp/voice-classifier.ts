/**
 * On-device port of voice/classifier.py's VoiceClassifier.classify_transcript.
 * Combines the Aho-Corasick multilingual trie, rule-based linguistic
 * features, and the ported TF-IDF/LogisticRegression model into the same
 * overall_voice_risk scoring classify_transcript produces server-side.
 *
 * Deliberately NOT ported: the Columbo Protocol trap-prompt text
 * generation (engine/copilot/static_trap_prompts.py) — that's supplementary
 * UX copy for a counter-inquiry challenge, not part of the risk score
 * itself, and out of scope for this pass. columbo_trap_prompt is always
 * null here; a caller that needs it can still get it from a real backend
 * call, same as before.
 */

import { normalize as codeMixNormalize, canonicalizeRoman } from "./code-mixed-normalizer";
import { normalizeTranscript } from "./voice-preprocessing";
import { extractFeaturesFromText, isNegated } from "./voice-features";
import { getSharedTrie, TrieMatch } from "./aho-corasick-trie";
import { predictScamProbability } from "./voice-tfidf-model";

export interface VoiceClassificationResult {
  overall_voice_risk: number;
  flags: {
    urgency_detected: boolean;
    threat_detected: boolean;
    authority_impersonation: boolean;
    credential_harvesting: boolean;
  };
  active_threat_dimensions: string[];
  matched_phrases: string[];
  scam_categories: string[];
  columbo_trap_prompt: null;
  language_detected: string;
  transcript_snippet: string;
}

const LEGACY_KEYWORDS = [
  "cbi", "police", "arrest", "digital arrest", "immediately", "block",
  "freeze", "now", "otp", "pin", "fine", "narcotics", "court", "anydesk",
  "warrant", "charges",
];

function detectDominantLanguage(text: string): string {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0980 && code <= 0x09ff) return "bn";
    if (code >= 0x0900 && code <= 0x097f) return "hi";
    if (code >= 0x0b00 && code <= 0x0b7f) return "or";
  }
  return "en";
}

export function classifyTranscript(rawTranscript: string): VoiceClassificationResult {
  const normText = codeMixNormalize(rawTranscript);
  const cleanText = normalizeTranscript(rawTranscript);
  const features = extractFeaturesFromText(cleanText);

  const combinedScore =
    0.25 * features.urgencyScore +
    0.25 * features.threatScore +
    0.2 * features.authorityImpersonationScore +
    0.15 * features.financialRequestScore +
    0.15 * features.phishingScore;

  const trie = getSharedTrie();
  let trieMatches: TrieMatch[] = trie.search(normText);
  const canonicalText = canonicalizeRoman(normText);
  if (canonicalText && canonicalText !== normText) {
    const canonMatches = trie.search(canonicalText);
    for (const cm of canonMatches) {
      if (!trieMatches.some((tm) => tm.keyword === cm.keyword && tm.category === cm.category)) {
        trieMatches.push(cm);
      }
    }
  }

  const validTrieMatches = trieMatches.filter((m) => !isNegated(normText, m.start, m.end));

  const trieCategories = new Set<string>();
  const trieDimensions = new Set<string>();
  const triePhrases: string[] = [];
  let trieWeightSum = 0;

  for (const tm of validTrieMatches) {
    trieCategories.add(tm.category);
    trieDimensions.add(tm.threatDimension);
    if (!triePhrases.includes(tm.keyword)) triePhrases.push(tm.keyword);
    trieWeightSum += tm.weight;
  }

  const trieRisk = validTrieMatches.length > 0 ? Math.min(1.0, (trieWeightSum / 100.0) * 1.5) : 0.0;
  const heuristicScore = Math.max(combinedScore, trieRisk);

  let overallVoiceRisk: number;
  try {
    const modelPred = predictScamProbability(cleanText);
    overallVoiceRisk = Math.min(1.0, 0.4 * heuristicScore + 0.6 * modelPred);
  } catch {
    overallVoiceRisk = Math.min(1.0, heuristicScore);
  }

  const keywordPresent = (kw: string): boolean => {
    const idx = normText.indexOf(kw);
    if (idx !== -1 && !isNegated(normText, idx, idx + kw.length)) return true;
    const idx2 = cleanText.indexOf(kw);
    return idx2 !== -1 && !isNegated(cleanText, idx2, idx2 + kw.length);
  };

  const urgencyDetected =
    features.urgencyScore >= 0.35 ||
    trieDimensions.has("URGENCY") ||
    trieCategories.has("ELECTRICITY_CUTOFF") ||
    keywordPresent("immediately") ||
    keywordPresent("now");
  const threatDetected =
    features.threatScore >= 0.35 ||
    trieDimensions.has("LEGAL_THREAT") ||
    trieCategories.has("DIGITAL_ARREST_POLICE") ||
    trieCategories.has("CHILD_CUSTODY_EXTORTION") ||
    keywordPresent("police") ||
    keywordPresent("block") ||
    keywordPresent("arrest");
  const authorityImpersonation =
    features.authorityImpersonationScore >= 0.35 ||
    trieDimensions.has("AUTHORITY_IMPERSONATION") ||
    trieCategories.has("CUSTOMS_PARCEL_SEIZURE") ||
    keywordPresent("rbi") ||
    keywordPresent("cbi") ||
    keywordPresent("manager");
  const credentialHarvesting =
    features.phishingScore >= 0.35 ||
    trieDimensions.has("CREDENTIAL_HARVESTING") ||
    keywordPresent("otp") ||
    keywordPresent("pin");

  const activeDimensions: string[] = [];
  if (urgencyDetected) activeDimensions.push("URGENCY");
  if (threatDetected) activeDimensions.push("LEGAL_THREAT");
  if (authorityImpersonation) activeDimensions.push("AUTHORITY_IMPERSONATION");
  if (features.financialRequestScore >= 0.35 || trieCategories.has("KYC_ACCOUNT_FREEZE")) {
    activeDimensions.push("FINANCIAL_EXTRACTION");
  }
  if (credentialHarvesting) activeDimensions.push("CREDENTIAL_HARVESTING");

  const matchedPhrases = [...triePhrases];
  for (const kw of LEGACY_KEYWORDS) {
    if (keywordPresent(kw) && !matchedPhrases.includes(kw)) matchedPhrases.push(kw);
  }

  const lang = detectDominantLanguage(cleanText);

  return {
    overall_voice_risk: overallVoiceRisk,
    flags: {
      urgency_detected: urgencyDetected,
      threat_detected: threatDetected,
      authority_impersonation: authorityImpersonation,
      credential_harvesting: credentialHarvesting,
    },
    active_threat_dimensions: activeDimensions,
    matched_phrases: matchedPhrases,
    scam_categories: Array.from(trieCategories).sort(),
    columbo_trap_prompt: null,
    language_detected: lang,
    transcript_snippet: cleanText.slice(0, 100),
  };
}
