/**
 * On-device port of ml/inference/fusion.py's RiskFusionEngine — kept in
 * exact numeric sync (same weights, same probabilistic saturation
 * formula, same rule table/scores, same single-signal override
 * thresholds, same LOW/MEDIUM/HIGH tier boundaries). This is what lets
 * "Analyze Payment Risk" compute a real fused decision on-device, offline,
 * instead of the previous two-boolean-verdict placeholder.
 *
 * Trust boundary (see payment-service.ts's evaluatePayment): this engine's
 * output is the PRIMARY, instant result shown to the user and is fully
 * usable offline. The real server evaluation (POST /api/v1/risk/evaluate)
 * still runs in parallel whenever reachable, and wins whenever it is the
 * MORE severe of the two — the phone can upgrade a payment to a higher
 * risk tier by reaching the server, but never downgrades a server-flagged
 * risk on its own. Voice/audio-spoof signals aren't available in the
 * payment-only context this fights in, so those two legs are always 0
 * here, same as the server's own evaluate_prepayment does when no voice
 * transcript is present.
 */

import { isRecurringMatch, RecurringCluster } from "./local-recurring-pattern";

export interface FusionFeatures {
  amountVsAvgRatio: number;
  amountZscore: number;
  newDevice: boolean;
  velocity10m: number;
  velocityRatio10m24h: number;
  rapidSuccessiveTransfer: boolean;
  isKnownPeriodicRecipient: boolean;
  amountDeviationFromRecurringBaseline: number;
}

export interface FusionSubScores {
  transactionFraud: number; // raw p_fraud model output, pre-scaling (matches server's sub_scores.transaction_fraud)
  behaviourAnomaly: number; // s_anomaly, 0-1
  deviceRisk: number; // r_device, 0-1
}

export interface ActiveRule {
  ruleId: string;
  severity: "high" | "medium";
  score: number;
  explanation: string;
}

export interface FusionResult {
  riskScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  decision: "ALLOW" | "WARN_CHOICE" | "CONFIRM_OR_CANCEL";
  subScores: {
    transaction_fraud: number;
    behaviour_anomaly: number;
    device_risk: number;
    voice_risk: number;
    rule_risk: number;
  };
  activeRules: ActiveRule[];
  recurringMatch: boolean;
}

export const FUSION_WEIGHTS = {
  transactionFraud: 0.35,
  behaviourAnomaly: 0.25,
  deviceRisk: 0.2,
  voiceRisk: 0.2,
};
const WEIGHTS = FUSION_WEIGHTS;

const LOW_MAX = 30;
const MEDIUM_MAX = 60;

interface RuleDefinition {
  ruleId: string;
  severity: "high" | "medium";
  score: number;
  condition: (f: FusionFeatures, recurringMatch: boolean) => boolean;
  explanation: string;
}

// Kept in the same order/scores as fusion.py's DEFAULT_FUSION_CONFIG.
// IMPOSSIBLE_TRAVEL_VELOCITY and VOICE_COERCION_FLAG are omitted: this
// context has no location tracking and no voice signal (see module
// docstring) — both would always evaluate false, so leaving them out is
// equivalent, not a silent gap.
const RULE_DEFINITIONS: RuleDefinition[] = [
  {
    ruleId: "NEW_DEVICE_HIGH_VALUE",
    severity: "high",
    score: 25,
    condition: (f, recurringMatch) => f.newDevice && f.amountVsAvgRatio >= 3.0 && !recurringMatch,
    explanation: "High-value payment initiated from an unrecognized device.",
  },
  {
    ruleId: "HIGH_AMOUNT_SPIKE",
    severity: "high",
    score: 35,
    condition: (f, recurringMatch) =>
      (f.amountVsAvgRatio >= 10.0 || f.amountZscore >= 6.0) && !recurringMatch,
    explanation: "Transaction amount is dramatically higher than habitual baseline (>10x average).",
  },
  {
    ruleId: "VELOCITY_BURST",
    severity: "medium",
    score: 15,
    condition: (f) => f.velocity10m >= 4 || f.velocityRatio10m24h >= 3.0,
    explanation: "High transaction frequency burst detected in recent activity.",
  },
  {
    ruleId: "RAPID_SUCCESSIVE_TRANSFER",
    severity: "medium",
    score: 15,
    condition: (f) => f.rapidSuccessiveTransfer,
    explanation: "Rapid successive transaction initiated within 60 seconds.",
  },
];

