/**
 * On-device port of ml/models/voice_nlp.joblib — a scikit-learn
 * Pipeline(TfidfVectorizer(ngram_range=(1,3), sublinear_tf=True) ->
 * LogisticRegression). Re-implements sklearn's exact TF-IDF math
 * (smooth IDF, sublinear TF, L2 normalization) plus a logistic sigmoid,
 * against vocabulary/idf/coefficients exported directly from the fitted
 * model (assets/nlp/voice_nlp_model.json) — not retrained, not
 * approximated, the identical fitted parameters. ONNX export was
 * evaluated and rejected: skl2onnx's conversion of TfidfVectorizer
 * requires the com.microsoft.Tokenizer contrib op, whose support in
 * onnxruntime-react-native's prebuilt binary is unverified, whereas this
 * direct port is fully verifiable against the Python original (see
 * voice-classifier-parity.regression.ts).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = require("../../../assets/nlp/voice_nlp_model.json") as {
  vocabulary: Record<string, number>;
  idf: number[];
  ngramRange?: [number, number];
  coef: number[];
  intercept: number;
};

const NGRAM_MIN = 1;
const NGRAM_MAX = 3;

// sklearn's default TfidfVectorizer token pattern: r"(?u)\b\w\w+\b" —
// runs of 2+ Unicode word characters. JS's \w is ASCII-only, so \p{L}\p{N}_
// with the Unicode flag is used to match sklearn's Unicode-aware \w.
const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  return matches.filter((t) => t.length >= 2);
}

function buildNgrams(tokens: string[], minN: number, maxN: number): string[] {
  const ngrams: string[] = [];
  for (let n = minN; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      ngrams.push(tokens.slice(i, i + n).join(" "));
    }
  }
  return ngrams;
}

/**
 * Computes P(scam) for a single piece of text, matching
 * Pipeline.predict_proba([text])[0][1] on the original sklearn pipeline.
 */
export function predictScamProbability(text: string): number {
  if (!text) return 0;

  const tokens = tokenize(text);
  const ngrams = buildNgrams(tokens, NGRAM_MIN, NGRAM_MAX);

  // Raw term counts per vocabulary index.
  const counts = new Map<number, number>();
  for (const gram of ngrams) {
    const idx = model.vocabulary[gram];
    if (idx === undefined) continue;
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }

  if (counts.size === 0) return sigmoid(model.intercept);

  // sublinear_tf: tf = 1 + log(count). smooth_idf already baked into
  // model.idf (exported directly from the fitted vectorizer).
  const tfidf = new Map<number, number>();
  let sumSquares = 0;
  for (const [idx, count] of counts.entries()) {
    const tf = 1 + Math.log(count);
    const value = tf * model.idf[idx];
    tfidf.set(idx, value);
    sumSquares += value * value;
  }

  // L2 normalize.
  const norm = Math.sqrt(sumSquares) || 1;

  // Logistic regression decision function: coef . x + intercept.
  let decision = model.intercept;
  for (const [idx, value] of tfidf.entries()) {
    decision += model.coef[idx] * (value / norm);
  }

  return sigmoid(decision);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
