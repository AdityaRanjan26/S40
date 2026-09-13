import { Platform } from "react-native";
import Constants from "expo-constants";
import { getDevicePayload } from "./device-info-service";

declare const process: any;

/**
 * Default API URL.
 *
 * Local development:
 * http://127.0.0.1:8000
 *
 * Android Emulator normally uses:
 * http://10.0.2.2:8000
 */
/**
 * True for hosts that are only ever reachable as local dev servers
 * (loopback, the Android emulator's host-loopback alias, and RFC1918
 * private LAN ranges) — none of these can carry a real TLS certificate,
 * so they're the only hosts allowed to default to plain HTTP. Any other
 * host defaults to HTTPS unless the caller explicitly asked for
 * "http://" — enforced in sanitizeApiUrl below.
 */
const isLocalDevHost = (host: string): boolean => {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "10.0.2.2" || h === "::1") return true;
  const octets = h.split(".").map((p) => Number(p));
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
  }
  return false;
};

const getHostIp = (): string | null => {
  const hostUri =
    Constants?.expoConfig?.hostUri ||
    (Constants as any)?.manifest2?.extra?.expoClient?.hostUri ||
    (Constants as any)?.manifest?.debuggerHost ||
    (Constants as any)?.experienceUrl;
  if (hostUri && typeof hostUri === "string") {
    const cleaned = hostUri.replace(/^[a-zA-Z]+:\/\//, "");
    const ip = cleaned.split(":")[0];
    if (ip && ip !== "localhost" && ip !== "127.0.0.1") {
      return ip;
    }
  }
  return null;
};

/**
 * Default API URL.
 *
 * Automatically resolves computer LAN IP in Expo Go / physical devices,
 * with fallback to local development server.
 */
const getDefaultFallbackUrl = (): string => {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:8000";
    }
    if (hostname) {
      // A non-loopback hostname could be a LAN dev machine (no real cert,
      // must stay HTTP) or the web build actually being served from a
      // real domain (must be HTTPS) — only the former gets plain HTTP.
      const scheme = isLocalDevHost(hostname) ? "http" : "https";
      return `${scheme}://${hostname}:8000`;
    }
  }
  const hostIp = getHostIp();
  if (hostIp) {
    // Always a LAN IP from the Expo debugger host, never a public address.
    return `http://${hostIp}:8000`;
  }
  return "https://s44-production.up.railway.app";
};

let _customApiBaseUrl: string | null = null;

/**
 * Cleans and normalizes an API URL.
 * Automatically handles ADB reverse forwarding (127.0.0.1:8000) and Expo host URI.
 */
export const sanitizeApiUrl = (url: string): string => {
  // When running in a web browser, route requests dynamically:
  // - If loaded on localhost/127.0.0.1, always target localhost:8000 for direct host-to-host reliability
  // - If loaded via LAN/remote IP, target that host on port 8000
  if (Platform.OS === "web" && typeof window !== "undefined" && window.location) {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:8000";
    }
    if (hostname) {
      const scheme = isLocalDevHost(hostname) ? "http" : "https";
      return `${scheme}://${hostname}:8000`;
    }
  }

  let clean = url.trim();

  if (!clean) {
    return getDefaultFallbackUrl();
  }

  if (
    !clean.startsWith("http://") &&
    !clean.startsWith("https://")
  ) {
    // Secure by default: a bare host/URL with no explicit scheme only
    // gets plain HTTP if it's a recognized local-dev address (no real TLS
    // cert is possible there). Anything else — a real domain typed
    // without a scheme — defaults to HTTPS rather than silently falling
    // back to plaintext. An explicit "http://" in the input is still
    // respected as-is below; this only fills in a MISSING scheme.
    const hostPart = clean.split(/[/:]/)[0];
    clean = `${isLocalDevHost(hostPart) ? "http" : "https"}://${clean}`;
  }

  // In Expo Go or on physical devices, route localhost to packager hostIp
  const hostIp = getHostIp();
  if (hostIp && (clean.includes("://localhost") || clean.includes("://127.0.0.1"))) {
    clean = clean.replace("://localhost", `://${hostIp}`).replace("://127.0.0.1", `://${hostIp}`);
  }

  return clean.replace(/\/+$/, "");
};

/**
 * Gets the current API base URL.
 *
 * Priority:
 * 1. Runtime custom URL
 * 2. EXPO_PUBLIC_API_URL from .env
 * 3. Expo config extra.apiUrl
 * 4. Physical device fallback IP
 */
