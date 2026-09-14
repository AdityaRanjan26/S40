/**
 * Statement Upload Service (`apps/mobile/src/services/statement-upload-service.ts`)
 *
 * Part 2B: Mobile Statement Document Selection & Validation.
 *
 * Provides safe document picker invocation, validation of supported file formats
 * (PDF, JPEG, PNG, WebP), file size constraints, and strongly typed metadata
 * returns for user statement verification.
 */

import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { ApiClient, ApiResponse, getApiBaseUrl, getAuthToken } from "./api-client";
import {
  StatementFileType,
  SelectedStatementFile,
  StatementUploadRequest,
  StatementUploadResponse,
  StatementUploadErrorType,
  StatementUploadError,
  StatementUploadResult,
  StatementProcessingStatus,
  StatementStatusResponse,
  StatementStatusResult,
  StatementExtractionResponse,
  StatementExtractionResult,
  StatementOCRStatusResponse,
  StatementOCRStatusResult,
} from "../types/statement";

export type {
  StatementFileType,
  SelectedStatementFile,
  StatementUploadRequest,
  StatementUploadResponse,
  StatementUploadErrorType,
  StatementUploadError,
  StatementUploadResult,
  StatementProcessingStatus,
  StatementStatusResponse,
  StatementStatusResult,
  StatementExtractionResponse,
  StatementExtractionResult,
  StatementOCRStatusResponse,
  StatementOCRStatusResult,
};

/**
 * Error classification codes for statement picker & validation failures.
 */
export type StatementPickerErrorCode =
  | "UNSUPPORTED_TYPE"
  | "OVERSIZED_FILE"
  | "EMPTY_FILE"
  | "INVALID_SELECTION"
  | "PICKER_FAILED";

/**
 * Standard supported MIME types for statement documents.
 */
export const SUPPORTED_STATEMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

/**
 * Standard supported file extensions (case-insensitive).
 */
export const SUPPORTED_STATEMENT_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
];

/**
 * Default maximum file size: 10 Megabytes (10 * 1024 * 1024 bytes).
 */
export const DEFAULT_MAX_STATEMENT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// SelectedStatementFile is imported and re-exported from ../types/statement

/**
 * Discriminated union of statement picker outcomes.
 */
export type StatementPickerResult =
  | { status: "success"; file: SelectedStatementFile }
  | { status: "cancelled" }
  | { status: "error"; code: StatementPickerErrorCode; error: string };

/**
 * Configuration options for the statement file picker.
 */
export interface StatementPickerOptions {
  /**
   * Maximum allowed file size in bytes. Defaults to 10 MB.
   */
  maxSizeBytes?: number;
  /**
   * Whether to copy the picked file to the app's cache directory. Defaults to true.
   */
  copyToCacheDirectory?: boolean;
  /**
   * Optional custom picker function, useful for unit testing or custom platforms.
   */
  pickerFn?: (
    options?: DocumentPicker.DocumentPickerOptions
  ) => Promise<DocumentPicker.DocumentPickerResult | { canceled: boolean; assets: any[] | null }>;
}

/**
 * Extracts a lowercase file extension from a filename or path.
 */
export function extractFileExtension(filename: string): string {
  const cleanName = filename.trim();
  const lastDotIndex = cleanName.lastIndexOf(".");
  if (lastDotIndex === -1 || lastDotIndex === cleanName.length - 1) {
    return "";
  }
  return cleanName.slice(lastDotIndex).toLowerCase();
}

/**
 * Detects whether a document is a PDF or an Image based on MIME type and file extension.
 * Returns null if the document type is unsupported.
 */
export function detectStatementFileType(
  mimeType?: string | null,
  filename?: string | null
): StatementFileType | null {
  const normMime = (mimeType || "").trim().toLowerCase();
  const ext = filename ? extractFileExtension(filename) : "";

  // 1. PDF detection
  if (normMime === "application/pdf" || ext === ".pdf") {
    return "pdf";
  }

  // 2. Image detection
  const isImageMime =
    normMime.startsWith("image/") ||
    normMime === "image/jpeg" ||
    normMime === "image/png" ||
    normMime === "image/webp" ||
    normMime === "image/heic" ||
    normMime === "image/heif";

  const isImageExt =
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".png" ||
    ext === ".webp" ||
    ext === ".heic" ||
    ext === ".heif";

  if (isImageMime || isImageExt) {
    return "image";
  }

  return null;
}

