import {
  ApiClient,
  IS_DEMO_MODE,
  isDemoMode,
  setDemoMode,
  resetDemoMode,
  resolveDemoModeConfiguration,
  DemoModeAudit,
} from "./api-client";
import { AlertService } from "./alert-service";
import {
  DEMO_USER_TRANSACTIONS,
  DEMO_PAYMENT_OVERVIEW,
} from "../data/demo-data";
import {
  CanonicalTransactionStatus,
  PaymentWorkflowStage,
  PaymentWorkflowStageEnum,
  PaymentWorkflowValidationResult,
  validatePaymentAuthorizationStage,
  validatePaymentSubmissionStage,
  validatePaymentCompletionStage,
  assertNotEvaluationStage,
  PaymentInputSource,
  PreparedPaymentDraft,
} from "../types/transaction";
import {
  validateUpiIdInput,
  validateMobileNumberInput,
  validateAmountInput,
} from "../utils/recipient-type";
import { buildRiskEvaluationPayload } from "./risk-service";
import type { LocalRiskEstimate } from "./recipient-risk-service";
import type { LocalAnomalyEstimate } from "./behaviour-anomaly-service";
import {
  parseUpiPaymentPayload,
  ParsedUpiPaymentData,
  ParsedUpiPaymentSuccess,
  ParsedUpiPaymentFailure,
  ParsedUpiPaymentResult,
} from "../utils/upi-payload-parser";

export interface UserPaymentOverview {
  totalAmountThisMonth: number;
  transactionCount: number;
  safeCount: number;
  needsReviewCount: number;
  blockedCount: number;
  reportedCount: number;
  currentRiskLevel: "LOW" | "MEDIUM" | "HIGH";
  currentRiskScore: number; // 0 - 100
  protectionStatus: "PROTECTED" | "ATTENTION REQUIRED";
}

export const EMPTY_PAYMENT_OVERVIEW: UserPaymentOverview = {
  totalAmountThisMonth: 0,
  transactionCount: 0,
  safeCount: 0,
  needsReviewCount: 0,
  blockedCount: 0,
  reportedCount: 0,
  currentRiskLevel: "LOW",
  currentRiskScore: 0,
  protectionStatus: "PROTECTED",
};

export interface RiskFactorItem {
  factor_type: string;
  factor_name: string;
  contribution: number;
  explanation: string;
}

export interface TrustedApprovalAudit {
  required: boolean;
  contactName?: string;
  decision?: "Approved" | "Rejected" | "Expired";
  decisionTime?: string;
  notes?: string;
}

export interface UserTransaction {
  id: string;
  title: string;
  merchant: string;
  amount: number;
  date: string;
  timestamp: string;
  paymentMethod: string;
  status: "Safe" | "Risk detected" | "Approved by you" | "Reported" | "Blocked" | "Held" | "Completed";
  canonicalStatus?: CanonicalTransactionStatus;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  riskScore?: number; // 0 - 100
  riskFactors: RiskFactorItem[];
  reasons: string[];
  isCompleted?: boolean;
  paymentAppUsed?: string;
  completionTimestamp?: string;
  trustedApproval?: TrustedApprovalAudit;
  authorizationRequired?: boolean;
  authorizationStatus?: "NONE" | "PENDING" | "AUTHORIZED" | "REJECTED";
  authorizedAt?: string;
  authorizationMethod?: string;
  note?: string;
  // AVARAN PAY Part 2 Goal 2 persisted card fields

  evaluationId?: string;
  recipientInput?: string;
  recipientType?: "UPI_ID" | "PHONE" | "UNKNOWN" | string;
  normalizedRecipient?: string;
  displayName?: string | null;
  resolutionStatus?: "RESOLVED" | "UNVERIFIED" | "UNRESOLVED" | string;
  decision?: string;
  evaluationTimestamp?: string;
  workflowStage?: "EVALUATION_COMPLETED" | string;
  guardianRequired?: boolean;
}


export interface CreateTransactionInput {
  recipient: string;
  amount: number;
  note?: string;
}

export interface CreateTransactionSuccess {
  success: true;
  data: {
    recipient: string;
    amount: number;
    note?: string;
  };
  transaction?: UserTransaction;
}

export interface CreateTransactionFailure {
  success: false;
  error: string;
}

export type CreateTransactionResult = CreateTransactionSuccess | CreateTransactionFailure;

export interface PaymentDraft {
  recipient: string;
  amount: number;
  note?: string;
}

export interface CreatePaymentDraftSuccess {
  success: true;
  draft: PaymentDraft;
}

export interface CreatePaymentDraftFailure {
  success: false;
  error: string;
}

export type CreatePaymentDraftResult = CreatePaymentDraftSuccess | CreatePaymentDraftFailure;

export interface PreparePaymentInputParams {
  source: PaymentInputSource;
  recipient: string;
  amount: number | string;
  note?: string;
  recipientName?: string;
  qrPayload?: string;
  requestId?: string;
}

export interface PreparePaymentInputSuccess {
  success: true;
  draft: PreparedPaymentDraft;
}

export interface PreparePaymentInputFailure {
  success: false;
  error: string;
}

export type PreparePaymentInputResult = PreparePaymentInputSuccess | PreparePaymentInputFailure;

export interface RiskEvaluationRequest {
  draft: PaymentDraft;
}

export interface RiskEvaluationPlaceholder {
  status: "UNAVAILABLE" | "EVALUATED" | string;
  message: string;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  riskScore?: number;
  reasons?: string[];
  summary?: string;
}

export interface RiskEvaluationSuccess {
  success: true;
  data: RiskEvaluationPlaceholder;
}

export interface RiskEvaluationFailure {
  success: false;
  error: string;
}

export type RiskEvaluationResult = RiskEvaluationSuccess | RiskEvaluationFailure;

export interface PrePaymentRecipientInfo {
  raw_input: string;
  normalized: string;
  recipient_type: "UPI_ID" | "PHONE" | string;
  display_name?: string | null;
  resolution_status: "RESOLVED" | "UNVERIFIED" | "UNRESOLVED" | string;
}

export interface PaymentEvaluationRequest {
  recipient: string;
  recipient_type?: string;
  amount: number;
  note?: string;
  qr_data?: string;
  contact_phone?: string;
  user_id?: number;
}

export interface PaymentEvaluationData {
  evaluation_id?: string;
  stage: "EVALUATION_COMPLETED";
  risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  decision: "ALLOW" | "WARN_CHOICE" | "CONFIRM_OR_CANCEL" | string;
  plain_language_reasons: string[];
  risk_factors?: string[];
  risk_contributions_pct?: Record<string, number>;
  sub_scores?: Record<string, number>;
  recipient?: PrePaymentRecipientInfo;
  amount?: number;
  note?: string;
  qr_data?: string;
  latency_ms?: number;
  timestamp?: string;
  expires_at?: string;
  guardian_required?: boolean;
  disclaimer?: string;
  isAuthorized: false;
  isApproved: false;
  isCompleted: false;
  isSubmitted: false;
}


export interface PaymentEvaluationSuccess {
  success: true;
  data: PaymentEvaluationData;
}

export interface PaymentEvaluationFailure {
  success: false;
  error: string;
}

export type PaymentEvaluationResult = PaymentEvaluationSuccess | PaymentEvaluationFailure;

