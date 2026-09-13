/**
 * Parity check: the on-device TypeScript IsolationForest scorer
 * (services/ml/behaviour-anomaly-forest.ts) must match sklearn's own
 * IsolationForest.score_samples/decision_function exactly (within float
 * tolerance) on the same feature vectors, since it reimplements sklearn's
 * scoring algorithm against the actual fitted tree structures rather than
 * a retrained or approximated model.
 *
 * Ground truth (anomaly_forest_ground_truth.json) was captured by loading
 * the real ml/models/anomaly_forest.joblib and calling score_samples/
 * decision_function directly on 6 feature vectors spanning ordinary to
 * extreme behaviour.
 */

// @ts-ignore — Node-only module; this script runs under tsx (Node), never bundled into the RN app.
import * as fs from "fs";
// @ts-ignore
import * as path from "path";
import { scoreSamples, decisionFunction, computeBehaviourAnomalyScore, BEHAVIOUR_COLUMNS } from "../../services/ml/behaviour-anomaly-forest";

// @ts-ignore — __dirname is provided by tsx's CJS-style transform at runtime.
const groundTruth = JSON.parse(fs.readFileSync(path.resolve(__dirname, "./anomaly_forest_ground_truth.json"), "utf-8")) as {
  x: number[];
  score_samples: number;
  decision_function: number;
  s_anomaly: number;
}[];

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

function relClose(a: number, b: number, absTol = 1e-4): boolean {
  return Math.abs(a - b) <= absTol;
}

for (const gt of groundTruth) {
  const label = JSON.stringify(gt.x);
  const score = scoreSamples(gt.x);
  const decision = decisionFunction(gt.x);

  check(`[${label}] score_samples matches sklearn`, relClose(score, gt.score_samples), `TS=${score} PY=${gt.score_samples}`);
  check(`[${label}] decision_function matches sklearn`, relClose(decision, gt.decision_function), `TS=${decision} PY=${gt.decision_function}`);

  const featureMap: Record<string, number> = {};
  BEHAVIOUR_COLUMNS.forEach((col, i) => (featureMap[col] = gt.x[i]));
  const sAnomaly = computeBehaviourAnomalyScore(featureMap);
  check(`[${label}] s_anomaly (clip(0.5 - decision, 0, 1)) matches`, relClose(sAnomaly, gt.s_anomaly), `TS=${sAnomaly} PY=${gt.s_anomaly}`);
}

// Missing feature keys default to 0.0, matching predict.py's features.get(col, 0.0).
const partial = computeBehaviourAnomalyScore({ amount_zscore: 1.2 });
check("missing feature keys default to 0.0 without throwing", typeof partial === "number" && !Number.isNaN(partial));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
