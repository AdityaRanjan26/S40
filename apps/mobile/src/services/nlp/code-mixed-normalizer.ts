/**
 * On-device port of ml/nlp/code_mixed_normalizer.py's CodeMixedNormalizer.
 * Lightweight, deterministic normalizer for multilingual and code-mixed
 * Indian transcripts: Unicode NFKC decomposition, repeated-character
 * collapse, and phonetic unification for Romanized Hinglish/Banglish text.
 */

const COLLAPSE_REPEATS = /(.)\1{2,}/gi;
const MULTI_SPACE = /\s+/g;

export function normalize(text: string): string {
  if (!text) return "";

  // 1. Unicode NFKC normalization (essential for Indic scripts).
  let normalized = text.normalize("NFKC");

  // 2. Lowercase and collapse elongated vowel/consonant spam.
  normalized = normalized.toLowerCase();
  normalized = normalized.replace(COLLAPSE_REPEATS, "$1$1");

  // 3. Clean spacing.
  normalized = normalized.replace(MULTI_SPACE, " ").trim();

  return normalized;
}

export function canonicalizeRoman(text: string): string {
  let t = normalize(text);

  // Phonetic vowel normalization.
  t = t.replace(/ee+/g, "i");
  t = t.replace(/oo+/g, "u");
  t = t.replace(/aa+/g, "a");

  // Common Indic romanization digraphs.
  t = t.replace(/ph/g, "f");
  t = t.replace(/dh\b/g, "d"); // e.g., "bandh" -> "band"
  t = t.replace(/sh/g, "s"); // e.g., "shontan" -> "sontan"
  t = t.replace(/kh/g, "k"); // e.g., "khatre" -> "katre"

  // Punctuation to space (keep word chars + Devanagari/Bengali/Odia ranges).
  t = t.replace(/[^\w\sऀ-ॿঀ-৿଀-୿]/g, " ");
  t = t.replace(MULTI_SPACE, " ").trim();
  return t;
}

/** Returns [base, canonical] search variants, deduped if identical. */
export function getSearchVariants(text: string): string[] {
  const base = normalize(text);
  const canonical = canonicalizeRoman(text);
  if (base === canonical) return [base];
  return [base, canonical];
}