/**
 * Resolves a canonical MIME type string given the detected type and extension.
 */
export function resolveCanonicalMimeType(
  rawMime: string | undefined | null,
  fileType: StatementFileType,
  extension: string
): string {
  if (rawMime && rawMime.trim().length > 0 && rawMime !== "application/octet-stream") {
    return rawMime.trim().toLowerCase();
  }

  if (fileType === "pdf") {
    return "application/pdf";
  }

  switch (extension) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

/**
 * Validates a raw document asset against file type and size constraints.
 */
export function validateStatementFile(
  asset: {
    name?: string | null;
    size?: number | null;
    mimeType?: string | null;
    uri?: string | null;
    lastModified?: number;
  },
  maxSizeBytes: number = DEFAULT_MAX_STATEMENT_FILE_SIZE_BYTES
):
  | { valid: true; file: SelectedStatementFile }
  | { valid: false; code: StatementPickerErrorCode; error: string } {
  const uri = (asset.uri || "").trim();
  const rawName = (asset.name || "").trim();
  const name = rawName || "statement_document";

  if (!uri) {
    return {
      valid: false,
      code: "INVALID_SELECTION",
      error: "Selected file has an invalid or empty URI.",
    };
  }

  const extension = extractFileExtension(name);
  const fileType = detectStatementFileType(asset.mimeType, name);

  if (!fileType) {
    return {
      valid: false,
      code: "UNSUPPORTED_TYPE",
      error: `Unsupported file format for "${name}". Please select a PDF or image statement (.pdf, .jpg, .png, .webp).`,
    };
  }

  // Size checks
  const size = asset.size;
  if (typeof size === "number") {
    if (size <= 0) {
      return {
        valid: false,
        code: "EMPTY_FILE",
        error: `Selected file "${name}" is empty (0 bytes).`,
      };
    }

    if (size > maxSizeBytes) {
      const maxMb = (maxSizeBytes / (1024 * 1024)).toFixed(2);
      const fileMb = (size / (1024 * 1024)).toFixed(2);
      return {
        valid: false,
        code: "OVERSIZED_FILE",
        error: `File "${name}" (${fileMb} MB) exceeds the maximum allowed size of ${maxMb} MB.`,
      };
    }
  }

  const mimeType = resolveCanonicalMimeType(asset.mimeType, fileType, extension);

  return {
    valid: true,
    file: {
      uri,
      name,
      size: typeof size === "number" && size > 0 ? size : 0,
      mimeType,
      fileType,
      extension,
      lastModified: asset.lastModified,
    },
  };
}

/**
 * Displays the native OS document picker for the user to select a bank or UPI statement.
 * Validates format (PDF/Image) and size limits, returning a typed StatementPickerResult.
 */
export async function pickStatementFile(
  options: StatementPickerOptions = {}
): Promise<StatementPickerResult> {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_STATEMENT_FILE_SIZE_BYTES;
  const copyToCacheDirectory = options.copyToCacheDirectory ?? true;
  const picker = options.pickerFn ?? DocumentPicker.getDocumentAsync;

  try {
    const result = await picker({
      type: ["application/pdf", "image/*"],
      copyToCacheDirectory,
      multiple: false,
    });

    if (result.canceled || !result.assets || result.assets.length === 0) {
      return { status: "cancelled" };
    }

    const firstAsset = result.assets[0];
    const validation = validateStatementFile(firstAsset, maxSizeBytes);

    if (!validation.valid) {
      return {
        status: "error",
        code: validation.code,
        error: validation.error,
      };
    }

    return {
      status: "success",
      file: validation.file,
    };
  } catch (error) {
    return {
      status: "error",
      code: "PICKER_FAILED",
      error: (error as Error)?.message || "Failed to open document picker.",
    };
  }
}

/**
 * Standard backend endpoint for statement file uploads.
 */
export const STATEMENT_UPLOAD_ENDPOINT = "/api/v1/statements/upload";

/**
 * Configuration options for uploading a statement file.
 */
export interface StatementUploadOptions {
  /** Optional custom endpoint path (defaults to '/api/v1/statements/upload') */
  endpoint?: string;
  /** Optional AbortSignal to cancel an in-flight upload */
  signal?: AbortSignal;
  /** Optional custom upload function for dependency injection in unit/regression tests */
  uploadFn?: (
    formData: FormData,
    signal?: AbortSignal
  ) => Promise<ApiResponse<StatementUploadResponse>>;
}

/**
 * Uploads a validated statement file to the backend statement-upload endpoint.
 *
 * Preserves the original file name and canonical MIME type using its local URI.
 * Classifies all outcomes into a strongly-typed StatementUploadResult.
 */
export async function uploadStatementFile(
  file: SelectedStatementFile,
  options: StatementUploadOptions = {}
): Promise<StatementUploadResult> {
  const endpoint = options.endpoint || STATEMENT_UPLOAD_ENDPOINT;
  const signal = options.signal;

  if (signal?.aborted) {
    return {
      success: false,
      error: {
        type: "CANCELLED",
        message: "Statement upload was cancelled before initiation.",
        statusCode: 0,
      },
    };
  }

  try {
    let response: ApiResponse<StatementUploadResponse>;

    if (options.uploadFn) {
      // Test/dependency-injection path — real FormData still works fine
      // for callers supplying their own mock upload function.
      const formData = new FormData();
      formData.append("file", {
        uri: file.uri,
        name: file.name,
        type: file.mimeType,
      } as any);
      response = await options.uploadFn(formData, signal);
    } else if (Platform.OS === "web") {
      // Real browsers implement a fully functional Blob, unlike RN's
      // native-blob-store stub (see the native branch below) — the
      // standard FormData + fetch path works correctly here.
      const formData = new FormData();
      const fileResponse = await fetch(file.uri);
      const blob = await fileResponse.blob();
      formData.append("file", blob, file.name);
      response = await ApiClient.upload<StatementUploadResponse>(endpoint, formData, { signal });
    } else {
      // Native (iOS/Android): Expo SDK 53+'s global fetch ("winter"
      // runtime) replaced RN's classic networking bridge and only accepts
      // a string or a real Blob/File FormData part. But `globalThis.Blob`
      // here is still React Native's own Blob class, which — by Expo's own
      // code comment (node_modules/expo/src/winter/fetch/createBlob.ts)
      // — "cannot be created from binary data in JS"; constructing one
      // from raw bytes produces an object that still isn't usable as a
      // multipart part, throwing "Unsupported FormDataPart implementation"
      // regardless of the {uri,name,type}/Blob/File shape tried.
      //
      // expo-file-system's native uploadAsync sidesteps all of that: it
      // reads the local file and builds the multipart body on the native
      // side, never touching JS FormData/Blob/fetch at all.
      const FileSystem = require("expo-file-system/legacy");
      const baseUrl = getApiBaseUrl();
      const token = getAuthToken();
      const uploadResult = await FileSystem.uploadAsync(`${baseUrl}${endpoint}`, file.uri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        mimeType: file.mimeType,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

      let data: any = null;
      try {
        data = uploadResult.body ? JSON.parse(uploadResult.body) : null;
      } catch {
        data = null;
      }

      response =
        uploadResult.status >= 200 && uploadResult.status < 300
          ? { status: uploadResult.status, data }
          : {
              status: uploadResult.status,
              data,
              error: typeof data?.detail === "string" ? data.detail : undefined,
            };
    }

    // Success response: 200 OK
    if (response.status === 200 && response.data) {
      return {
        success: true,
        data: response.data,
      };
    }

    // Failure classification
    // 1. Check for cancellation / abort
    if (signal?.aborted) {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement upload was cancelled.",
          statusCode: 0,
        },
      };
    }

    // 2. Authentication failure (401)
    if (response.status === 401) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error ||
            "Authentication required. Please log in again to upload statements.",
          statusCode: 401,
          details: response.data,
        },
      };
    }

    // 3. Network failure (status 0 or isNetworkError)
    if (response.isNetworkError || response.status === 0) {
      return {
        success: false,
        error: {
          type: "NETWORK_FAILURE",
          message:
            response.error ||
            "Unable to connect to Avaran server. Please check your network connection.",
          statusCode: 0,
          details: response.data,
        },
      };
    }

    // 4. Server validation failure (400 Bad Request / 422 Unprocessable)
    if (response.status === 400 || response.status === 422) {
      return {
        success: false,
        error: {
          type: "SERVER_VALIDATION",
          message:
            response.error ||
            "Statement document was rejected by the server due to format or size constraints.",
          statusCode: response.status,
          details: response.data,
        },
      };
    }

    // 5. Server internal error (500+)
    if (response.status >= 500) {
      return {
        success: false,
        error: {
          type: "SERVER_ERROR",
          message:
            response.error ||
            "Server encountered an error while processing the statement upload. Please try again later.",
          statusCode: response.status,
          details: response.data,
        },
      };
    }

    // 6. Generic / unknown error fallback
    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message:
          response.error || "An unexpected error occurred during statement upload.",
        statusCode: response.status,
        details: response.data,
      },
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement upload was cancelled.",
          statusCode: 0,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message: (err as Error)?.message || "Failed to upload bank statement.",
        statusCode: 0,
      },
    };
  }
}

