/**
 * On-device port of ml/features/device_features.py's device_risk heuristic
 * (ml/inference/predict.py's r_device):
 *   r_device = min(1, 0.1 + 0.45*new_device + 0.40*(impossible_travel>800) + 0.15*(account_count>2))
 *
 * `new_device`/`device_account_count` need to know whether THIS device is
 * already registered to the user — data that only exists in the server's
 * Device table (hashed with a server-only pepper, see
 * app/core/security.py::hash_identifier). The client cannot compute that
 * hash itself, so this asks the server a yes/no + count question
 * (GET /api/v1/users/{id}/device-check) instead of ever handling a raw or
 * full device hash — see that endpoint's own docstring.
 *
 * The result is cached locally (AsyncStorage) so device_risk is still
 * computable fully offline after the first successful sync of a session;
 * a stale cache just means "new_device" reflects the last time this app
 * could reach the network, a documented approximation, not a silent gap.
 *
 * impossible_travel_speed_kmh is NOT computable on-device at all (no
 * location dependency in this app — same documented limitation as
 * behaviour-anomaly-service.ts) and always contributes 0, exactly like
 * the server does when that signal is unavailable.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { ApiClient } from "../api-client";
import { getDeviceIdentifier } from "../device-info-service";

const CACHE_KEY_PREFIX = "avaran.local_device_check.v1.";

interface DeviceCheckCache {
  knownDevice: boolean;
  deviceCount: number;
  syncedAtMs: number;
}

export interface LocalDeviceRiskEstimate {
  deviceRisk: number;
  newDevice: boolean;
  deviceAccountCount: number;
  fromCache: boolean;
}

async function readCache(userId: number): Promise<DeviceCheckCache | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeCache(userId: number, cache: DeviceCheckCache): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY_PREFIX + userId, JSON.stringify(cache));
  } catch {
    // Best-effort cache only.
  }
}

/** Refreshes the local known-device cache from the server. Call this
 * opportunistically (e.g. on app foreground / login, same spirit as
 * UserPatternService.sync()) — never required before scoring, since
 * estimateDeviceRiskLocally falls back to the last cached value or a
 * conservative "treat as new" default when nothing has synced yet. */
export async function syncDeviceCheck(userId: number): Promise<void> {
  try {
    const deviceId = await getDeviceIdentifier();
    const res = await ApiClient.get<{ known_device: boolean; device_count: number }>(
      `/api/v1/users/${userId}/device-check?device_identifier=${encodeURIComponent(deviceId)}`
    );
    if (res.data) {
      await writeCache(userId, {
        knownDevice: Boolean(res.data.known_device),
        deviceCount: Number(res.data.device_count) || 0,
        syncedAtMs: Date.now(),
      });
    }
  } catch {
    // Offline or server unreachable — keep whatever is cached, if anything.
  }
}

/** Synchronous-feeling (no network call) device_risk estimate, reading
 * only the local cache — safe to call from the hot evaluation path.
 * Conservative default (`newDevice: true`) when nothing has ever synced,
 * since "assume unfamiliar" is the safer failure mode for a risk signal. */
export async function estimateDeviceRiskLocally(userId: number): Promise<LocalDeviceRiskEstimate> {
  const cache = await readCache(userId);

  const newDevice = cache ? !cache.knownDevice : true;
  const deviceAccountCount = cache ? cache.deviceCount : 0;

  // impossible_travel_speed_kmh always 0 — see module docstring.
  let risk = 0.1;
  if (newDevice) risk += 0.45;
  if (deviceAccountCount > 2) risk += 0.15;
  risk = Math.min(1.0, risk);

  return {
    deviceRisk: risk,
    newDevice,
    deviceAccountCount,
    fromCache: cache !== null,
  };
}
