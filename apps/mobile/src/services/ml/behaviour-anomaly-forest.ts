/**
 * On-device port of the LIVE behaviour-anomaly signal used by
 * ml/inference/predict.py (the real /risk/evaluate path) — NOT the more
 * elaborate but unused ml/inference/anomaly.py / BehaviourAnomalyDetector
 * (that one is registered under a different model path and is never
 * actually loaded by the live risk fusion; checked directly). The live
 * path loads ml/models/anomaly_forest.joblib (a plain sklearn
 * IsolationForest, 100 trees, 6 numeric features — no text/tokenization,
 * so unlike the voice NLP model there was no ONNX contrib-op concern
 * here) and computes:
 *   raw_score = forest.decision_function([features])[0]
 *   s_anomaly = clip(0.5 - raw_score, 0, 1)
 *
 * This file reimplements sklearn's IsolationForest scoring math exactly
 * (average path length per tree, the c(n) correction for leaf sample
 * count, the 2**(-depth/denom) transform, and the offset_ subtraction)
 * against the actual fitted tree structures — extracted once via
 * apps/mobile/assets/anomaly/behaviour_anomaly_forest.json, not
 * retrained or approximated. Verified against sklearn's own
 * decision_function() on the same feature vectors — see
 * behaviour-anomaly-parity.regression.ts.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const forestData = require("../../../assets/anomaly/behaviour_anomaly_forest.json") as {
  featureOrder: string[];
  nEstimators: number;
  maxSamples: number;
  offset: number;
  trees: {
    childrenLeft: number[];
    childrenRight: number[];
    feature: number[];
    threshold: number[];
    nNodeSamples: number[];
  }[];
};

export const BEHAVIOUR_COLUMNS = forestData.featureOrder;

const EULER_GAMMA = 0.5772156649015329;

/** sklearn's average path length of an unsuccessful BST search of n items. */
function averagePathLength(n: number): number {
  if (n <= 1) return 0.0;
  if (n === 2) return 1.0;
  return 2.0 * (Math.log(n - 1.0) + EULER_GAMMA) - (2.0 * (n - 1.0)) / n;
}

function computeDepths(childrenLeft: number[], childrenRight: number[]): number[] {
  const depths = new Array(childrenLeft.length).fill(0);
  const stack: [number, number][] = [[0, 1]];
  while (stack.length > 0) {
    const [node, d] = stack.pop()!;
    depths[node] = d;
    if (childrenLeft[node] !== -1) {
      stack.push([childrenLeft[node], d + 1]);
      stack.push([childrenRight[node], d + 1]);
    }
  }
  return depths;
}

// Depths depend only on tree structure, computed once per tree at module load.
const treeDepths: number[][] = forestData.trees.map((t) => computeDepths(t.childrenLeft, t.childrenRight));

function pathLengthForSample(treeIdx: number, x: number[]): number {
  const tree = forestData.trees[treeIdx];
  const depths = treeDepths[treeIdx];
  let node = 0;
  while (tree.childrenLeft[node] !== -1) {
    const f = tree.feature[node];
    node = x[f] <= tree.threshold[node] ? tree.childrenLeft[node] : tree.childrenRight[node];
  }
  return depths[node] + averagePathLength(tree.nNodeSamples[node]) - 1.0;
}

/** Matches sklearn's IsolationForest.score_samples([x])[0]. */
export function scoreSamples(x: number[]): number {
  let totalDepth = 0;
  for (let i = 0; i < forestData.trees.length; i++) {
    totalDepth += pathLengthForSample(i, x);
  }
  const denom = forestData.nEstimators * averagePathLength(forestData.maxSamples);
  const normalizedScore = denom !== 0 ? Math.pow(2, -totalDepth / denom) : 1;
  return -normalizedScore;
}

/** Matches sklearn's IsolationForest.decision_function([x])[0]. */
export function decisionFunction(x: number[]): number {
  return scoreSamples(x) - forestData.offset;
}

/**
 * Matches ml/inference/predict.py's on-device-relevant slice exactly:
 * s_anomaly = clip(0.5 - decision_function, 0, 1). `features` should
 * already be keyed by BEHAVIOUR_COLUMNS names; missing keys default to
 * 0.0, matching predict.py's `features.get(col, 0.0)`.
 */
export function computeBehaviourAnomalyScore(features: Record<string, number>): number {
  const x = BEHAVIOUR_COLUMNS.map((col) => features[col] ?? 0.0);
  const raw = decisionFunction(x);
  return Math.min(1.0, Math.max(0.0, 0.5 - raw));
}
