/**
 * ADVISORY-ONLY, OFFLINE-FALLBACK local behaviour-anomaly scoring —
 * on-device counterpart to ml/inference/predict.py's live IsolationForest
 * signal (`s_anomaly`), same doctrine as recipient-risk-service.ts: never
 * authoritative, never gates/blocks, only shown when there's no network.
 *
 * FEATURE APPROXIMATION, stated plainly (same category of approximation
 * already documented in recipient-risk-service.ts):
 * - amount_zscore / amount_vs_avg_ratio / velocity_10m / recipient_novelty
 *   are derived from THIS device's own cached transaction history to this
 *   recipient, not the cross-user population statistics the server-side
 *   model actually trained on.
 * - location_distance_km and impossible_travel_speed_kmh are NOT
 *   computable on-device at all — this app has no location-tracking
 *   dependency (checked directly: no expo-location or equivalent). Both
 *   default to 0.0, which is exactly what ml/inference/predict.py itself
 *   does when these signals are unavailable (`features.get(col, 0.0)`),
 *   not a fabricated value invented here.
 */

import { computeBehaviourAnomalyScore } from "./ml/behaviour-anomaly-forest";
// Type-only import: erased at compile time, avoids a runtime circular
// require with payment-service.ts (which imports this module).
import type { UserTransaction } from "./payment-service";

const MIN_HISTORY = 5;

export interface LocalAnomalyEstimate {
  anomalyScore: number;
  elevated: boolean;
  scorable: boolean;
  source: "local-isolation-forest-advisory";
}

/** Threshold mirrors the live server's own tier boundary for this signal
 * (s_anomaly feeding a HIGH-risk fusion tier) — not independently invented. */
const ELEVATED_THRESHOLD = 0.6;

export function estimateBehaviourAnomalyLocally(
  amount: number,
  recipientMerchant: string,
  history: UserTransaction[]
): LocalAnomalyEstimate {
  const now = Date.now();
  const priorToRecipient = history
    .filter((t) => t.merchant === recipientMerchant)
    .map((t) => ({ amount: t.amount, timestampMs: new Date(t.timestamp).getTime() }))
    .filter((t) => t.timestampMs < now);

  const count = priorToRecipient.length;
  const amounts = priorToRecipient.map((t) => t.amount);

  let amountZscore = 0;
  let amountVsAvgRatio = 1;
  const scorable = count >= MIN_HISTORY;

  if (scorable) {
    const mean = amounts.reduce((a, b) => a + b, 0) / count;
    const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / count;
    const std = Math.sqrt(variance);
    amountVsAvgRatio = mean > 1e-9 ? amount / mean : 1;
    amountZscore = std > 1e-9 ? (amount - mean) / std : 0;
  }

  const velocity10m = priorToRecipient.filter((t) => (now - t.timestampMs) / 1000 <= 600).length;
  const recipientNovelty = count === 0 ? 1 : 0;

  const anomalyScore = computeBehaviourAnomalyScore({
    amount_zscore: amountZscore,
    amount_vs_avg_ratio: amountVsAvgRatio,
    velocity_10m: velocity10m,
    recipient_novelty: recipientNovelty,
    location_distance_km: 0.0,
    impossible_travel_speed_kmh: 0.0,
  });

  return {
    anomalyScore,
    elevated: anomalyScore > ELEVATED_THRESHOLD,
    scorable,
    source: "local-isolation-forest-advisory",
  };
}