export const getApiBaseUrl = (): string => {
  if (_customApiBaseUrl) {
    return _customApiBaseUrl;
  }

  const envUrl =
    typeof process !== "undefined"
      ? process?.env?.EXPO_PUBLIC_API_URL
      : null;

  if (
    envUrl &&
    typeof envUrl === "string" &&
    envUrl.trim()
  ) {
    return sanitizeApiUrl(envUrl);
  }

  const extraUrl = Constants?.expoConfig?.extra?.apiUrl;

  if (
    extraUrl &&
    typeof extraUrl === "string" &&
    extraUrl.trim()
  ) {
    return sanitizeApiUrl(extraUrl);
  }

  return getDefaultFallbackUrl();
};

/**
 * Allows the user to override the API URL at runtime.
 */
export const setApiBaseUrl = (url: string | null): void => {
  if (!url || !url.trim()) {
    _customApiBaseUrl = null;
  } else {
    _customApiBaseUrl = sanitizeApiUrl(url);
  }
};

/**
 * Resets runtime API URL.
 */
export const resetApiBaseUrl = (): void => {
  _customApiBaseUrl = null;
};

/**
 * Initial API base URL.
 */
export const API_BASE_URL = getApiBaseUrl();

export interface DemoModeAudit {
  isDemoMode: boolean;
  source: "runtime_override" | "env_var" | "expo_extra" | "default_production";
  rawValue: unknown;
  isExplicitDemo: boolean;
}

let _runtimeDemoMode: boolean | null = null;

/**
 * Explicitly set or override demo mode at runtime (strictly for testing).
 * In ordinary application runtime, this should never be called.
 */
export const setDemoMode = (enabled: boolean | null): void => {
  _runtimeDemoMode = enabled;
};

/**
 * Resets the runtime demo mode override, returning configuration resolution to env/extra defaults.
 */
export const resetDemoMode = (): void => {
  _runtimeDemoMode = null;
};

/**
 * Centralized, hardened configuration resolver for demo mode.
 *
 * Strict Production Guarantees:
 * 1. Live/production is the default: if no explicit intentional configuration is found,
 *    demo mode is strictly FALSE.
 * 2. Strict evaluation of environment variables:
 *    - ONLY exact string "true" (case-sensitive) enables demo mode.
 *    - All other values ("1", "yes", "TRUE", "True", "true ", "0", "false", "", arbitrary)
 *      are treated as invalid / non-demo and evaluate to FALSE.
 * 3. Strict evaluation of Expo extra configuration:
 *    - ONLY boolean true or exact string "true" enables demo mode.
 *    - Missing, falsy, or malformed extra (numbers, objects, arrays, "yes", "1", "TRUE")
 *      evaluate to FALSE.
 * 4. Runtime override:
 *    - Only active when _runtimeDemoMode is explicitly non-null (set in tests).
 */
export const resolveDemoModeConfiguration = (): DemoModeAudit => {
  if (_runtimeDemoMode !== null) {
    return {
      isDemoMode: _runtimeDemoMode === true,
      source: "runtime_override",
      rawValue: _runtimeDemoMode,
      isExplicitDemo: _runtimeDemoMode === true,
    };
  }

  // 1. Check EXPO_PUBLIC_DEMO_MODE environment variable
  const rawEnv =
    typeof process !== "undefined" && process?.env
      ? process.env.EXPO_PUBLIC_DEMO_MODE
      : undefined;

  if (rawEnv !== undefined && rawEnv !== null) {
    const isExplicitTrue = typeof rawEnv === "string" && rawEnv === "true";
    return {
      isDemoMode: isExplicitTrue,
      source: "env_var",
      rawValue: rawEnv,
      isExplicitDemo: isExplicitTrue,
    };
  }

  // 2. Check Expo Constants extra
  const expoConfig =
    Constants?.expoConfig ?? (Constants as any)?.default?.expoConfig;
  const rawExtra = expoConfig?.extra?.demoMode;
  if (rawExtra !== undefined && rawExtra !== null) {
    const isExplicitTrue = rawExtra === true || rawExtra === "true";
    return {
      isDemoMode: isExplicitTrue,
      source: "expo_extra",
      rawValue: rawExtra,
      isExplicitDemo: isExplicitTrue,
    };
  }

  // 3. Default fallback: Live / Production mode
  return {
    isDemoMode: false,
    source: "default_production",
    rawValue: undefined,
    isExplicitDemo: false,
  };
};