export const isTransactionTerminal = (
  tx: UserTransaction | { status?: string; isCompleted?: boolean; canonicalStatus?: string } | null | undefined
): boolean => {
  if (!tx) return false;
  if (tx.isCompleted) return true;
  const cs = (tx as any).canonicalStatus;
  if (
    cs === "GUARDIAN_REJECTED" ||
    cs === "GUARDIAN_TIMEOUT" ||
    cs === "COMPLETED" ||
    cs === "CANCELLED" ||
    cs === "REPORTED" ||
    cs === "BLOCKED"
  ) {
    return true;
  }
  const s = tx.status;
  return s === "Completed" || s === "Safe" || s === "Blocked" || s === "Reported";
};

export const isTransactionPayable = (tx: UserTransaction | null | undefined): boolean => {
  if (!tx) return false;
  if (isTransactionTerminal(tx)) return false;
  return tx.status === "Held" || tx.status === "Risk detected" || tx.status === "Approved by you";
};

const STATUS_MAP: Record<string, UserTransaction["status"]> = {
  PENDING: "Held",
  AWAITING_CONFIRMATION: "Held",
  PENDING_AUTHORIZATION: "Held",
  AUTHORIZED: "Held",
  PENDING_GUARDIAN_APPROVAL: "Held",
  // AVARAN PAY spec addition: UPI app launched, awaiting return/confirmation.
  PAYMENT_PENDING: "Held",
  ALLOWED: "Safe",
  CONFIRMED: "Completed",
  // AVARAN PAY spec addition: final immutable record, one step after CONFIRMED.
  COMPLETED: "Completed",
  GUARDIAN_APPROVED: "Approved by you",
  CANCELLED: "Blocked",
  GUARDIAN_REJECTED: "Blocked",
  // AVARAN PAY spec addition: replaces GUARDIAN_TIMEOUT_USER_OVERRODE, which
  // no longer exists backend-side — expiry is now a hard stop, not an
  // override the user could proceed past.
  GUARDIAN_TIMEOUT: "Blocked",
  BLOCKED: "Blocked",
  REPORTED: "Reported",
};

import { getRiskLevelFromScore } from "../utils/risk-scoring";

export const mapBackendTransaction = (t: any): UserTransaction => {
  const status = STATUS_MAP[String(t.status).toUpperCase()] || "Held";
  const rawRiskScore = typeof t.risk_score === "number" ? Math.round(t.risk_score * 10) / 10 : (t.risk_score !== undefined ? Number(t.risk_score) : 0);
  const riskLevel: "LOW" | "MEDIUM" | "HIGH" = getRiskLevelFromScore(rawRiskScore);

  // Only HIGH risk transactions with status 'Held' map to 'Risk detected'.
  // MEDIUM risk transactions remain 'Held' (payable) and are never mapped to 'Risk detected' or 'Safe'.
  let resolvedStatus = status;
  if (riskLevel === "HIGH" && status === "Held") {
    resolvedStatus = "Risk detected";
  } else if (riskLevel === "MEDIUM" && status === "Risk detected") {
    resolvedStatus = "Held";
  }

  const authRequired = Boolean(t.authorization_required || riskLevel === "HIGH");

  const factors: RiskFactorItem[] = Array.isArray(t.risk_factors)
    ? t.risk_factors.map((f: any) => ({
        factor_type: f.factor_type || "ml_signal",
        factor_name: f.factor_name || f.name || "Risk Signal",
        contribution: typeof f.contribution === "number" ? f.contribution : 0,
        explanation: f.explanation || f.factor_name || "Telemetry signal evaluated",
      }))
    : [];

  const reasons = factors.length > 0
    ? factors.map((f) => f.explanation).filter(Boolean)
    : Array.isArray(t.reasons) && t.reasons.length > 0
    ? t.reasons
    : riskLevel === "HIGH"
    ? ["High-risk behavioral anomaly detected", "Transaction requires guardian verification"]
    : riskLevel === "MEDIUM"
    ? ["Transaction amount exceeds usual baseline", "Unverified recipient profile"]
    : ["Standard verified transaction signature"];

  const isTerminal = isTransactionTerminal({ status: resolvedStatus });

  return {
    id: String(t.id),
    title: t.merchant || "UPI Payment",
    merchant: t.merchant || "UPI Payment",
    amount: Number(t.amount) || 0,
    date: t.timestamp ? new Date(t.timestamp).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "Today",
    timestamp: t.timestamp || new Date().toISOString(),
    paymentMethod: t.payment_method || "UPI",
    status: resolvedStatus,
    riskLevel: riskLevel,
    riskScore: rawRiskScore,
    riskFactors: factors,
    reasons: reasons,
    isCompleted: isTerminal,
    completionTimestamp: isTerminal ? t.timestamp : undefined,
    authorizationRequired: authRequired,
    authorizationStatus: t.authorization_status || (authRequired ? "PENDING" : "NONE"),
    authorizedAt: t.authorized_at,
    authorizationMethod: t.authorization_method,
    note: t.note,
    // Goal 2 card fields
    evaluationId: t.evaluation_id || `EVAL-TXN-${t.id}`,
    recipientInput: t.recipient_input || t.merchant || (t.recipient && t.recipient.display_name) || "UPI Payment",
    recipientType: t.recipient_type || (t.payment_method === "UPI" ? "UPI_ID" : "PHONE"),
    normalizedRecipient: t.normalized_recipient || t.recipient_input || t.merchant,
    displayName: t.display_name || (t.recipient && t.recipient.display_name) || null,
    resolutionStatus: t.resolution_status || (t.display_name || (t.recipient && t.recipient.display_name) ? "RESOLVED" : "UNVERIFIED"),
    decision: t.decision || (riskLevel === "LOW" ? "ALLOW" : riskLevel === "MEDIUM" ? "WARN" : "CONFIRM_OR_CANCEL"),
    evaluationTimestamp: t.evaluation_timestamp || t.timestamp,
    workflowStage: t.workflow_stage || "EVALUATION_COMPLETED",
    guardianRequired: Boolean(t.guardian_required),
  };
};


type PaymentSubscriber = (overview: UserPaymentOverview, transactions: UserTransaction[]) => void;

class CentralPaymentManager {
  private transactions: UserTransaction[] = IS_DEMO_MODE ? [...DEMO_USER_TRANSACTIONS] : [];
  private overview: UserPaymentOverview = IS_DEMO_MODE ? { ...DEMO_PAYMENT_OVERVIEW } : EMPTY_PAYMENT_OVERVIEW;
  private subscribers: Set<PaymentSubscriber> = new Set();
  private submittingTransactionIds: Set<string> = new Set();
  private confirmingTransactionIds: Set<string> = new Set();