/**
 * Configuration options for retrieving statement processing status.
 */
export interface StatementStatusOptions {
  /** Optional AbortSignal to cancel status request */
  signal?: AbortSignal;
  /** Optional custom status function for dependency injection in unit/regression tests */
  statusFn?: (
    uploadId: string,
    signal?: AbortSignal
  ) => Promise<ApiResponse<StatementStatusResponse>>;
}

/**
 * Retrieves the processing status of an uploaded statement from the backend.
 *
 * Calls GET /api/v1/statements/{upload_id}/status with authentication.
 * Maps status outcomes to StatementStatusResult (RECEIVED, PROCESSING, COMPLETED, FAILED).
 */
export async function getStatementProcessingStatus(
  uploadId: string,
  options: StatementStatusOptions = {}
): Promise<StatementStatusResult> {
  const cleanId = uploadId.trim();
  const signal = options.signal;

  if (!cleanId) {
    return {
      success: false,
      error: {
        type: "SERVER_VALIDATION",
        message: "Invalid statement upload ID provided for status query.",
        statusCode: 400,
      },
    };
  }

  if (signal?.aborted) {
    return {
      success: false,
      error: {
        type: "CANCELLED",
        message: "Status retrieval was cancelled before initiation.",
        statusCode: 0,
      },
    };
  }

  try {
    let response: ApiResponse<StatementStatusResponse>;

    if (options.statusFn) {
      response = await options.statusFn(cleanId, signal);
    } else {
      const endpoint = `${STATEMENT_UPLOAD_ENDPOINT}/${encodeURIComponent(cleanId)}/status`;
      response = await ApiClient.get<StatementStatusResponse>(endpoint);
    }

    // Success response: 200 OK with statement status data
    if (response.status === 200 && response.data) {
      return {
        success: true,
        data: response.data,
      };
    }

    if (signal?.aborted) {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement status query was cancelled.",
          statusCode: 0,
        },
      };
    }

    // Authentication failure (401)
    if (response.status === 401) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error ||
            "Authentication required. Please log in again to view statement status.",
          statusCode: 401,
          details: response.data,
        },
      };
    }

    // Forbidden (403)
    if (response.status === 403) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error ||
            "You are not authorized to view the status of this statement.",
          statusCode: 403,
          details: response.data,
        },
      };
    }

    // Network failure (status 0 / isNetworkError)
    if (response.isNetworkError || response.status === 0) {
      return {
        success: false,
        error: {
          type: "NETWORK_FAILURE",
          message:
            response.error ||
            "Unable to connect to Avaran server to check statement status. Please check your network connection.",
          statusCode: 0,
          details: response.data,
        },
      };
    }

    // Statement not found (404)
    if (response.status === 404) {
      return {
        success: false,
        error: {
          type: "SERVER_VALIDATION",
          message:
            response.error || `Statement record '${cleanId}' was not found on the server.`,
          statusCode: 404,
          details: response.data,
        },
      };
    }

    // Server error (500+)
    if (response.status >= 500) {
      return {
        success: false,
        error: {
          type: "SERVER_ERROR",
          message:
            response.error ||
            "Server encountered an error while retrieving statement status.",
          statusCode: response.status,
          details: response.data,
        },
      };
    }

    // Fallback error
    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message:
          response.error || "Failed to retrieve statement processing status.",
        statusCode: response.status,
        details: response.data,
      },
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement status query was cancelled.",
          statusCode: 0,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message:
          (err as Error)?.message || "Failed to query statement processing status.",
        statusCode: 0,
      },
    };
  }
}

