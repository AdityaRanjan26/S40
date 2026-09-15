/**
 * On-device port of ml/profiles/recurring_pattern.py — kept in exact
 * numeric/logical sync with the server module (same constants, same two
 * establishment paths, same is_recurring_match gate). See that file's own
 * docstring for the full rationale; this comment only covers what's
 * specific to running it on the phone.
 *
 * Runs against THIS DEVICE's locally cached transaction history to one
 * recipient, plus a locally-tracked confirmation counter (see
 * `recordLocalConfirmation` below) — not the server's full cross-device
 * recipient ledger. A recipient paid from a different install/session
 * before this one won't be recognized as recurring on-device until the
 * server's own evaluation (still called alongside this one — see
 * payment-service.ts's evaluatePayment) catches up. Documented
 * approximation, same category as recipient-risk-service.ts's.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { UserTransaction } from "../payment-service";

export enum CadenceType {
  NONE = "NONE",
  WEEKLY = "WEEKLY",
  BIWEEKLY = "BIWEEKLY",
  MONTHLY = "MONTHLY",
}

// Kept byte-for-byte in sync with recurring_pattern.py's constants.
const CADENCE_INTERVALS: Record<CadenceType, [number, number] | null> = {
  [CadenceType.WEEKLY]: [7, 2],
  [CadenceType.BIWEEKLY]: [14, 3],
  [CadenceType.MONTHLY]: [30, 4],
  [CadenceType.NONE]: null,
};

export const AMOUNT_TOLERANCE_PCT = 0.1;
export const MIN_OCCURRENCES_FOR_CADENCE = 3;
export const MIN_CONFIRMATIONS_FOR_TRUST = 2;

const CONFIRMATIONS_STORAGE_KEY = "avaran.local_recipient_confirmations.v1";

export interface RecurringCluster {
  cadenceType: CadenceType;
  expectedIntervalDays: number | null;
  occurrences: number;
  clusterMeanAmount: number | null;
  confirmationsCount: number;
  isEstablished: boolean;
  lastTxnTimestampMs: number | null;
}

function classifyCadence(intervalDays: number | null): CadenceType {
  if (intervalDays === null || intervalDays <= 0) return CadenceType.NONE;
  let best = CadenceType.NONE;
  let bestDelta = Infinity;
  for (const cadence of [CadenceType.WEEKLY, CadenceType.BIWEEKLY, CadenceType.MONTHLY]) {
    const interval = CADENCE_INTERVALS[cadence];
    if (!interval) continue;
    const [expected, tolerance] = interval;
    const delta = Math.abs(intervalDays - expected);
    if (delta <= tolerance && delta < bestDelta) {
      best = cadence;
      bestDelta = delta;
    }
  }
  return best;
}

export function cadenceToleranceDays(cadenceType: CadenceType): number {
  const interval = CADENCE_INTERVALS[cadenceType];
  return interval ? interval[1] : 0;
}

/** Never throws, never returns NaN — degrades to "not established" on any
 * sparse/malformed input, same invariant as the server module. */
export function detectRecurringPattern(
  historyForRecipient: UserTransaction[],
  confirmationsCount: number
): RecurringCluster {
  const confirmations = Math.max(0, Math.floor(confirmationsCount || 0));

  const clean = historyForRecipient
    .map((t) => ({ amount: Number(t.amount), tsMs: new Date(t.timestamp).getTime() }))
    .filter((t) => Number.isFinite(t.amount) && t.amount > 0 && Number.isFinite(t.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);

  if (clean.length < 2) {
    return {
      cadenceType: CadenceType.NONE,
      expectedIntervalDays: null,
      occurrences: clean.length,
      clusterMeanAmount: clean.length ? clean[clean.length - 1].amount : null,
      confirmationsCount: confirmations,
      isEstablished: confirmations >= MIN_CONFIRMATIONS_FOR_TRUST,
      lastTxnTimestampMs: clean.length ? clean[clean.length - 1].tsMs : null,
    };
  }

  const intervalsDays: number[] = [];
  for (let i = 1; i < clean.length; i++) {
    intervalsDays.push((clean[i].tsMs - clean[i - 1].tsMs) / 86_400_000);
  }

  const counts = new Map<CadenceType, number>();
  for (const d of intervalsDays) {
    const c = classifyCadence(d);
    if (c !== CadenceType.NONE) counts.set(c, (counts.get(c) || 0) + 1);
  }

  let cadenceType = CadenceType.NONE;
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount) {
      cadenceType = c;
      bestCount = n;
    }
  }

  const amounts = clean.map((c) => c.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const expectedInterval = CADENCE_INTERVALS[cadenceType]?.[0] ?? null;
  const occurrences = clean.length;

  const amountConsistent =
    mean > 0 ? amounts.every((a) => Math.abs(a - mean) / mean <= AMOUNT_TOLERANCE_PCT) : true;

  const cadenceEstablished =
    cadenceType !== CadenceType.NONE && occurrences >= MIN_OCCURRENCES_FOR_CADENCE && amountConsistent;
  const confirmationEstablished =
    confirmations >= MIN_CONFIRMATIONS_FOR_TRUST || (occurrences >= 2 && confirmations >= 1);

  return {
    cadenceType,
    expectedIntervalDays: expectedInterval,
    occurrences,
    clusterMeanAmount: mean,
    confirmationsCount: confirmations,
    isEstablished: cadenceEstablished || confirmationEstablished,
    lastTxnTimestampMs: clean[clean.length - 1].tsMs,
  };
}

/** The single shared gate — mirrors recurring_pattern.py::is_recurring_match
 * exactly, including the "no cadence yet, but confirmation-established"
 * path skipping the cadence-delta check entirely (see that function's
 * comment for why: there is no detected schedule to be "on" in that case). */
export function isRecurringMatch(
  cluster: RecurringCluster,
  currentAmount: number,
  currentTsMs: number
): boolean {
  if (!cluster.isEstablished) return false;

  if (cluster.cadenceType !== CadenceType.NONE) {
    const tolerance = cadenceToleranceDays(cluster.cadenceType);
    if (tolerance <= 0 || cluster.expectedIntervalDays === null || cluster.lastTxnTimestampMs === null) {
      return false;
    }
    const daysSince = Math.abs(currentTsMs - cluster.lastTxnTimestampMs) / 86_400_000;
    const delta = Math.abs(daysSince - cluster.expectedIntervalDays);
    if (delta > tolerance) return false;
  }

  if (cluster.clusterMeanAmount === null || cluster.clusterMeanAmount <= 0) return false;
  const amountDeviation = Math.abs(currentAmount - cluster.clusterMeanAmount) / cluster.clusterMeanAmount;
  return amountDeviation <= AMOUNT_TOLERANCE_PCT;
}

/** Local counterpart to payment_lifecycle_service.py::confirm()'s
 * UserFeedback(CONFIRM) write — increments a per-recipient counter cached
 * on-device so the confirmation fast-path works even before the server's
 * own count has been fetched. Best-effort: swallows storage errors since
 * this is advisory-only bookkeeping, never a blocking operation. */
export async function recordLocalConfirmation(recipientKey: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CONFIRMATIONS_STORAGE_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    map[recipientKey] = (map[recipientKey] || 0) + 1;
    await AsyncStorage.setItem(CONFIRMATIONS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Advisory bookkeeping only — never let a storage failure block confirm.
  }
}

export async function getLocalConfirmationCount(recipientKey: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(CONFIRMATIONS_STORAGE_KEY);
    if (!raw) return 0;
    const map: Record<string, number> = JSON.parse(raw);
    return map[recipientKey] || 0;
  } catch {
    return 0;
  }
}
