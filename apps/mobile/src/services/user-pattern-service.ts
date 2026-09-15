/**
 * ADVISORY-ONLY, on-device sync + prediction for the personalized
 * transaction-pattern engine (apps/api/app/services/user_pattern_trainer.py
 * trains server-side; this file only downloads the resulting artifact and
 * runs it locally). Modeled directly on the existing, already-shipped
 * recipient-risk-service.ts: same onnxruntime-react-native usage, same
 * "return null on any failure, never throw" contract, same documented
 * advisory-only boundary.
 *
 * THIS IS NOT AN AUTHORITATIVE RISK SIGNAL. RiskService.evaluateTransaction
 * (POST /api/v1/risk/evaluate) remains the ONLY authoritative source of
 * truth — this repo's own doctrine (risk-service.ts: "No client-side risk
 * heuristics") applies here exactly as it does to the recipient model. This
 * service must never gate, block, or silently substitute for the real risk
 * call; nothing in this codebase currently reads its output.
 *
 * TWO ARTIFACT SHAPES (mirrors ml/training/train_user_pattern.py):
 * - "onnx": a micro IsolationForest, run via onnxruntime-react-native.
 *   `elevatedThreshold` in the artifact metadata is bundled specifically
 *   for THIS model — never compare its raw score against any other
 *   model's output or threshold (see the training module's own scale-gap
 *   note, same pattern as recipient-risk-service.ts's SCALE WARNING).
 * - "quantile-json": a cold-start user (<30 transactions) — no model, just
 *   the three shrunk percentiles from the server, compared arithmetically.
 *
 * PERSISTENCE: only the small checksum/kind/quantile values are persisted
 * (via expo-secure-store — already a dependency, used the same way by
 * biometric-service.ts/device-info-service.ts). The ONNX bytes themselves
 * are kept in memory only, re-fetched once per app cold start rather than
 * written to local file storage — a deliberate leanness trade-off (no new
 * expo-file-system dependency for a <150KB advisory-only artifact).
 *
 * REQUIRES A NATIVE BUILD: onnxruntime-react-native ships native code and
 * does not run under Expo Go, exactly like recipient-risk-service.ts
 * already documents. Not verified on a physical device in this change —
 * verify manually before relying on it.
 */

import { AppState, AppStateStatus } from "react-native";
import * as SecureStore from "expo-secure-store";
import { InferenceSession, Tensor } from "onnxruntime-react-native";
import { getApiBaseUrl, getAuthToken } from "./api-client";

const CACHE_KEY_PREFIX = "avaran_user_pattern_cache_v1_";

interface CachedSync {
  checksum: string;
  kind: "onnx" | "quantile-json";
  version: string;
  // Populated for kind="quantile-json" — compared arithmetically, no
  // ML runtime needed. For kind="onnx" these are the training-time
  // baseline (used only to compute the amount_zscore feature the model
  // itself was trained on — see train_user_pattern.py's feature list).
  p50: number;
  p90: number;
  p99: number;
  shrunkMean: number;
  shrunkStd: number;
  elevatedThreshold?: number;
}

export interface LocalPatternEstimate {
  elevated: boolean;
  source: "local-user-pattern-onnx" | "local-user-pattern-quantile";
  detail: string; // human-readable, e.g. "3.1x your usual amount" — advisory display only
}

let onnxSessionCache: { checksum: string; session: InferenceSession } | null = null;