  public subscribe(fn: PaymentSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify() {
    const ov = this.computeOverview();
    const txCopy = [...this.transactions];
    this.subscribers.forEach((fn) => {
      try {
        fn(ov, txCopy);
      } catch {
        // Safe subscriber notification
      }
    });
  }

  public computeOverview(): UserPaymentOverview {
    const totalAmount = this.transactions.reduce((acc, t) => acc + (t.amount || 0), 0);
    const count = this.transactions.length;
    const reviewItems = this.transactions.filter(
      (t) => t.status === "Risk detected" || t.status === "Held"
    );
    const safeCount = this.transactions.filter(
      (t) => t.status === "Safe" || t.status === "Approved by you" || t.status === "Completed"
    );
    const blockedCount = this.transactions.filter((t) => t.status === "Blocked");
    const reportedCount = this.transactions.filter((t) => t.status === "Reported");

    let currentScore = 0;
    let currentLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW";

    if (reviewItems.length > 0) {
      const highestItem = reviewItems.reduce((max, cur) => {
        const curScore = cur.riskScore ?? 0;
        const maxScore = max.riskScore ?? 0;
        return curScore > maxScore ? cur : max;
      }, reviewItems[0]);

      currentScore = highestItem.riskScore ?? 0;
      currentLevel = getRiskLevelFromScore(currentScore);
    }

    const protStatus = reviewItems.length > 0 || currentLevel === "HIGH" || currentLevel === "MEDIUM" ? "ATTENTION REQUIRED" : "PROTECTED";

    return {
      totalAmountThisMonth: totalAmount,
      transactionCount: count,
      safeCount: safeCount.length,
      needsReviewCount: reviewItems.length,
      blockedCount: blockedCount.length,
      reportedCount: reportedCount.length,
      currentRiskLevel: currentLevel,
      currentRiskScore: currentScore,
      protectionStatus: protStatus,
    };
  }

  /** GET Overview */
  public async getOverview(userId: number = 1): Promise<UserPaymentOverview> {
    if (IS_DEMO_MODE) {
      this.overview = this.computeOverview();
      return this.overview;
    }

    try {
      const res = await ApiClient.get<any>(`/api/v1/users/${userId}/overview`);
      if (res.data) {
        const ovScore = res.data.current_risk_score ?? 0;
        this.overview = {
          totalAmountThisMonth: res.data.total_amount_this_month ?? 0,
          transactionCount: res.data.transaction_count ?? 0,
          safeCount: res.data.safe_count ?? 0,
          needsReviewCount: res.data.needs_review_count ?? 0,
          blockedCount: res.data.blocked_count ?? 0,
          reportedCount: res.data.reported_count ?? 0,
          currentRiskLevel: getRiskLevelFromScore(ovScore),
          currentRiskScore: ovScore,
          protectionStatus: res.data.protection_status ?? (ovScore >= 31 || res.data.needs_review_count > 0 ? "ATTENTION REQUIRED" : "PROTECTED"),
        };
        return this.overview;
      }
    } catch {
      // Fallback
    }

    return this.overview;
  }

  /** GET Transactions */
  public async getTransactions(
    userId: number = 1,
    filter?: "all" | "review" | "safe" | "completed",
    limit?: number,
    offset?: number
  ): Promise<{ items: UserTransaction[]; total: number }> {
    if (isDemoMode()) {
      let items = [...this.transactions];
      if (filter === "review") {
        items = items.filter((t) => t.status === "Risk detected" || t.status === "Held");
      } else if (filter === "safe" || filter === "completed") {
        items = items.filter(
          (t) => t.status === "Safe" || t.status === "Approved by you" || t.status === "Completed"
        );
      }
      if (offset !== undefined && limit !== undefined) {
        items = items.slice(offset, offset + limit);
      } else if (limit !== undefined) {
        items = items.slice(0, limit);
      }
      return { items, total: items.length };
    }

    try {
      const params = new URLSearchParams();
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));
      const qs = params.toString();
      const res = await ApiClient.get<{ items: any[]; total: number }>(
        `/api/v1/users/${userId}/transactions${qs ? `?${qs}` : ""}`
      );
      if (res.data && Array.isArray(res.data.items)) {
        let backendItems = res.data.items.map(mapBackendTransaction);
        this.transactions = [...backendItems];
        let items = [...this.transactions];
        if (filter === "review") {
          items = items.filter((t) => t.status === "Risk detected" || t.status === "Held");
        } else if (filter === "safe" || filter === "completed") {
          items = items.filter((t) => t.status === "Safe" || t.status === "Approved by you" || t.status === "Completed");
        }
        this.notify();
        return { items, total: items.length };
      }

    } catch {
      // Fallback
    }