/**
 * Custom options for triggering or retrieving statement extraction.
 */
export interface StatementExtractionOptions {
  signal?: AbortSignal;
  extractFn?: (uploadId: string) => Promise<ApiResponse<StatementExtractionResponse>>;
}

/**
 * Triggers backend text-extraction / OCR for an uploaded statement in RECEIVED status.
 *
 * @param uploadId - The statement tracking receipt ID
 * @param options - Custom options including AbortSignal or mock extractFn
 */
export async function triggerStatementExtraction(
  uploadId: string,
  options?: StatementExtractionOptions
): Promise<StatementExtractionResult> {
  const cleanId = (uploadId || "").trim();
  if (!cleanId) {
    return {
      success: false,
      error: {
        type: "SERVER_VALIDATION",
        message: "A valid statement uploadId is required to trigger extraction.",
        statusCode: 400,
      },
    };
  }

  const signal = options?.signal;
  try {
    const response: ApiResponse<StatementExtractionResponse> = options?.extractFn
      ? await options.extractFn(cleanId)
      : await ApiClient.post<StatementExtractionResponse>(
          `/api/v1/statements/${cleanId}/extract`,
          {}
        );

    if (response.status === 200 && response.data) {
      return {
        success: true,
        data: response.data,
      };
    }

    // Unauthorized (401)
    if (response.status === 401) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error ||
            "Authentication required to trigger statement extraction. Please log in again.",
          statusCode: 401,
          details: response.data,
        },
      };
    }

    // Forbidden (403)
    if (response.status === 403) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error ||
            "You are not authorized to process or extract text from this statement.",
          statusCode: 403,
          details: response.data,
        },
      };
    }

    // Network failure (status 0 / isNetworkError)
    if (response.isNetworkError || response.status === 0) {
      return {
        success: false,
        error: {
          type: "NETWORK_FAILURE",
          message:
            response.error ||
            "Unable to connect to server to trigger statement extraction. Please check your connection.",
          statusCode: 0,
          details: response.data,
        },
      };
    }

    // Statement not found (404)
    if (response.status === 404) {
      return {
        success: false,
        error: {
          type: "SERVER_VALIDATION",
          message:
            response.error || `Statement record '${cleanId}' was not found.`,
          statusCode: 404,
          details: response.data,
        },
      };
    }

    // Validation / state conflict (400)
    if (response.status === 400) {
      return {
        success: false,
        error: {
          type: "SERVER_VALIDATION",
          message:
            response.error || "Cannot initiate extraction: statement is not in RECEIVED status.",
          statusCode: 400,
          details: response.data,
        },
      };
    }

    // Server error (500+)
    if (response.status >= 500) {
      return {
        success: false,
        error: {
          type: "SERVER_ERROR",
          message:
            response.error || "Server encountered an error while extracting statement text.",
          statusCode: response.status,
          details: response.data,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message: response.error || "Failed to trigger statement extraction.",
        statusCode: response.status,
        details: response.data,
      },
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement extraction trigger was cancelled.",
          statusCode: 0,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message: (err as Error)?.message || "Failed to trigger statement extraction.",
        statusCode: 0,
      },
    };
  }
}