function cacheKey(userId: number): string {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

async function readCache(userId: number): Promise<CachedSync | null> {
  try {
    const raw = await SecureStore.getItemAsync(cacheKey(userId));
    return raw ? (JSON.parse(raw) as CachedSync) : null;
  } catch {
    return null;
  }
}

async function writeCache(userId: number, cached: CachedSync): Promise<void> {
  try {
    await SecureStore.setItemAsync(cacheKey(userId), JSON.stringify(cached));
  } catch {
    // Best-effort — a failed cache write just means the next sync
    // re-downloads instead of getting a 304. Never surface this.
  }
}

export class UserPatternService {
  /**
   * Calls GET /model-sync with the cached checksum as If-None-Match.
   * 304 -> no-op (already current). 200 -> downloads the new artifact
   * (ONNX bytes into memory, or just the quantile numbers) and updates
   * the cache. Never throws — a sync failure just means predictions keep
   * using whatever was cached before (or return null if nothing was ever
   * cached).
   */
  static async sync(userId: number): Promise<void> {
    try {
      const cached = await readCache(userId);
      const baseUrl = getApiBaseUrl();
      const token = getAuthToken();

      const syncRes = await fetch(`${baseUrl}/api/v1/users/${userId}/model-sync`, {
        headers: {
          ...(cached ? { "If-None-Match": `"${cached.checksum}"` } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (syncRes.status === 304) {
        return; // already current
      }
      if (!syncRes.ok) {
        return;
      }

      const payload = await syncRes.json();
      if (!payload.has_model) {
        return;
      }

      // The sync response already embeds baseline percentiles (and, for
      // an onnx artifact, the bundled elevated-score threshold) — see
      // financial_profile.py's model_sync — so only the artifact file
      // itself (.onnx bytes, or the quantile .json, which is redundant
      // with the fields already on `payload` but fetched for consistency)
      // needs a second request, and only when the checksum changed.
      const baseCache = {
        checksum: payload.sha256_checksum as string,
        version: payload.latest_version as string,
        p50: payload.p50 ?? 0,
        p90: payload.p90 ?? 0,
        p99: payload.p99 ?? 0,
        shrunkMean: payload.shrunk_mean ?? 0,
        shrunkStd: payload.shrunk_std ?? 1,
      };

      if (payload.kind === "quantile-json") {
        await writeCache(userId, { ...baseCache, kind: "quantile-json" });
      } else if (payload.kind === "onnx") {
        const artifactRes = await fetch(`${baseUrl}${payload.download_url}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!artifactRes.ok) {
          return;
        }
        const buffer = await artifactRes.arrayBuffer();
        const session = await InferenceSession.create(new Uint8Array(buffer));
        onnxSessionCache = { checksum: payload.sha256_checksum, session };
        await writeCache(userId, {
          ...baseCache,
          kind: "onnx",
          elevatedThreshold: payload.elevated_threshold,
        });
      }
    } catch {
      // Network unavailable, malformed response, native module missing —
      // this is a background sync, never surfaced as an error.
    }
  }

  /**
   * Raw cached baseline (p50/p90/p99, shrunkMean/shrunkStd) synced from
   * this user's REAL server-trained profile — built from their uploaded
   * bank statement / accumulated confirmed transactions
   * (user_pattern_trainer.py), not this device's own local cache. This is
   * the on-device counterpart to risk_service.py's
   * `user_profile["normal_avg_amount"/"normal_std_amount"]` wiring, and
   * is what makes a first-ever local payment personalized instead of
   * scored against a generic default — see local-fusion-engine.ts's
   * caller for exactly how it's used. Returns null if nothing has ever
   * synced for this user (brand new account, statement not yet uploaded).
   */
  static async getCachedBaseline(
    userId: number
  ): Promise<{ p50: number; p90: number; shrunkMean: number; shrunkStd: number } | null> {
    const cached = await readCache(userId);
    if (!cached || (cached.p50 <= 0 && cached.shrunkMean <= 0)) return null;
    return {
      p50: cached.p50,
      p90: cached.p90,
      shrunkMean: cached.shrunkMean,
      shrunkStd: cached.shrunkStd,
    };
  }

  /** Best-effort, offline-safe local estimate for `amount`. Returns null
   * if nothing has ever synced, or on any failure — callers must treat
   * this as optional, never required (same contract as
   * RecipientRiskService.estimateLocally). */
  static async estimateLocally(userId: number, amount: number): Promise<LocalPatternEstimate | null> {
    try {
      const cached = await readCache(userId);
      if (!cached) return null;

      if (cached.kind === "quantile-json") {
        const elevated = amount > cached.p99;
        const ratio = cached.p50 > 0 ? amount / cached.p50 : 0;
        return {
          elevated,
          source: "local-user-pattern-quantile",
          detail: `${ratio.toFixed(1)}x your typical amount (₹${cached.p50.toFixed(0)})`,
        };
      }

      if (cached.kind === "onnx" && cached.elevatedThreshold !== undefined) {
        if (!onnxSessionCache || onnxSessionCache.checksum !== cached.checksum) {
          return null; // session not (yet) loaded for this cached version — next sync() will fix it
        }
        const hour = new Date().getHours();
        const zscore = (amount - cached.shrunkMean) / cached.shrunkStd;
        const hourSin = Math.sin((2 * Math.PI * hour) / 24);
        const tensor = new Tensor("float32", Float32Array.from([amount, zscore, hourSin]), [1, 3]);
        const results = await onnxSessionCache.session.run({ input: tensor });
        const outputNames = Object.keys(results);
        const score = Number(results[outputNames[outputNames.length - 1]].data[0]);
        // Lower score = more anomalous — verified directly against this
        // model's own training-time scores in train_user_pattern.py; see
        // that module's threshold-computation comment.
        const elevated = score <= cached.elevatedThreshold;
        const ratio = cached.shrunkMean > 0 ? amount / cached.shrunkMean : 0;
        return {
          elevated,
          source: "local-user-pattern-onnx",
          detail: `${ratio.toFixed(1)}x your typical amount (₹${cached.shrunkMean.toFixed(0)})`,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /** Starts a listener that calls sync() whenever the app is foregrounded.
   * Not wired into any screen by default — call this once (e.g. from a
   * root-level effect) with the signed-in user's id, matching the
   * "evaluated when an active user opens the app" trigger described for
   * this engine. Returns an unsubscribe function. */
  static registerForegroundSync(userId: number): () => void {
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (previous !== "active" && next === "active") {
        void UserPatternService.sync(userId);
      }
      previous = next;
    });
    void UserPatternService.sync(userId); // also sync immediately on registration
    return () => subscription.remove();
  }
}