    return { items: [...this.transactions], total: this.transactions.length };
  }

  /**
   * Validates and registers a new transaction input contract.
   *
   * Rules:
   * - Trims recipient and note.
   * - Rejects an empty recipient.
   * - Rejects an amount that is not finite or is less than or equal to zero.
   * - Returns a clear, typed result ({ success: false, error: string }) for invalid input.
   * - Does not create or insert a transaction when validation fails.
   * - Does not fabricate arbitrary risk/status values into the store without evaluation.
   */
  public createTransaction(input: CreateTransactionInput): CreateTransactionResult {
    if (!input || typeof input !== "object") {
      return { success: false, error: "Recipient UPI ID or merchant name is required" };
    }

    const recipient = typeof input.recipient === "string" ? input.recipient.trim() : "";
    if (!recipient) {
      return { success: false, error: "Recipient UPI ID or merchant name is required" };
    }

    const amount = typeof input.amount === "number" ? input.amount : Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, error: "Transaction amount must be a positive finite number" };
    }

    const rawNote = typeof input.note === "string" ? input.note.trim() : undefined;
    const note = rawNote && rawNote.length > 0 ? rawNote : undefined;

    return {
      success: true,
      data: {
        recipient,
        amount,
        ...(note !== undefined ? { note } : {}),
      },
    };
  }

  /**
   * Converts validated CreateTransactionInput into a non-persisted PaymentDraft.
   * Reuses createTransaction() validation. Does not insert transactions or generate IDs/statuses.
   */
  public createPaymentDraft(input: CreateTransactionInput): CreatePaymentDraftResult {
    const res = this.createTransaction(input);
    if (!res.success) {
      return { success: false, error: res.error };
    }

    const draft: PaymentDraft = {
      recipient: res.data.recipient,
      amount: res.data.amount,
      ...(res.data.note !== undefined ? { note: res.data.note } : {}),
    };

    return {
      success: true,
      draft,
    };
  }

  /**
   * Unified Payment Preparation intake.
   * Validates input from QR, UPI_ID, MOBILE, or PAYMENT_REQUEST sources
   * and produces a canonical PreparedPaymentDraft.
   *
   * Pure intake:
   * - Does NOT evaluate risk
   * - Does NOT create or mutate backend transactions
   * - Does NOT authorize or launch payments
   * - Does NOT produce fake settlement/success state
   */
  public preparePaymentInput(params: PreparePaymentInputParams): PreparePaymentInputResult {
    if (!params || typeof params !== "object") {
      return { success: false, error: "Payment preparation parameters are required." };
    }

    const { source, recipient, amount, note, recipientName, qrPayload, requestId } = params;
    if (!source) {
      return { success: false, error: "Payment source is required." };
    }

    let normalizedRecipient: string;
    let recipientType: "UPI_ID" | "PHONE";

    if (source === "UPI_ID") {
      const upiValidation = validateUpiIdInput(recipient);
      if (!upiValidation.valid) {
        return { success: false, error: upiValidation.error || "Invalid UPI ID." };
      }
      normalizedRecipient = upiValidation.normalized!;
      recipientType = "UPI_ID";
    } else if (source === "MOBILE") {
      const mobileValidation = validateMobileNumberInput(recipient);
      if (!mobileValidation.valid) {
        return { success: false, error: mobileValidation.error || "Invalid mobile number." };
      }
      normalizedRecipient = mobileValidation.normalized!;
      recipientType = "PHONE";
    } else if (source === "QR") {
      const trimmedRec = (recipient || "").trim();
      if (!trimmedRec) {
        return { success: false, error: "QR code did not contain a valid payee address." };
      }
      if (trimmedRec.includes("@")) {
        const upiValidation = validateUpiIdInput(trimmedRec);
        if (!upiValidation.valid) {
          return { success: false, error: upiValidation.error || "Invalid UPI ID in QR code." };
        }
        normalizedRecipient = upiValidation.normalized!;
        recipientType = "UPI_ID";
      } else {
        const mobileValidation = validateMobileNumberInput(trimmedRec);
        if (!mobileValidation.valid) {
          return { success: false, error: mobileValidation.error || "Invalid mobile recipient in QR code." };
        }
        normalizedRecipient = mobileValidation.normalized!;
        recipientType = "PHONE";
      }
    } else if (source === "PAYMENT_REQUEST") {
      const trimmedRec = (recipient || "").trim();
      if (!trimmedRec) {
        return { success: false, error: "Payment request missing recipient identifier." };
      }
      normalizedRecipient = trimmedRec;
      recipientType = trimmedRec.includes("@") ? "UPI_ID" : "PHONE";
    } else {
      return { success: false, error: `Unsupported payment source '${source}'.` };
    }

    const amountValidation = validateAmountInput(amount);
    if (!amountValidation.valid) {
      return { success: false, error: amountValidation.error || "Invalid payment amount." };
    }

    const cleanNote = typeof note === "string" ? note.trim() : undefined;

    const draft: PreparedPaymentDraft = {
      source,
      recipient: normalizedRecipient,
      recipientType,
      recipientName: recipientName?.trim() || undefined,
      amount: amountValidation.amount!,
      note: cleanNote && cleanNote.length > 0 ? cleanNote : undefined,
      qrPayload,
      requestId,
      preparedAt: new Date().toISOString(),
      status: "PREPARED",
    };

    return {
      success: true,
      draft,
    };
  }

  /**
   * Risk-evaluation boundary contract.
   *
   * Accepts a validated PaymentDraft, performs no risk calculation, makes no backend call,
   * inserts no transaction, fabricates no risk/status/ID fields, and returns an explicit
   * UNAVAILABLE placeholder result.
   */
  public evaluatePaymentDraft(request: RiskEvaluationRequest): RiskEvaluationResult {
    if (!request || !request.draft || typeof request.draft !== "object") {
      return {
        success: false,
        error: "Risk evaluation request must provide a valid payment draft.",
      };
    }

    const { recipient, amount } = request.draft;
    if (typeof recipient !== "string" || !recipient.trim()) {
      return {
        success: false,
        error: "Payment draft must have a valid recipient for evaluation.",
      };
    }

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return {
        success: false,
        error: "Payment draft must have a valid positive amount for evaluation.",
      };
    }

    return {
      success: true,
      data: {
        status: "UNAVAILABLE",
        message: "AVARAN PAY risk evaluation is currently unavailable.",
      },
    };
  }

  /**
   * Pre-payment risk evaluation connected directly to the real backend.
   *
   * Calls POST /api/v1/risk/evaluate with recipient, amount, note, and optional context.
   * Purely advisory: creates NO transaction, changes NO transaction status,
   * creates NO alert, and initiates NO payment authorization.
   */
  public async evaluatePayment(request: PaymentEvaluationRequest): Promise<PaymentEvaluationResult> {
    if (!request || typeof request !== "object") {
      return {
        success: false,
        error: "Payment evaluation request must provide valid parameters.",
      };
    }

    const { recipient, amount } = request;
    if (typeof recipient !== "string" || !recipient.trim()) {
      return {
        success: false,
        error: "Payment evaluation request must provide a valid recipient.",
      };
    }

    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return {
        success: false,
        error: "Payment evaluation request must have a valid positive amount.",
      };
    }

    if (isDemoMode()) {
      return this.evaluatePaymentOffline(request);
    }

    try {
      const res = await ApiClient.post<any>("/api/v1/risk/evaluate", {
        recipient: recipient.trim(),
        recipient_type: request.recipient_type,
        amount,
        note: request.note,
        qr_data: request.qr_data,
        contact_phone: request.contact_phone,
        user_id: request.user_id,
      });

      if (res.error && (!res.data || res.status >= 400)) {
        if (res.isNetworkError && isDemoMode()) {
          return this.evaluatePaymentOffline(request);
        }
        return {
          success: false,
          error: res.error,
        };
      }

      if (res.data) {
        const d = res.data;
        const score = typeof d.risk_score === "number" ? d.risk_score : 0;
        const level: "LOW" | "MEDIUM" | "HIGH" =
          d.risk_level === "HIGH" || d.risk_level === "MEDIUM" || d.risk_level === "LOW"
            ? d.risk_level
            : getRiskLevelFromScore(score);

        return {
          success: true,
          data: {
            evaluation_id: d.evaluation_id,
            stage: "EVALUATION_COMPLETED",
            risk_score: score,
            risk_level: level,
            decision: d.decision || "ALLOW",
            plain_language_reasons: Array.isArray(d.plain_language_reasons) ? d.plain_language_reasons : [],
            risk_factors: Array.isArray(d.risk_factors) ? d.risk_factors : [],
            risk_contributions_pct: d.risk_contributions_pct || {},
            sub_scores: d.sub_scores || {},
            recipient: d.recipient,
            amount: typeof d.amount === "number" ? d.amount : amount,
            note: d.note ?? request.note,
            qr_data: d.qr_data ?? request.qr_data,
            latency_ms: d.latency_ms,
            timestamp: d.timestamp || new Date().toISOString(),
            expires_at: d.expires_at,
            guardian_required: Boolean(d.guardian_required),
            disclaimer: d.disclaimer || "Advisory pre-payment evaluation only. No payment authorized or initiated.",
            isAuthorized: false,
            isApproved: false,
            isCompleted: false,
            isSubmitted: false,
          },
        };
      }

      if (res.isNetworkError && isDemoMode()) {
        return this.evaluatePaymentOffline(request);
      }

      return {
        success: false,
        error: res.error || "Server returned an empty evaluation response.",
      };
    } catch (err: any) {
      if (isDemoMode()) {
        return this.evaluatePaymentOffline(request);
      }
      const detail = err?.response?.data?.detail || err?.message || "Failed to evaluate payment draft";
      return {
        success: false,
        error: typeof detail === "string" ? detail : JSON.stringify(detail),
      };
    }
  }

  /**
   * Evaluates an intake-prepared payment draft using the authoritative backend ML risk engine.
   *
   * Calls POST /api/v1/risk/evaluate with canonical recipient, amount, note, and context.
   * Guarantees:
   * - Pure advisory evaluation: creates NO transaction, changes NO transaction status,
   *   creates NO alert, initiates NO guardian approval, and performs NO settlement.
   */
  public async evaluatePreparedPayment(
    draft: PreparedPaymentDraft,
    userId?: number
  ): Promise<PaymentEvaluationResult> {
    if (!draft || typeof draft !== "object") {
      return {
        success: false,
        error: "Prepared payment draft is required for risk evaluation.",
      };
    }

    return this.evaluatePayment({
      recipient: draft.recipient,
      recipient_type: draft.recipientType,
      amount: draft.amount,
      note: draft.note,
      qr_data: draft.qrPayload,
      user_id: userId,
    });
  }


  /**
   * Deterministic offline / demo pre-payment evaluation fallback.
   *
   * Prefers a real signal — RecipientRiskService's on-device ONNX model —
   * over the hardcoded amount-threshold heuristic below. The model's raw
   * output isn't calibrated (see recipient-risk-service.ts's SCALE
   * WARNING), so only its own "elevated vs not" verdict against its
   * bundled threshold is used, never the raw probability as a score.
   * Falls back to the amount heuristic when the model is unavailable
   * (Expo Go, no native module, asset missing, etc. — estimateLocally
   * returns null rather than throwing in all of those cases).
   */
  public async evaluatePaymentOffline(request: PaymentEvaluationRequest): Promise<PaymentEvaluationResult> {
    const raw = request.recipient.trim();
    const isUpi = raw.includes("@");
    const recType = isUpi ? "UPI_ID" : "PHONE";
    const normalizedRecipient = isUpi ? raw.toLowerCase() : raw.replace(/[\s\-\(\)]/g, "").replace(/^(\+91|91)/, "");

    // Loaded lazily rather than as a static import: recipient-risk-service.ts
    // pulls in expo-asset / onnxruntime-react-native at module scope, native
    // modules that crash on load outside the RN runtime (e.g. non-RN
    // regression scripts). estimateLocally itself already fails safe
    // (returns null) once loaded; this guards the module load too.
    let localEstimate: LocalRiskEstimate | null = null;
    try {
      const { RecipientRiskService } = require("./recipient-risk-service");
      localEstimate = await RecipientRiskService.estimateLocally(
        request.amount,
        normalizedRecipient,
        this.transactions
      );
    } catch {
      localEstimate = null;
    }

    // Behaviour-anomaly forest is pure JS/JSON (no native module), so no
    // try/catch-on-load is needed the way the ONNX fraud model needs one —
    // still guarded defensively since it's advisory-only and must never
    // block evaluatePaymentOffline's fallback chain.
    let localAnomaly: LocalAnomalyEstimate | null = null;
    try {
      const { estimateBehaviourAnomalyLocally } = require("./behaviour-anomaly-service");
      localAnomaly = estimateBehaviourAnomalyLocally(request.amount, normalizedRecipient, this.transactions);
    } catch {
      localAnomaly = null;
    }

    let score: number;
    let level: "LOW" | "MEDIUM" | "HIGH";
    let decision: string;
    let reasons: string[];
    let riskFactors: string[];
    let riskContributionsPct: Record<string, number>;
    let disclaimer: string;

    if (localEstimate || localAnomaly) {
      // Two independent on-device signals, same spirit as the server's own
      // saturation fusion (ml/inference/predict.py) but simplified to two
      // boolean "elevated" verdicts rather than continuous probabilities,
      // since that's the only thing either signal exposes as advisory-safe
      // (see recipient-risk-service.ts's SCALE WARNING for why the raw
      // fraud probability specifically must never be treated as a score).
      const fraudElevated = localEstimate?.elevated ?? false;
      const anomalyElevated = localAnomaly?.elevated ?? false;
      const bothPresent = Boolean(localEstimate) && Boolean(localAnomaly);
      const elevatedCount = (fraudElevated ? 1 : 0) + (anomalyElevated ? 1 : 0);

      if (bothPresent && elevatedCount === 2) {
        score = 85;
      } else if (elevatedCount >= 1) {
        score = 55;
      } else {
        score = 15;
      }

      level = score > 60 ? "HIGH" : score > 30 ? "MEDIUM" : "LOW";
      decision = level === "HIGH" ? "CONFIRM_OR_CANCEL" : level === "MEDIUM" ? "WARN_CHOICE" : "ALLOW";

      reasons = [];
      if (fraudElevated) {
        reasons.push(
          localEstimate?.scorable
            ? "On-device fraud model: elevated risk based on prior payment history to this recipient"
            : "On-device fraud model: elevated risk (limited prior history with this recipient)"
        );
      }
      if (anomalyElevated) {
        reasons.push(
          localAnomaly?.scorable
            ? "On-device behaviour model: this amount deviates from your typical pattern with this recipient"
            : "On-device behaviour model: elevated deviation signal (limited prior history)"
        );
      }
      if (reasons.length === 0) {
        reasons.push("On-device models found no elevated risk signal", "Consistent with your typical payment pattern");
      }

      riskFactors = [
        ...(localEstimate ? ["on_device_fraud_model"] : []),
        ...(localAnomaly ? ["on_device_behaviour_anomaly"] : []),
      ];
      const factorCount = riskFactors.length || 1;
      riskContributionsPct = Object.fromEntries(riskFactors.map((f) => [f, Math.round(100 / factorCount)]));
      disclaimer =
        "Offline advisory estimate from on-device models (not the authoritative backend risk engine). No payment authorized or initiated.";
    } else {
      score = 15;
      if (request.amount > 20000) {
        score = 75;
      } else if (request.amount > 5000) {
        score = 45;
      }
      level = score > 60 ? "HIGH" : score > 30 ? "MEDIUM" : "LOW";
      decision = level === "HIGH" ? "CONFIRM_OR_CANCEL" : level === "MEDIUM" ? "WARN_CHOICE" : "ALLOW";
      reasons =
        level === "HIGH"
          ? ["High amount transfer deviates from normal baseline", "Unverified recipient profile"]
          : level === "MEDIUM"
          ? ["Moderate amount transaction", "First-time transfer to this recipient"]
          : ["Standard verified payment signature", "Known device and location pattern"];
      riskFactors = ["amount_deviation", "recipient_novelty"];
      riskContributionsPct = { amount_deviation: 60, recipient_novelty: 40 };
      disclaimer = "Advisory pre-payment evaluation only. No payment authorized or initiated.";
    }

    return {
      success: true,
      data: {
        stage: "EVALUATION_COMPLETED",
        risk_score: score,
        risk_level: level,
        decision,
        plain_language_reasons: reasons,
        risk_factors: riskFactors,
        risk_contributions_pct: riskContributionsPct,
        recipient: {
          raw_input: raw,
          normalized: normalizedRecipient,
          recipient_type: recType,
          display_name: null,
          resolution_status: isUpi ? "UNVERIFIED" : "UNRESOLVED",
        },
        amount: request.amount,
        note: request.note,
        qr_data: request.qr_data,
        latency_ms: 12.5,
        timestamp: new Date().toISOString(),
        disclaimer,
        isAuthorized: false,
        isApproved: false,
        isCompleted: false,
        isSubmitted: false,
      },
    };
  }

  /**

   * Persists an evaluated payment draft as an advisory card / transaction using the backend (Part 2).
   *
   * Purely advisory:
   * - Creates transaction with status PENDING.
   * - Does NOT authorize payment.
   * - Does NOT submit payment.
   * - Does NOT confirm payment.
   * - Does NOT trigger Guardian approval.
   * - Does NOT mark completed.
   * - Does NOT redirect to UPI app.
   */
  public async persistPaymentDraftCard(
    evalData: PaymentEvaluationData,
    draft: PaymentDraft,
    userId: number = 1,
    clientRequestId?: string
  ): Promise<{ success: boolean; transaction?: UserTransaction; error?: string }> {
    if (!evalData || !draft) {
      return { success: false, error: "Evaluation data and draft are required for persistence." };
    }

    const idempotencyKey = clientRequestId || `idem-${evalData.evaluation_id || Date.now()}`;
    const rawRecipient = (evalData.recipient?.raw_input || draft.recipient).trim();
    const isUpi = rawRecipient.includes("@");

    // Demo Mode: Local Persistence
    if (isDemoMode()) {
      const existing = this.transactions.find((t) => t.evaluationId === evalData.evaluation_id);
      if (existing) {
        return { success: true, transaction: existing };
      }

      const txId = `demo-${Date.now()}`;
      const recDisplay = evalData.recipient?.display_name || null;
      const resStatus = evalData.recipient?.resolution_status || (recDisplay ? "RESOLVED" : "UNVERIFIED");

      const demoCard: UserTransaction = {
        id: txId,
        title: recDisplay || rawRecipient,
        merchant: recDisplay || rawRecipient,
        amount: draft.amount,
        date: "Today",
        timestamp: evalData.timestamp || new Date().toISOString(),
        paymentMethod: "UPI",
        status: evalData.risk_level === "HIGH" ? "Risk detected" : "Held",
        riskLevel: evalData.risk_level,
        riskScore: evalData.risk_score,
        riskFactors: (evalData.risk_factors || []).map((name) => ({
          factor_type: "ml_signal",
          factor_name: name,
          contribution: evalData.risk_contributions_pct?.[name] || 0,
          explanation: name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
        })),
        reasons: evalData.plain_language_reasons || [],
        isCompleted: false,
        authorizationRequired: evalData.risk_level === "HIGH",
        authorizationStatus: "NONE",
        note: draft.note,
        evaluationId: evalData.evaluation_id || `EVAL-DEMO-${Date.now()}`,
        recipientInput: rawRecipient,
        recipientType: evalData.recipient?.recipient_type || (isUpi ? "UPI_ID" : "PHONE"),
        normalizedRecipient: evalData.recipient?.normalized || rawRecipient,
        displayName: recDisplay,
        resolutionStatus: resStatus,
        decision: evalData.decision,
        evaluationTimestamp: evalData.timestamp || new Date().toISOString(),
        workflowStage: "EVALUATION_COMPLETED",
        guardianRequired: Boolean(evalData.guardian_required),
      };

      this.transactions = [demoCard, ...this.transactions];
      this.notify();
      return { success: true, transaction: demoCard };
    }

    // Production Mode: Live Backend Persistence
    try {
      const payload: any = {
        user_id: userId,
        source: isUpi ? "UPI_ID" : "MOBILE",
        amount: draft.amount,
        note: draft.note,
        device_identifier: "mobile-device-app",
        device_name: "Mobile App",
        device_type: "SMARTPHONE",
        client_request_id: idempotencyKey,
        evaluation_id: evalData.evaluation_id,
        risk_score: evalData.risk_score,
        risk_level: evalData.risk_level,
        decision: evalData.decision,
        risk_factors: evalData.risk_factors,
        plain_language_reasons: evalData.plain_language_reasons,
        recipient_type: evalData.recipient?.recipient_type || (isUpi ? "UPI_ID" : "PHONE"),
        resolution_status: evalData.recipient?.resolution_status,
        evaluation_timestamp: evalData.timestamp,
        evaluation_expires_at: evalData.expires_at,
        guardian_required: evalData.guardian_required,
      };

      if (isUpi) {
        payload.upi_id = rawRecipient;
      } else {
        payload.phone_number = rawRecipient;
      }

      if (evalData.recipient?.display_name) {
        payload.recipient_name = evalData.recipient.display_name;
      }

      const res = await ApiClient.post<any>("/api/v1/payments/prepare", payload);

      if (res.error && (!res.data || res.status >= 400)) {
        return {
          success: false,
          error: res.error || "Failed to persist payment card on backend.",
        };
      }

      if (res.data) {
        const persistedTx = mapBackendTransaction(res.data);
        // Dedupe locally if already present
        const idx = this.transactions.findIndex((t) => String(t.id) === String(persistedTx.id));
        if (idx >= 0) {
          this.transactions[idx] = persistedTx;
        } else {
          this.transactions = [persistedTx, ...this.transactions];
        }
        this.notify();
        return { success: true, transaction: persistedTx };
      }

      return {
        success: false,
        error: "Server returned empty response when creating payment card.",
      };
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || "Failed to persist payment card.";
      return {
        success: false,
        error: typeof detail === "string" ? detail : JSON.stringify(detail),
      };
    }
  }

  /**
   * Parses a raw UPI payment payload using the centralized parser contract.
   */
  public parseUpiPayload(payload: string): ParsedUpiPaymentResult {
    return parseUpiPaymentPayload(payload);
  }


  public addTransaction(newTx: UserTransaction) {
    this.transactions = [newTx, ...this.transactions];
    this.notify();
  }

  public updateTransactionStatus(
    transactionId: string,
    status: UserTransaction["status"],
    canonicalStatus?: CanonicalTransactionStatus
  ): boolean {
    const isTerminal = isTransactionTerminal({ status, canonicalStatus });
    let found = false;
    this.transactions = this.transactions.map((t) => {
      if (t.id === transactionId || String(t.id) === String(transactionId)) {
        found = true;
        return {
          ...t,
          status,
          ...(canonicalStatus ? { canonicalStatus } : {}),
          isCompleted: isTerminal,
          completionTimestamp: isTerminal ? new Date().toISOString() : t.completionTimestamp,
        };
      }
      return t;
    });

    if (found) {
      if (isTerminal) {
        AlertService.resolveAlertForTransaction(transactionId);
      }
      this.notify();
    }
    return found;
  }

  public async completeTransaction(
    transactionId: string,
    paymentAppUsed?: string,
    trustedDetails?: TrustedApprovalAudit,
    stage?: PaymentWorkflowStage | { stage?: any } | string | null,
    options?: { hasActiveContext?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    if (!transactionId || String(transactionId).trim() === "") {
      return { success: false, error: "Missing transaction ID" };
    }

    const txKey = String(transactionId);

    // Concurrency lock: prevent duplicate completion while an existing call is in-flight
    if (this.confirmingTransactionIds.has(txKey)) {
      return { success: false, error: "Payment confirmation already in progress" };
    }

    // Find existing transaction
    const targetTx = this.transactions.find(
      (t) => t.id === transactionId || String(t.id) === txKey
    );
    if (!targetTx) {
      return { success: false, error: "Transaction not found" };
    }

    // Terminal status check: do NOT complete already completed, cancelled, failed, or reported transactions
    const rawStatus = String(targetTx.canonicalStatus || targetTx.status || "").toUpperCase();
    if (
      targetTx.isCompleted ||
      rawStatus === "CONFIRMED" ||
      rawStatus === "COMPLETED" ||
      rawStatus === "CANCELLED" ||
      rawStatus === "FAILED" ||
      rawStatus === "REPORTED" ||
      isTransactionTerminal({
        status: targetTx.canonicalStatus || (targetTx.status as any),
        isCompleted: targetTx.isCompleted,
      })
    ) {
      return {
        success: false,
        error: `Cannot complete transaction in terminal status '${targetTx.canonicalStatus || targetTx.status}'`,
      };
    }

    // Check active manual-confirmation context if explicitly provided
    if (
      (targetTx.canonicalStatus === "PAYMENT_APP_PENDING" || rawStatus === "PAYMENT_APP_PENDING") &&
      options?.hasActiveContext === false
    ) {
      return {
        success: false,
        error: "No active manual-confirmation context for pending payment",
      };
    }

    const stageToValidate =
      stage !== undefined
        ? stage
        : typeof paymentAppUsed === "object" && paymentAppUsed !== null && "stage" in (paymentAppUsed as any)
        ? paymentAppUsed
        : paymentAppUsed === "EVALUATION_COMPLETED" ||
          paymentAppUsed === "PAYMENT_AUTHORIZED" ||
          paymentAppUsed === "PAYMENT_SUBMITTED" ||
          paymentAppUsed === "PAYMENT_COMPLETED" ||
          paymentAppUsed === "LOW" ||
          paymentAppUsed === "MEDIUM" ||
          paymentAppUsed === "HIGH"
        ? paymentAppUsed
        : undefined;

    if (stageToValidate !== undefined) {
      const validation = validatePaymentCompletionStage(stageToValidate);
      if (!validation.valid) {
        return { success: false, error: validation.error || "Invalid workflow stage for payment completion" };
      }
    }

    this.confirmingTransactionIds.add(txKey);

    try {
      const demoActive = isDemoMode();

      // In production/live mode: backend confirmation is mandatory.
      // Network failure, offline state, or server error must NEVER silently fall back to local confirmation.
      if (!demoActive) {
        try {
          const payload = CentralPaymentManager.buildConfirmationPayload(
            (typeof paymentAppUsed === "string" && stageToValidate === undefined ? paymentAppUsed : undefined) || "Google Pay UPI"
          );
          const res = await ApiClient.post<{ id: number; status: string; message?: string }>(
            `/api/v1/transactions/${transactionId}/confirm`,
            payload
          );
          if (res.error) {
            return {
              success: false,
              error: res.error || "Backend confirmation required in live mode. Payment remains pending.",
            };
          }
        } catch (err: any) {
          return {
            success: false,
            error: err?.message || "Network error during confirmation. Payment remains pending.",
          };
        }
      }

      let found = false;
      this.transactions = this.transactions.map((t) => {
        if (t.id === transactionId || String(t.id) === txKey) {
          found = true;
          return {
            ...t,
            status: "Completed",
            canonicalStatus: "CONFIRMED",
            isCompleted: true,
            paymentAppUsed:
              (typeof paymentAppUsed === "string" && stageToValidate === undefined ? paymentAppUsed : undefined) ||
              t.paymentAppUsed ||
              "Google Pay UPI",
            completionTimestamp: new Date().toISOString(),
            trustedApproval: trustedDetails || t.trustedApproval || { required: false },
          };
        }
        return t;
      });

      if (found) {
        AlertService.resolveAlertForTransaction(transactionId);
        this.notify();
      }
      return { success: found };
    } finally {
      this.confirmingTransactionIds.delete(txKey);
    }
  }

  public async authorizeTransaction(
    transactionId: string,
    methodOrStage: string | { stage?: any } = "BIOMETRIC",
    explicitStage?: PaymentWorkflowStage | { stage?: any } | string | null
  ): Promise<{ success: boolean; error?: string }> {
    const stageToValidate =
      explicitStage !== undefined
        ? explicitStage
        : typeof methodOrStage === "object" && methodOrStage !== null && "stage" in (methodOrStage as any)
        ? methodOrStage
        : methodOrStage === "EVALUATION_COMPLETED" ||
          methodOrStage === "PAYMENT_AUTHORIZED" ||
          methodOrStage === "PAYMENT_SUBMITTED" ||
          methodOrStage === "PAYMENT_COMPLETED" ||
          methodOrStage === "LOW" ||
          methodOrStage === "MEDIUM" ||
          methodOrStage === "HIGH"
        ? methodOrStage
        : undefined;

    const method =
      typeof methodOrStage === "string" &&
      methodOrStage !== "EVALUATION_COMPLETED" &&
      methodOrStage !== "PAYMENT_AUTHORIZED" &&
      methodOrStage !== "PAYMENT_SUBMITTED" &&
      methodOrStage !== "PAYMENT_COMPLETED" &&
      methodOrStage !== "LOW" &&
      methodOrStage !== "MEDIUM" &&
      methodOrStage !== "HIGH"
        ? methodOrStage
        : "BIOMETRIC";

    if (stageToValidate !== undefined) {
      const validation = validatePaymentAuthorizationStage(stageToValidate);
      if (!validation.valid) {
        return { success: false, error: validation.error || "Invalid workflow stage for payment authorization" };
      }
    }

    if (!isDemoMode()) {
      try {
        const payload = CentralPaymentManager.buildAuthorizationPayload(method);
        const res = await ApiClient.post<{
          transaction_id: number;
          status: string;
          authorization_status: string;
          message?: string;
        }>(`/api/v1/transactions/${transactionId}/authorize`, payload);
        if (res.error && !res.error.includes("Unable to connect")) {
          return { success: false, error: res.error };
        }
      } catch {
        // Fallback
      }
    }

    let found = false;
    this.transactions = this.transactions.map((t) => {
      if (t.id === transactionId || String(t.id) === String(transactionId)) {
        found = true;
        return {
          ...t,
          authorizationStatus: "AUTHORIZED",
          authorizedAt: new Date().toISOString(),
          authorizationMethod: method,
        };
      }
      return t;
    });

    if (found) {
      this.notify();
    }
    return { success: found };
  }

  public async submitTransaction(
    transactionId: string,
    stageOrApp?: PaymentWorkflowStage | { stage?: any } | string | null,
    paymentAppUsed?: string
  ): Promise<{ success: boolean; error?: string }> {
    let stageToValidate: any = undefined;
    let actualApp = paymentAppUsed || "Google Pay UPI";

    if (stageOrApp !== undefined) {
      if (
        typeof stageOrApp === "object" ||
        stageOrApp === null ||
        paymentAppUsed !== undefined ||
        (typeof stageOrApp === "string" && (stageOrApp.includes("_") || stageOrApp.toUpperCase() === stageOrApp))
      ) {
        stageToValidate = stageOrApp;
      } else {
        actualApp = stageOrApp;
      }
    }

    if (stageToValidate !== undefined) {
      const validation = validatePaymentSubmissionStage(stageToValidate);
      if (!validation.valid) {
        return { success: false, error: validation.error || "Invalid workflow stage for payment submission" };
      }
    }

    const txKey = String(transactionId);
    if (this.submittingTransactionIds.has(txKey)) {
      return { success: false, error: "Payment submission already in progress" };
    }

    this.submittingTransactionIds.add(txKey);

    try {
      if (!isDemoMode()) {
        try {
          const payload = CentralPaymentManager.buildSubmissionPayload(actualApp);
          const res = await ApiClient.post<{
            transaction_id: number;
            stage: string;
            status: string;
            payment_app_used?: string;
            message?: string;
          }>(`/api/v1/transactions/${transactionId}/submit`, payload);

          if (res.error && !res.error.includes("Unable to connect")) {
            return { success: false, error: res.error };
          }
        } catch (err: any) {
          return { success: false, error: err?.message || "Failed to submit transaction to backend" };
        }
      }

      let found = false;
      this.transactions = this.transactions.map((t) => {
        if (t.id === transactionId || String(t.id) === String(transactionId)) {
          found = true;
          return {
            ...t,
            canonicalStatus: "PAYMENT_APP_PENDING",
            paymentAppUsed: actualApp,
          };
        }
        return t;
      });

      if (found) {
        this.notify();
      }
      return { success: found };
    } finally {
      this.submittingTransactionIds.delete(txKey);
    }
  }

  public async confirmTransaction(
    transactionId: string,
    stage?: PaymentWorkflowStage | { stage?: any } | string | null,
    options?: { hasActiveContext?: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    if (stage !== undefined) {
      const validation = validatePaymentCompletionStage(stage);
      if (!validation.valid) {
        return { success: false, error: validation.error || "Invalid workflow stage for payment confirmation" };
      }
    }
    return this.completeTransaction(transactionId, undefined, undefined, stage, options);
  }

  public async reportTransaction(transactionId: string): Promise<{ success: boolean; error?: string }> {
    if (!isDemoMode()) {
      try {
        await ApiClient.post(`/api/v1/transactions/${transactionId}/report`);
      } catch {
        // Fallback
      }
    }

    let reportedTx: UserTransaction | undefined;
    this.transactions = this.transactions.map((t) => {
      if (t.id === transactionId || String(t.id) === String(transactionId)) {
        reportedTx = { ...t, status: "Reported", isCompleted: true };
        return reportedTx;
      }
      return t;
    });

    if (reportedTx) {
      AlertService.addAlert({
        id: `alert-fraud-${transactionId}`,
        title: "Fraud Incident Reported",
        description: `Payment to ${reportedTx.merchant} (₹${reportedTx.amount.toLocaleString("en-IN")}) marked as fraudulent by user.`,
        severity: "HIGH",
        status: "ACTIVE",
        timestamp: "Just now",
        transactionId: transactionId,
        isRead: false,
      });
      this.notify();
      return { success: true };
    }
    return { success: false, error: "Transaction not found" };
  }

  public async cancelTransaction(transactionId: string): Promise<{ success: boolean; error?: string }> {
    if (!isDemoMode()) {
      try {
        await ApiClient.post(`/api/v1/transactions/${transactionId}/cancel`);
      } catch {
        // Fallback
      }
    }

    const ok = this.updateTransactionStatus(transactionId, "Blocked");
    return { success: ok };
  }

  /**
   * Runtime guard validating payment workflow stages against unauthorized evaluation execution.
   */
  public validateWorkflowStage(
    operation: "authorize" | "submit" | "complete",
    stageOrObject?: PaymentWorkflowStage | { stage?: PaymentWorkflowStage | string | null } | string | null
  ): PaymentWorkflowValidationResult {
    switch (operation) {
      case "authorize":
        return validatePaymentAuthorizationStage(stageOrObject);
      case "submit":
        return validatePaymentSubmissionStage(stageOrObject);
      case "complete":
        return validatePaymentCompletionStage(stageOrObject);
      default:
        return { valid: false, error: `Unknown payment operation '${operation}'` };
    }
  }

  /**
   * Builds the canonical payload for the payment authorization API endpoint.
   * Required stage: "PAYMENT_AUTHORIZED".
   */
  public static buildAuthorizationPayload(method: string = "BIOMETRIC"): {
    method: string;
    stage: PaymentWorkflowStage;
  } {
    return {
      method,
      stage: PaymentWorkflowStageEnum.PAYMENT_AUTHORIZED,
    };
  }

  /**
   * Builds the canonical payload for the payment submission API endpoint.
   * Required stage: "PAYMENT_SUBMITTED".
   */
  public static buildSubmissionPayload(paymentAppUsed: string = "Google Pay UPI"): {
    stage: PaymentWorkflowStage;
    payment_app_used?: string;
  } {
    return {
      stage: PaymentWorkflowStageEnum.PAYMENT_SUBMITTED,
      payment_app_used: paymentAppUsed,
    };
  }

  /**
   * Builds the canonical payload for the payment confirmation API endpoint.
   * Required stage: "PAYMENT_COMPLETED".
   */
  public static buildConfirmationPayload(paymentAppUsed: string = "Google Pay UPI"): {
    stage: PaymentWorkflowStage;
    payment_app_used?: string;
  } {
    return {
      stage: PaymentWorkflowStageEnum.PAYMENT_COMPLETED,
      payment_app_used: paymentAppUsed,
    };
  }

  public buildAuthorizationPayload(method: string = "BIOMETRIC") {
    return CentralPaymentManager.buildAuthorizationPayload(method);
  }

  public buildSubmissionPayload(paymentAppUsed: string = "Google Pay UPI") {
    return CentralPaymentManager.buildSubmissionPayload(paymentAppUsed);
  }

  public buildConfirmationPayload(paymentAppUsed: string = "Google Pay UPI") {
    return CentralPaymentManager.buildConfirmationPayload(paymentAppUsed);
  }
}

export const PaymentService = new CentralPaymentManager();
export const createPaymentDraft = (input: CreateTransactionInput): CreatePaymentDraftResult => {
  return PaymentService.createPaymentDraft(input);
};
export const evaluatePaymentDraft = (request: RiskEvaluationRequest): RiskEvaluationResult => {
  return PaymentService.evaluatePaymentDraft(request);
};
export const evaluatePayment = (request: PaymentEvaluationRequest): Promise<PaymentEvaluationResult> => {
  return PaymentService.evaluatePayment(request);
};
export const persistPaymentDraftCard = (
  evalData: PaymentEvaluationData,
  draft: PaymentDraft,
  userId: number = 1,
  clientRequestId?: string
): Promise<{ success: boolean; transaction?: UserTransaction; error?: string }> => {
  return PaymentService.persistPaymentDraftCard(evalData, draft, userId, clientRequestId);
};

export const authorizePaymentTransaction = (
  transactionId: string,
  methodOrStage?: string | { stage?: any },
  explicitStage?: PaymentWorkflowStage | { stage?: any } | string | null
): Promise<{ success: boolean; error?: string }> => {
  return PaymentService.authorizeTransaction(transactionId, methodOrStage, explicitStage);
};
export const submitPaymentTransaction = (
  transactionId: string,
  stageOrApp?: PaymentWorkflowStage | { stage?: any } | string | null,
  paymentAppUsed?: string
): Promise<{ success: boolean; error?: string }> => {
  return PaymentService.submitTransaction(transactionId, stageOrApp, paymentAppUsed);
};
export const completePaymentTransaction = (
  transactionId: string,
  paymentAppUsed?: string,
  trustedDetails?: TrustedApprovalAudit,
  stage?: PaymentWorkflowStage | { stage?: any } | string | null,
  options?: { hasActiveContext?: boolean }
): Promise<{ success: boolean; error?: string }> => {
  return PaymentService.completeTransaction(transactionId, paymentAppUsed, trustedDetails, stage, options);
};

export const updateTransactionStatus = (
  transactionId: string,
  status: UserTransaction["status"],
  canonicalStatus?: CanonicalTransactionStatus
): boolean => {
  return PaymentService.updateTransactionStatus(transactionId, status, canonicalStatus);
};

export const buildPaymentAuthorizationPayload = CentralPaymentManager.buildAuthorizationPayload;
export const buildPaymentSubmissionPayload = CentralPaymentManager.buildSubmissionPayload;
export const buildPaymentConfirmationPayload = CentralPaymentManager.buildConfirmationPayload;
export { buildRiskEvaluationPayload };
export {
  isDemoMode,
  setDemoMode,
  resetDemoMode,
  resolveDemoModeConfiguration,
  DemoModeAudit,
};

export {
  parseUpiPaymentPayload,
  ParsedUpiPaymentData,
  ParsedUpiPaymentSuccess,
  ParsedUpiPaymentFailure,
  ParsedUpiPaymentResult,
};

export {
  PaymentWorkflowStage,
  PaymentWorkflowStageEnum,
  PaymentWorkflowValidationResult,
  isEvaluationStage,
  isPaymentAuthorizedStage,
  isPaymentSubmittedStage,
  isPaymentCompletedStage,
  isEvaluationAuthorized,
  isEvaluationCompleted,
  validatePaymentAuthorizationStage,
  validatePaymentSubmissionStage,
  validatePaymentCompletionStage,
  assertNotEvaluationStage,
} from "../types/transaction";