/**
 * Retrieves stored text extraction results for a statement.
 *
 * @param uploadId - The statement tracking receipt ID
 * @param options - Custom options including AbortSignal or mock extractFn
 */
export async function getStatementExtraction(
  uploadId: string,
  options?: StatementExtractionOptions
): Promise<StatementExtractionResult> {
  const cleanId = (uploadId || "").trim();
  if (!cleanId) {
    return {
      success: false,
      error: {
        type: "SERVER_VALIDATION",
        message: "A valid statement uploadId is required to retrieve extraction.",
        statusCode: 400,
      },
    };
  }

  const signal = options?.signal;
  try {
    const response: ApiResponse<StatementExtractionResponse> = options?.extractFn
      ? await options.extractFn(cleanId)
      : await ApiClient.get<StatementExtractionResponse>(
          `/api/v1/statements/${cleanId}/extraction`
        );

    if (response.status === 200 && response.data) {
      return {
        success: true,
        data: response.data,
      };
    }

    if (response.status === 401) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error || "Authentication required. Please log in again.",
          statusCode: 401,
          details: response.data,
        },
      };
    }

    if (response.status === 403) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message:
            response.error || "You are not authorized to view this statement's extraction.",
          statusCode: 403,
          details: response.data,
        },
      };
    }

    if (response.isNetworkError || response.status === 0) {
      return {
        success: false,
        error: {
          type: "NETWORK_FAILURE",
          message:
            response.error || "Unable to connect to server to retrieve statement extraction.",
          statusCode: 0,
          details: response.data,
        },
      };
    }

    if (response.status === 404) {
      return {
        success: false,
        error: {
          type: "SERVER_VALIDATION",
          message:
            response.error || `Statement record '${cleanId}' was not found.`,
          statusCode: 404,
          details: response.data,
        },
      };
    }

    return {
      success: false,
      error: {
        type: response.status >= 500 ? "SERVER_ERROR" : "UNKNOWN_ERROR",
        message: response.error || "Failed to retrieve statement extraction.",
        statusCode: response.status,
        details: response.data,
      },
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "Statement extraction query was cancelled.",
          statusCode: 0,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message: (err as Error)?.message || "Failed to query statement extraction.",
        statusCode: 0,
      },
    };
  }
}

