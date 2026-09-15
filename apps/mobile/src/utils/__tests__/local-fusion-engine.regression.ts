/**
 * Sanity/regression checks for the on-device fusion engine
 * (services/ml/local-fusion-engine.ts) and recurring-pattern port
 * (services/ml/local-recurring-pattern.ts) — not a byte-for-byte parity
 * harness against fusion.py (that would need a Python-side ground-truth
 * export the way behaviour-anomaly-parity.regression.ts has), but verifies
 * the ported formula/rule table/tier boundaries behave the way the server
 * module's own docstring and tests say they should for the same scenarios
 * ml/tests/test_recurring_pattern.py and tests/test_fusion.py exercise.
 */

import { fuseSignals, FusionFeatures, FusionSubScores } from "../../services/ml/local-fusion-engine";
import {
  detectRecurringPattern,
  isRecurringMatch,
  CadenceType,
} from "../../services/ml/local-recurring-pattern";
import type { UserTransaction } from "../../services/payment-service";

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

function tx(amount: number, isoTimestamp: string): UserTransaction {
  return { merchant: "recipient", amount, timestamp: isoTimestamp } as UserTransaction;
}

const NEUTRAL_FEATURES: FusionFeatures = {
  amountVsAvgRatio: 1,
  amountZscore: 0,
  newDevice: false,
  velocity10m: 0,
  velocityRatio10m24h: 0,
  rapidSuccessiveTransfer: false,
  isKnownPeriodicRecipient: false,
  amountDeviationFromRecurringBaseline: 1,
};

// --- fuseSignals: low-risk baseline stays LOW -------------------------
{
  const subScores: FusionSubScores = { transactionFraud: 0.05, behaviourAnomaly: 0.05, deviceRisk: 0.0 };
  const result = fuseSignals(NEUTRAL_FEATURES, subScores, null, 100, Date.now());
  check("low signals across the board -> LOW", result.riskLevel === "LOW", `score=${result.riskScore}`);
}

// --- fuseSignals: high fraud probability floors to HIGH via override --
{
  const subScores: FusionSubScores = { transactionFraud: 0.9, behaviourAnomaly: 0.05, deviceRisk: 0.1 };
  const result = fuseSignals(NEUTRAL_FEATURES, subScores, null, 100, Date.now());
  check(
    "high p_fraud (>=0.75 after *2.5 scaling) floors to HIGH",
    result.riskLevel === "HIGH" && result.riskScore >= 78,
    `score=${result.riskScore}`
  );
}

// --- fuseSignals: new device + amount spike triggers rule engine ------
{
  const features: FusionFeatures = { ...NEUTRAL_FEATURES, newDevice: true, amountVsAvgRatio: 5 };
  const subScores: FusionSubScores = { transactionFraud: 0.1, behaviourAnomaly: 0.1, deviceRisk: 0.55 };
  const result = fuseSignals(features, subScores, null, 5000, Date.now());
  check(
    "NEW_DEVICE_HIGH_VALUE rule fires for new device + amount ratio >= 3",
    result.activeRules.some((r) => r.ruleId === "NEW_DEVICE_HIGH_VALUE"),
    JSON.stringify(result.activeRules)
  );
}

// --- recurring pattern: 3 monthly occurrences establish cadence -------
{
  const base = new Date("2026-01-01T09:00:00Z").getTime();
  const day = 86_400_000;
  const history = [
    tx(5000, new Date(base).toISOString()),
    tx(5000, new Date(base + 30 * day).toISOString()),
    tx(5000, new Date(base + 61 * day).toISOString()),
  ];
  const cluster = detectRecurringPattern(history, 0);
  check("3 monthly occurrences establish cadence", cluster.isEstablished, JSON.stringify(cluster));
  check("cadence classified as MONTHLY", cluster.cadenceType === CadenceType.MONTHLY);

  const month3Ts = base + 61 * day + 30 * day;
  const matches = isRecurringMatch(cluster, 5000, month3Ts);
  check("4th on-schedule, same-amount payment matches", matches);

  const spikeMatches = isRecurringMatch(cluster, 25000, month3Ts);
  check("5x spike to the same recipient does NOT match", !spikeMatches);
}

// --- recurring pattern: confirmation fast-path without a real cadence -
{
  const now = Date.now();
  const history = [tx(50, new Date(now).toISOString()), tx(50, new Date(now).toISOString())];
  const cluster = detectRecurringPattern(history, 2);
  check(
    "2 confirmations establish trust even with no real cadence",
    cluster.isEstablished && cluster.cadenceType === CadenceType.NONE,
    JSON.stringify(cluster)
  );
  check("confirmation-only match works without a cadence check", isRecurringMatch(cluster, 50, now));
}

// --- fuseSignals end-to-end: recurring match dampens what would
// otherwise floor to HIGH via the amount-ratio override -----------------
{
  const base = new Date("2026-01-01T09:00:00Z").getTime();
  const day = 86_400_000;
  const history = [
    tx(5000, new Date(base).toISOString()),
    tx(5000, new Date(base + 30 * day).toISOString()),
    tx(5000, new Date(base + 61 * day).toISOString()),
  ];
  const cluster = detectRecurringPattern(history, 2);
  const month4Ts = base + 61 * day + 30 * day;

  const features: FusionFeatures = { ...NEUTRAL_FEATURES, amountVsAvgRatio: 20 };
  const subScores: FusionSubScores = { transactionFraud: 0.1, behaviourAnomaly: 0.05, deviceRisk: 0.1 };
  const result = fuseSignals(features, subScores, cluster, 5000, month4Ts);
  check(
    "recognized recurring payment does not floor to HIGH despite amountVsAvgRatio=20",
    result.riskLevel !== "HIGH",
    `score=${result.riskScore}`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
