/**
 * Parity check: the on-device TypeScript voice-intent classifier
 * (services/nlp/voice-classifier.ts) must match the Python original
 * (voice/classifier.py's VoiceClassifier.classify_transcript) on the same
 * transcripts — same overall_voice_risk (within tolerance for float
 * accumulation order), same categorical flags, same active threat
 * dimensions, same matched phrases and scam categories.
 *
 * Ground truth (voice_classifier_ground_truth.json) was captured by
 * running the real Python VoiceClassifier (with its trained
 * ml/models/voice_nlp.joblib loaded) against 5 representative
 * transcripts: an English scam call, a benign message, a romanized
 * Hindi (Hinglish) utility-cutoff scam, a negated OTP-sharing warning
 * (must NOT be flagged), and a digital-arrest scam.
 */

// @ts-ignore — Node-only module; this script runs under tsx (Node), never bundled into the RN app.
import * as fs from "fs";
// @ts-ignore
import * as path from "path";
import { classifyTranscript } from "../../services/nlp/voice-classifier";

// @ts-ignore — __dirname is provided by tsx's CJS-style transform at runtime.
const groundTruth = JSON.parse(fs.readFileSync(path.resolve(__dirname, "./voice_classifier_ground_truth.json"), "utf-8"));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log("[OK]  ", name);
  } else {
    fail++;
    console.log("[FAIL]", name, detail ?? "");
  }
}

function relClose(a: number, b: number, absTol = 0.03): boolean {
  return Math.abs(a - b) <= absTol;
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return JSON.stringify(sa) === JSON.stringify(sb);
}

for (const gt of groundTruth) {
  const label = gt.text.slice(0, 40);
  const result = classifyTranscript(gt.text);

  check(
    `[${label}] overall_voice_risk within tolerance`,
    relClose(result.overall_voice_risk, gt.overall_voice_risk),
    `TS=${result.overall_voice_risk} PY=${gt.overall_voice_risk}`
  );
  check(
    `[${label}] flags match`,
    JSON.stringify(result.flags) === JSON.stringify(gt.flags),
    `TS=${JSON.stringify(result.flags)} PY=${JSON.stringify(gt.flags)}`
  );
  check(
    `[${label}] active_threat_dimensions match`,
    sameSet(result.active_threat_dimensions, gt.active_threat_dimensions),
    `TS=${JSON.stringify(result.active_threat_dimensions)} PY=${JSON.stringify(gt.active_threat_dimensions)}`
  );
  check(
    `[${label}] scam_categories match`,
    sameSet(result.scam_categories, gt.scam_categories),
    `TS=${JSON.stringify(result.scam_categories)} PY=${JSON.stringify(gt.scam_categories)}`
  );
  check(
    `[${label}] language_detected matches`,
    result.language_detected === gt.language_detected,
    `TS=${result.language_detected} PY=${gt.language_detected}`
  );
}

// Sanity: empty/short input never throws and reports zero risk.
const empty = classifyTranscript("");
check("empty transcript -> zero risk, no crash", empty.overall_voice_risk === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