function evaluateRules(
  features: FusionFeatures,
  recurringMatch: boolean
): { rRule: number; activeRules: ActiveRule[] } {
  const activeRules: ActiveRule[] = [];
  let total = 0;
  for (const rule of RULE_DEFINITIONS) {
    try {
      if (rule.condition(features, recurringMatch)) {
        activeRules.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          score: rule.score,
          explanation: rule.explanation,
        });
        total += rule.score;
      }
    } catch {
      continue;
    }
  }
  return { rRule: Math.min(50, total) / 50, activeRules };
}

/**
 * @param cluster the recurring-pattern cluster for this recipient (from
 * detectRecurringPattern), or null if there's no recipient history at all.
 */
export function fuseSignals(
  features: FusionFeatures,
  subScores: FusionSubScores,
  cluster: RecurringCluster | null,
  currentAmount: number,
  currentTsMs: number
): FusionResult {
  const recurringMatch = cluster ? isRecurringMatch(cluster, currentAmount, currentTsMs) : false;

  const { rRule: rRuleRaw, activeRules } = evaluateRules(features, recurringMatch);
  let rRule = rRuleRaw;

  // p_fraud = min(1, raw * 2.5) — same rescale fusion.py applies before
  // fusing, since the raw model output alone under-weights true positives.
  let pFraud = Math.min(1.0, subScores.transactionFraud * 2.5);
  // s_anomaly is dampened by the CALLER before it reaches here (mirrors
  // predict.py dampening it pre-sub_scores) — see local risk pipeline.
  const sAnomaly = subScores.behaviourAnomaly;
  const rDevice = subScores.deviceRisk;
  const rVoice = 0; // no voice signal in the payment-only context.

  if (recurringMatch) {
    pFraud *= 0.15;
  }

  // Anti-double-counting: a new device already penalized heavily via
  // r_device shouldn't ALSO fully double-count through the rule engine.
  if (features.newDevice && rDevice > 0.6) {
    rRule *= 0.75;
  }

  const compFraud = 1.0 - WEIGHTS.transactionFraud * pFraud;
  const compAnomaly = 1.0 - WEIGHTS.behaviourAnomaly * sAnomaly;
  const compDevice = 1.0 - WEIGHTS.deviceRisk * rDevice;
  const compVoice = 1.0 - WEIGHTS.voiceRisk * rVoice;
  const compRule = 1.0 - 0.25 * rRule;

  const combinedSurvival = compFraud * compAnomaly * compDevice * compVoice * compRule;
  let fusedRiskFloat = 1.0 - combinedSurvival;

  const highThreatSignal = rVoice >= 0.6 || pFraud >= 0.75;
  const amountOrAnomalySignal =
    (features.amountVsAvgRatio >= 15.0 || sAnomaly >= 0.85) && !recurringMatch;

  if (highThreatSignal || amountOrAnomalySignal) {
    fusedRiskFloat = Math.max(fusedRiskFloat, 0.78);
  }

  const riskScore = Math.round(Math.min(100, fusedRiskFloat * 100));

  let riskLevel: FusionResult["riskLevel"];
  let decision: FusionResult["decision"];
  if (riskScore <= LOW_MAX) {
    riskLevel = "LOW";
    decision = "ALLOW";
  } else if (riskScore <= MEDIUM_MAX) {
    riskLevel = "MEDIUM";
    decision = "WARN_CHOICE";
  } else {
    riskLevel = "HIGH";
    decision = "CONFIRM_OR_CANCEL";
  }

  return {
    riskScore,
    riskLevel,
    decision,
    subScores: {
      transaction_fraud: Number(pFraud.toFixed(4)),
      behaviour_anomaly: Number(sAnomaly.toFixed(4)),
      device_risk: Number(rDevice.toFixed(4)),
      voice_risk: 0,
      rule_risk: Number(rRule.toFixed(4)),
    },
    activeRules,
    recurringMatch,
  };
}