/**
 * Determines whether the application is operating in explicit demo/test mode.
 */
export const isDemoMode = (): boolean => {
  return resolveDemoModeConfiguration().isDemoMode;
};

/**
 * Demo mode indicator. Evaluates dynamically via isDemoMode().
 */
export const IS_DEMO_MODE = isDemoMode();

/**
 * Authentication token.
 */
let _authToken: string | null = null;

/**
 * Callback for unauthorized responses.
 */
let _onUnauthorizedCallback: (() => void) | null = null;

export const setAuthToken = (token: string | null) => {
  _authToken = token;
};

export const getAuthToken = (): string | null => {
  return _authToken;
};

export const setOnUnauthorizedCallback = (
  cb: (() => void) | null
) => {
  _onUnauthorizedCallback = cb;
};

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
  isNetworkError?: boolean;
}

export class ApiClient {
  static async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const baseUrl = getApiBaseUrl();

    const cleanEndpoint = endpoint.startsWith("/")
      ? endpoint
      : `/${endpoint}`;

    const url = `${baseUrl}${cleanEndpoint}`;

    let devInfo: {
      deviceId: string;
      deviceName: string;
      deviceType: string;
    } | null = null;

    try {
      devInfo = await getDevicePayload();
    } catch {
      // Device information is optional.
    }

    const isFormData =
      typeof FormData !== "undefined" && options.body instanceof FormData;

    const headers: Record<string, string> = {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      Accept: "application/json",

      ...(devInfo
        ? {
            "X-Device-Id": devInfo.deviceId,
            "X-Device-Name": devInfo.deviceName,
            "X-Device-Type": devInfo.deviceType,
          }
        : {}),

      ...(options.headers as Record<string, string>),
    };

    if (isFormData && headers["Content-Type"] === "application/json") {
      delete headers["Content-Type"];
    }

    if (_authToken) {
      headers["Authorization"] = `Bearer ${_authToken}`;
    }

    try {
      const controller = new AbortController();

      const timeoutMs = isFormData ? 30000 : 10000;
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort();
        } else {
          options.signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        }
      }

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data: any = null;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        let errorMsg = "An unexpected error occurred.";

        if (data && typeof data.detail === "string") {
          errorMsg = data.detail;
        } else if (
          data &&
          data.detail &&
          typeof data.detail === "object" &&
          data.detail.message
        ) {
          errorMsg = data.detail.message;
        } else if (
          data &&
          typeof data.message === "string"
        ) {
          errorMsg = data.message;
        } else if (response.status === 401) {
          errorMsg = "Unauthorized. Please log in again.";

          if (_onUnauthorizedCallback) {
            _onUnauthorizedCallback();
          }
        } else if (response.status === 429) {
          const retryAfter =
            response.headers.get("Retry-After");

          if (retryAfter) {
            const minutes = Math.ceil(
              parseInt(retryAfter, 10) / 60
            );

            errorMsg = `Too many attempts. Please wait ${
              minutes > 1
                ? `${minutes} minutes`
                : "a few moments"
            } before trying again.`;
          } else {
            errorMsg =
              "Too many attempts. Please wait a few minutes before trying again.";
          }
        } else if (response.status === 404) {
          errorMsg = "Resource not found.";
        } else if (response.status >= 500) {
          errorMsg =
            "Server error. Please try again later.";
        }

        return {
          status: response.status,
          error: errorMsg,
          data,
        };
      }

      return {
        status: response.status,
        data,
      };
    } catch (err: any) {
      const isAbort = err?.name === "AbortError";

      return {
        status: 0,
        isNetworkError: true,
        error: isAbort
          ? "Request timed out. Please check your connection."
          : "Unable to connect to Avaran server. Using offline security protection.",
      };
    }
  }

  static get<T>(
    endpoint: string,
    headers?: Record<string, string>
  ) {
    return this.request<T>(endpoint, {
      method: "GET",
      headers,
    });
  }

  static post<T>(
    endpoint: string,
    body?: any,
    headers?: Record<string, string>
  ) {
    return this.request<T>(endpoint, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  static patch<T>(
    endpoint: string,
    body?: any,
    headers?: Record<string, string>
  ) {
    return this.request<T>(endpoint, {
      method: "PATCH",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  static upload<T>(
    endpoint: string,
    formData: FormData,
    options?: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) {
    return this.request<T>(endpoint, {
      method: "POST",
      headers: options?.headers,
      body: formData,
      signal: options?.signal,
    });
  }
}