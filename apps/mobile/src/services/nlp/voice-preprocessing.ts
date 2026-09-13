/**
 * On-device port of voice/preprocessing.py's AudioPreprocessor.normalize_transcript.
 * The Hinglish mapping table is generated directly from Python's
 * HINGLISH_MAPPINGS into assets/nlp/voice_lexicons.json, not hand-copied.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lexicons = require("../../../assets/nlp/voice_lexicons.json") as {
  hinglishMappings: [string, string][];
};

const HINGLISH_MAPPINGS: [RegExp, string][] = lexicons.hinglishMappings.map(([pattern, replacement]) => [
  new RegExp(pattern, "g"),
  replacement,
]);

/**
 * Cleans raw audio transcript text, strips special characters, and maps
 * Hinglish terms to standardized English terms.
 */
export function normalizeTranscript(rawTranscript: string): string {
  if (!rawTranscript) return "";

  // Lowercase and replace punctuation with spaces. Python's \w on a str
  // pattern is Unicode-aware (matches Devanagari/Bengali/Odia letters,
  // not just ASCII) — JS's \w is ASCII-only, so \p{L}\p{N}_ with the
  // Unicode flag is used instead to avoid silently stripping non-Latin
  // scripts here.
  let text = rawTranscript.toLowerCase().trim();
  text = text.replace(/[^\p{L}\p{N}_\s]/gu, " ");
  text = text.replace(/\s+/g, " ");

  // Apply Hinglish mappings, in the same order as the Python source.
  for (const [pattern, replacement] of HINGLISH_MAPPINGS) {
    text = text.replace(pattern, replacement);
  }

  return text.trim();
}
