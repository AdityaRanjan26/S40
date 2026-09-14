import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";

const DEVICE_ID_KEY = "avaran.device_identifier.v1";

let _cachedDeviceId: string | null = null;

const generateCryptoUuid = (): string => {
  // Cryptographically secure random UUID v4 without relying on hardware identifiers (no IMEI/IMSI/MAC/SIM)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10xx
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * A stable per-install random device identifier, persisted in SecureStore.
 * Generates an installation UUID on first install and persists it securely.
 */
export const getDeviceIdentifier = async (): Promise<string> => {
  if (_cachedDeviceId) return _cachedDeviceId;
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) {
      _cachedDeviceId = existing;
      return existing;
    }
    const generated = generateCryptoUuid();
    await SecureStore.setItemAsync(DEVICE_ID_KEY, generated);
    _cachedDeviceId = generated;
    return generated;
  } catch {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(DEVICE_ID_KEY);
      if (stored) {
        _cachedDeviceId = stored;
        return stored;
      }
      const generated = generateCryptoUuid();
      localStorage.setItem(DEVICE_ID_KEY, generated);
      _cachedDeviceId = generated;
      return generated;
    }
    if (!_cachedDeviceId) _cachedDeviceId = generateCryptoUuid();
    return _cachedDeviceId;
  }
};

/** Real device model name, e.g. "Pixel 8 Pro" — from expo-device. */
export const getDeviceName = (): string => {
  return Device.modelName || Device.deviceName || `${Device.osName || "Unknown"} Device`;
};

/** Real OS + version label, e.g. "Android 15". */
export const getDeviceType = (): string => {
  const os = Device.osName || "Unknown OS";
  const version = Device.osVersion ? ` ${Device.osVersion}` : "";
  return `${os}${version}`;
};

export interface DevicePayload {
  deviceId: string;
  deviceName: string;
  deviceType: string;
}

export const getDevicePayload = async (): Promise<DevicePayload> => {
  const deviceId = await getDeviceIdentifier();
  return {
    deviceId,
    deviceName: getDeviceName(),
    deviceType: getDeviceType(),
  };
};

export interface RegisteredDevice {
  id: number;
  deviceName: string;
  deviceType: string;
  deviceHash: string;
  isPrimary: boolean;
  registeredAt: string | null;
  lastActive: string | null;
  securityStatus: string;
}

/**
 * Fetches the caller's registered devices from the backend (real rows in
 * the `devices` table — populated the first time a transaction is created
 * from that device, per transaction_service.create_transaction, not at
 * login). A device that has never made a transaction has no row here yet,
 * so callers must fall back to local getDeviceName()/getDeviceType()
 * rather than assume this list contains "the current device".
 */
export const getUserDevices = async (userId: number): Promise<RegisteredDevice[]> => {
  // Lazy import: api-client.ts imports getDevicePayload from this module,
  // so a static import here would be a circular dependency.
  const { ApiClient } = await import("./api-client");
  const res = await ApiClient.get<any[]>(`/api/v1/users/${userId}/devices`);
  if (!res.data || !Array.isArray(res.data)) return [];
  return res.data.map((d) => ({
    id: d.id,
    deviceName: d.device_name,
    deviceType: d.device_type,
    deviceHash: d.device_hash,
    isPrimary: !!d.is_primary,
    registeredAt: d.registered_at ?? null,
    lastActive: d.last_active ?? null,
    securityStatus: d.security_status,
  }));
};