/**
 * Custom options for querying OCR engine health status.
 */
export interface StatementOCRStatusOptions {
  signal?: AbortSignal;
  statusFn?: () => Promise<ApiResponse<StatementOCRStatusResponse>>;
}

/**
 * Queries the backend for local OCR engine availability and diagnostic status.
 */
export async function getStatementOCRStatus(
  options?: StatementOCRStatusOptions
): Promise<StatementOCRStatusResult> {
  const signal = options?.signal;
  try {
    const response: ApiResponse<StatementOCRStatusResponse> = options?.statusFn
      ? await options.statusFn()
      : await ApiClient.get<StatementOCRStatusResponse>("/api/v1/statements/ocr/status");

    if (response.status === 200 && response.data) {
      return {
        success: true,
        data: response.data,
      };
    }

    if (response.status === 401) {
      return {
        success: false,
        error: {
          type: "AUTH_FAILURE",
          message: response.error || "Authentication required to query OCR status.",
          statusCode: 401,
          details: response.data,
        },
      };
    }

    if (response.isNetworkError || response.status === 0) {
      return {
        success: false,
        error: {
          type: "NETWORK_FAILURE",
          message:
            response.error || "Unable to reach server to check OCR engine availability.",
          statusCode: 0,
          details: response.data,
        },
      };
    }

    return {
      success: false,
      error: {
        type: response.status >= 500 ? "SERVER_ERROR" : "UNKNOWN_ERROR",
        message: response.error || "Failed to query OCR engine health status.",
        statusCode: response.status,
        details: response.data,
      },
    };
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return {
        success: false,
        error: {
          type: "CANCELLED",
          message: "OCR status query was cancelled.",
          statusCode: 0,
        },
      };
    }

    return {
      success: false,
      error: {
        type: "UNKNOWN_ERROR",
        message: (err as Error)?.message || "Failed to query OCR health status.",
        statusCode: 0,
      },
    };
  }
}
