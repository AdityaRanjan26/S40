import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useEffect,
} from "react";
import { AppState, AppStateStatus, Vibration } from "react-native";
import { TrustedContact, GuardianRequest, GuardianStatus } from "../types/guardian";
import { GuardianService, GuardianRequestDto } from "../services/guardian-service";
import { PaymentService, UserTransaction, isTransactionTerminal } from "../services/payment-service";
import { useAuth } from "./AuthContext";

import { ApiClient, IS_DEMO_MODE, getApiBaseUrl } from "../services/api-client";
import { UserPatternService } from "../services/user-pattern-service";
import { syncDeviceCheck } from "../services/ml/local-device-risk";
import { getRiskLevelFromScore } from "../utils/risk-scoring";

// A 2-minute hold, matching the backend's real expiry (spec §6.3) — the UI
// previously used a hardcoded 60s that didn't match what the server actually
// enforced.
const HOLD_SECONDS = 120;
const POLL_INTERVAL_MS = 3000;

const parseUtcDate = (dateStr: string | null | undefined): number => {
  if (!dateStr) return 0;
  const s = dateStr.endsWith("Z") || dateStr.includes("+") ? dateStr : `${dateStr}Z`;
  const parsed = new Date(s).getTime();
  return isNaN(parsed) ? 0 : parsed;
};

const toGuardianRequest = (
  dto: GuardianRequestDto,
  fallback?: Partial<Pick<GuardianRequest, "merchant" | "paymentMethod" | "riskLevel">>
): GuardianRequest => {
  const createdAt = parseUtcDate(dto.requestedAt) || Date.now();
  const expiresAt = parseUtcDate(dto.expiresAt) || createdAt + HOLD_SECONDS * 1000;
  const resolvedAt = dto.resolvedAt ? parseUtcDate(dto.resolvedAt) : undefined;
  // Authoritative score -> level, never a locally invented threshold. This
  // used to be `dto.riskScore >= 75 ? "HIGH" : "MEDIUM"` (a different cutoff
  // than utils/risk-scoring.ts's shared 61/31 bands, and one that could never
  // produce "LOW") — the same transaction could show as MEDIUM here while
  // correctly showing LOW/HIGH elsewhere. `?? 0` similarly replaces an
  // invented `?? 75` fallback score.
  const resolvedRiskScore = dto.riskScore ?? 0;

  return {
    id: String(dto.id),
    transactionId: String(dto.transactionId),
    merchant: dto.recipientName || fallback?.merchant || "Recipient",
    amount: dto.transactionAmount,
    paymentMethod: fallback?.paymentMethod || "UPI",
    riskScore: resolvedRiskScore,
    riskLevel: fallback?.riskLevel || getRiskLevelFromScore(resolvedRiskScore),
    reasons: dto.riskReasons,
    status: (dto.outcome || "PENDING") as GuardianStatus,
    senderName: dto.senderName,
    senderPhoneMasked: dto.senderPhoneMasked,
    recipientName: dto.recipientName,
    createdAt,
    expiresAt,
    resolvedAt,
  };
};

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------
interface GuardianContextType {
  trustedContacts: TrustedContact[];
  isLoadingContacts: boolean;
  loadContacts: (userId: number) => Promise<void>;
  addContact: (
    userId: number,
    contact: Omit<TrustedContact, "id" | "addedAt">
  ) => Promise<{ success: boolean; error?: string }>;
  removeContact: (
    userId: number,
    contactId: string
  ) => Promise<{ success: boolean; error?: string }>;

  isTrustedFeatureEnabled: boolean;
  toggleTrustedFeature: () => boolean;
  setTrustedFeatureEnabled: (enabled: boolean) => void;

  activeRequest: GuardianRequest | null;
  pendingRequests: GuardianRequest[];
  countdown: number;
  paymentOutcome: "APPROVED" | "REJECTED" | "EXPIRED" | null;

  initiateGuardianRequest: (tx: UserTransaction) => Promise<void>;
  syncActiveRequestForTransaction: (tx: UserTransaction) => Promise<void>;
  respondToRequest: (
    requestId: string,
    decision: "APPROVED" | "REJECTED"
  ) => Promise<{ success: boolean; error?: string }>;
  clearPaymentOutcome: () => void;

  notificationBadge: number;
  clearNotificationBadge: () => void;

  approvalCard: GuardianRequest | null;
  openApprovalCard: (request: GuardianRequest) => void;
  closeApprovalCard: () => void;
}

const GuardianContext = createContext<GuardianContextType>({
  trustedContacts: [],
  isLoadingContacts: false,
  loadContacts: async () => {},
  addContact: async () => ({ success: true }),
  removeContact: async () => ({ success: true }),
  isTrustedFeatureEnabled: true,
  toggleTrustedFeature: () => true,
  setTrustedFeatureEnabled: () => {},
  activeRequest: null,
  pendingRequests: [],
  countdown: HOLD_SECONDS,
  paymentOutcome: null,
  initiateGuardianRequest: async () => {},
  syncActiveRequestForTransaction: async () => {},
  respondToRequest: async () => ({ success: true }),
  clearPaymentOutcome: () => {},
  notificationBadge: 0,
  clearNotificationBadge: () => {},
  approvalCard: null,
  openApprovalCard: () => {},
  closeApprovalCard: () => {},
});

export const GuardianProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { session } = useAuth();
  const [trustedContacts, setTrustedContacts] = useState<TrustedContact[]>([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [isTrustedFeatureEnabled, setIsTrustedFeatureEnabled] = useState<boolean>(true);

  const [activeRequest, setActiveRequest] = useState<GuardianRequest | null>(null);
  const [pendingRequests, setPendingRequests] = useState<GuardianRequest[]>([]);
  const [countdown, setCountdown] = useState<number>(HOLD_SECONDS);
  const [paymentOutcome, setPaymentOutcome] = useState<"APPROVED" | "REJECTED" | "EXPIRED" | null>(null);

  const [notificationBadge, setNotificationBadge] = useState<number>(0);
  const [approvalCard, setApprovalCard] = useState<GuardianRequest | null>(null);

  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activePollHolderRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const knownPendingIdsRef = useRef<Set<string>>(new Set());
  const resolvedRef = useRef<boolean>(false);
  const isInitiatingRef = useRef<boolean>(false);

  const clearTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (activePollHolderRef.current) {
      clearInterval(activePollHolderRef.current);
      activePollHolderRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      if (pendingPollRef.current) clearInterval(pendingPollRef.current);
    };
  }, [clearTimers]);

  useEffect(() => {
    knownPendingIdsRef.current.clear();
    setPendingRequests([]);
    setNotificationBadge(0);
    setApprovalCard(null);
  }, [session?.userId]);

  useEffect(() => {
    if (pendingPollRef.current) {
      clearInterval(pendingPollRef.current);
      pendingPollRef.current = null;
    }

    const guardianUserId = session?.userId && session.userId > 0 ? session.userId : null;
    if (!guardianUserId) {
      setPendingRequests([]);
      setNotificationBadge(0);
      return;
    }

    const poll = async () => {
      const baseUrl = getApiBaseUrl();
      const dtos = await GuardianService.getPendingRequestsByGuardianUserId(guardianUserId);

      const mapped = dtos
        .map((d) => toGuardianRequest(d))
        .filter((r) => r.status === "PENDING" && r.expiresAt > Date.now());

      const newOnes = mapped.filter((r) => !knownPendingIdsRef.current.has(r.id));
      if (newOnes.length > 0) {
        Vibration.vibrate([0, 250, 150, 250, 150, 250, 150, 250, 150, 250]);
      }

      mapped.forEach((r) => knownPendingIdsRef.current.add(r.id));
      setPendingRequests(mapped);
      setNotificationBadge(mapped.length);

      setApprovalCard((current) => {
        if (!current) return null;
        const stillPending = mapped.some((r) => r.id === current.id);
        return stillPending ? current : null;
      });
    };

    poll();
    pendingPollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pendingPollRef.current) {
        clearInterval(pendingPollRef.current);
        pendingPollRef.current = null;
      }
    };
  }, [session?.userId]);

  const toggleTrustedFeature = useCallback((): boolean => {
    let next = true;
    setIsTrustedFeatureEnabled((prev) => {
      next = !prev;
      return next;
    });
    return next;
  }, []);

  const setTrustedFeatureEnabled = useCallback((enabled: boolean) => {
    setIsTrustedFeatureEnabled(enabled);
  }, []);

  const loadContacts = useCallback(async (userId: number) => {
    setIsLoadingContacts(true);
    try {
      const contacts = await GuardianService.getTrustedContacts(userId);
      setTrustedContacts(contacts);
    } finally {
      setIsLoadingContacts(false);
    }
  }, []);

  useEffect(() => {
    if (session?.userId) {
      loadContacts(session.userId);
    }
  }, [session?.userId, loadContacts]);

  // Personalized transaction-pattern engine (apps/api/app/services/
  // user_pattern_trainer.py trains server-side; this is the missing
  // "predictions actually run on-device" half — see user-pattern-
  // service.ts's docstring). Starts syncing the moment a user session
  // exists, and again on every app foreground, matching the "evaluated
  // when an active user opens the app" trigger the engine expects.
  useEffect(() => {
    if (!session?.userId) return;
    return UserPatternService.registerForegroundSync(session.userId);
  }, [session?.userId]);

  // Keeps the on-device device_risk signal (ml/local-device-risk.ts) fresh:
  // "is this device already registered to me" only changes when a real
  // transaction registers it server-side, so re-checking on every
  // foreground (same trigger as the pattern engine above) is enough —
  // payment-service.ts's evaluatePaymentLocal() only ever reads the cache,
  // never blocks on this network call itself.
  useEffect(() => {
    if (!session?.userId) return;
    let previous: AppStateStatus = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (previous !== "active" && next === "active") {
        void syncDeviceCheck(session.userId);
      }
      previous = next;
    });
    void syncDeviceCheck(session.userId);
    return () => subscription.remove();
  }, [session?.userId]);

  const addContact = useCallback(
    async (
      userId: number,
      contact: Omit<TrustedContact, "id" | "addedAt">
    ): Promise<{ success: boolean; error?: string }> => {
      // Optimistic insert: show the new contact immediately under a
      // temporary id so the screen feels instant. Reconciled with the
      // server's real record on success, or rolled back on failure.
      const tempId = `temp-${Date.now()}`;
      const optimisticContact: TrustedContact = {
        ...contact,
        id: tempId,
        addedAt: new Date().toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }),
      };
      setTrustedContacts((prev) => [...prev, optimisticContact]);

      const res = await GuardianService.addTrustedContact(userId, contact);
      if (res.success && res.contact) {
        const confirmed = res.contact;
        setTrustedContacts((prev) => prev.map((c) => (c.id === tempId ? confirmed : c)));
        return { success: true };
      }

      // Roll back the optimistic insert — the server never confirmed it.
      setTrustedContacts((prev) => prev.filter((c) => c.id !== tempId));
      return { success: false, error: res.error || "Failed to add trusted contact" };
    },
    []
  );

  const removeContact = useCallback(
    async (userId: number, contactId: string): Promise<{ success: boolean; error?: string }> => {
      // Optimistic delete: remove immediately, but remember the contact and
      // its position so a failed server call can be undone in place.
      const removedIndex = trustedContacts.findIndex((c) => c.id === contactId);
      const removedContact = removedIndex >= 0 ? trustedContacts[removedIndex] : undefined;
      setTrustedContacts((prev) => prev.filter((c) => c.id !== contactId));

      const res = await GuardianService.removeTrustedContact(userId, contactId);
      if (!res.success) {
        if (removedContact) {
          setTrustedContacts((prev) => {
            const next = [...prev];
            const insertAt = Math.min(removedIndex, next.length);
            next.splice(insertAt < 0 ? next.length : insertAt, 0, removedContact);
            return next;
          });
        }
        return { success: false, error: res.error || "Failed to remove trusted contact" };
      }
      return { success: true };
    },
    [trustedContacts]
  );

  const syncActiveRequestForTransaction = useCallback(
    async (tx: UserTransaction) => {
      const numTxnId = parseInt(tx.id, 10);
      if (isNaN(numTxnId)) return;

      // DO NOT call createRequest here! Opening a card must NEVER trigger Guardian approval.
      const dto = await GuardianService.getRequestByTransactionId(numTxnId);

      if (dto && dto.outcome === "PENDING") {
        const request = toGuardianRequest(dto, {
          merchant: tx.merchant,
          paymentMethod: tx.paymentMethod,
          riskLevel: tx.riskLevel,
        });

        const expiresAtMs = request.expiresAt;
        const currentRem = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));

        if (currentRem <= 0) {
          resolvedRef.current = true;
          clearTimers();
          setActiveRequest({ ...request, status: "EXPIRED", resolvedAt: Date.now() });
          PaymentService.updateTransactionStatus(tx.id, "Blocked", "GUARDIAN_TIMEOUT");
          setPaymentOutcome("EXPIRED");
          setCountdown(0);
          return;
        }

        clearTimers();
        resolvedRef.current = false;
        setActiveRequest(request);
        setCountdown(currentRem);
        setPaymentOutcome(null);

        countdownIntervalRef.current = setInterval(() => {
          const rem = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
          setCountdown(rem);
          if (rem <= 0) {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
            }
            resolvedRef.current = true;
            clearTimers();
            setActiveRequest((prev) => (prev ? { ...prev, status: "EXPIRED", resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(tx.id, "Blocked", "GUARDIAN_TIMEOUT");
            setPaymentOutcome("EXPIRED");
            setNotificationBadge(0);
            setApprovalCard(null);
          }
        }, 1000);

        activePollHolderRef.current = setInterval(async () => {
          const latest = await GuardianService.getRequest(dto.id);
          if (!latest || resolvedRef.current) return;

          if (latest.outcome && latest.outcome !== "PENDING") {
            resolvedRef.current = true;
            clearTimers();
            const finalStatus: GuardianStatus = latest.outcome === "APPROVED" ? "APPROVED" : "REJECTED";
            setActiveRequest((prev) => (prev ? { ...prev, status: finalStatus, resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(
              tx.id,
              latest.outcome === "APPROVED" ? "Approved by you" : "Blocked",
              latest.outcome === "APPROVED" ? "GUARDIAN_APPROVED" : "GUARDIAN_REJECTED"
            );
            setPaymentOutcome(latest.outcome === "APPROVED" ? "APPROVED" : "REJECTED");
            setNotificationBadge(0);
            setApprovalCard(null);
            return;
          }

          const rem = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
          if (rem <= 0 || latest.remainingSeconds <= 0) {
            resolvedRef.current = true;
            clearTimers();
            setActiveRequest((prev) => (prev ? { ...prev, status: "EXPIRED", resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(tx.id, "Blocked", "GUARDIAN_TIMEOUT");
            setPaymentOutcome("EXPIRED");
            setNotificationBadge(0);
            setApprovalCard(null);
          }
        }, POLL_INTERVAL_MS);
      } else if (dto && (dto.outcome === "TIMEOUT" || dto.outcome === "REJECTED" || dto.remainingSeconds <= 0)) {
        clearTimers();
        const request = toGuardianRequest(dto, {
          merchant: tx.merchant,
          paymentMethod: tx.paymentMethod,
          riskLevel: tx.riskLevel,
        });
        setActiveRequest({ ...request, status: "EXPIRED" });
        setCountdown(0);
        setPaymentOutcome("EXPIRED");
      }
    },
    [clearTimers]
  );

  const initiateGuardianRequest = useCallback(
    async (tx: UserTransaction) => {
      // Only HIGH risk transactions may enter the HIGH-risk Guardian flow
      const isHigh = (tx.riskLevel || getRiskLevelFromScore(tx.riskScore)) === "HIGH";
      if (!isHigh) return;

      if (!isTrustedFeatureEnabled || trustedContacts.length === 0) return;

      if (isInitiatingRef.current) return;

      if (activeRequest && activeRequest.status === "PENDING" && String(activeRequest.transactionId) === String(tx.id)) {
        return;
      }

      if (
        tx.canonicalStatus === "GUARDIAN_APPROVED" ||
        tx.canonicalStatus === "GUARDIAN_REJECTED" ||
        tx.canonicalStatus === "GUARDIAN_TIMEOUT" ||
        isTransactionTerminal(tx)
      ) {
        return;
      }

      isInitiatingRef.current = true;
      try {
        clearTimers();
        resolvedRef.current = false;

        const txnId = parseInt(tx.id, 10);
        if (isNaN(txnId)) return;

        let contactId = trustedContacts[0]?.id ? parseInt(trustedContacts[0].id, 10) : undefined;
        const res = await GuardianService.createRequest(txnId, contactId);
        if (!res.success || !res.request) {
          // If already pending or another client started it, sync existing request
          await syncActiveRequestForTransaction(tx);
          return;
        }

        PaymentService.updateTransactionStatus(tx.id, "Held", "AWAITING_GUARDIAN");

        const request = toGuardianRequest(res.request, {
          merchant: tx.merchant,
          paymentMethod: tx.paymentMethod,
          riskLevel: tx.riskLevel,
        });

        const expiresAtMs = request.expiresAt;
        const initialRemaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));

        setActiveRequest(request);
        setCountdown(initialRemaining);
        setPaymentOutcome(null);

        countdownIntervalRef.current = setInterval(() => {
          const rem = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
          setCountdown(rem);
          if (rem <= 0) {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
              countdownIntervalRef.current = null;
            }
            resolvedRef.current = true;
            clearTimers();
            setActiveRequest((prev) => (prev ? { ...prev, status: "EXPIRED", resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(tx.id, "Blocked", "GUARDIAN_TIMEOUT");
            setPaymentOutcome("EXPIRED");
            setNotificationBadge(0);
            setApprovalCard(null);
          }
        }, 1000);

        activePollHolderRef.current = setInterval(async () => {
          const latest = await GuardianService.getRequest(res.request!.id);
          if (!latest || resolvedRef.current) return;

          if (latest.outcome && latest.outcome !== "PENDING") {
            resolvedRef.current = true;
            clearTimers();
            const finalStatus: GuardianStatus = latest.outcome === "APPROVED" ? "APPROVED" : "REJECTED";
            setActiveRequest((prev) => (prev ? { ...prev, status: finalStatus, resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(
              tx.id,
              latest.outcome === "APPROVED" ? "Approved by you" : "Blocked",
              latest.outcome === "APPROVED" ? "GUARDIAN_APPROVED" : "GUARDIAN_REJECTED"
            );
            setPaymentOutcome(latest.outcome === "APPROVED" ? "APPROVED" : "REJECTED");
            setNotificationBadge(0);
            setApprovalCard(null);
            return;
          }

          const rem = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
          if (rem <= 0 || latest.remainingSeconds <= 0) {
            resolvedRef.current = true;
            clearTimers();
            setActiveRequest((prev) => (prev ? { ...prev, status: "EXPIRED", resolvedAt: Date.now() } : null));
            PaymentService.updateTransactionStatus(tx.id, "Blocked", "GUARDIAN_TIMEOUT");
            setPaymentOutcome("EXPIRED");
            setNotificationBadge(0);
            setApprovalCard(null);
          }
        }, POLL_INTERVAL_MS);
      } finally {
        isInitiatingRef.current = false;
      }
    },
    [activeRequest, clearTimers, isTrustedFeatureEnabled, syncActiveRequestForTransaction, trustedContacts]
  );

  const respondToRequest = useCallback(
    async (
      requestId: string,
      decision: "APPROVED" | "REJECTED"
    ): Promise<{ success: boolean; error?: string }> => {
      const numId = parseInt(requestId, 10);
      if (isNaN(numId)) {
        return { success: false, error: "Invalid request identifier." };
      }

      const res =
        decision === "APPROVED"
          ? await GuardianService.approve(numId)
          : await GuardianService.reject(numId);

      if (!res.success) {
        return { success: false, error: res.error || `Failed to ${decision.toLowerCase()} request.` };
      }

      if (!resolvedRef.current || activeRequest?.id === requestId) {
        resolvedRef.current = true;
        clearTimers();
        setActiveRequest((prev) =>
          prev && prev.id === requestId
            ? { ...prev, status: decision, resolvedAt: Date.now() }
            : prev
        );
      }

      // Always update central payment state for the target transaction
      const targetReq =
        activeRequest?.id === requestId
          ? activeRequest
          : pendingRequests.find((r) => r.id === requestId);
      if (targetReq && targetReq.transactionId) {
        PaymentService.updateTransactionStatus(
          String(targetReq.transactionId),
          decision === "APPROVED" ? "Approved by you" : "Blocked",
          decision === "APPROVED" ? "GUARDIAN_APPROVED" : "GUARDIAN_REJECTED"
        );
      }
      setPaymentOutcome(decision);

      // Remove from pendingRequests and update notification badge
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      setNotificationBadge((prev) => Math.max(0, prev - 1));
      
      // Ensure resolved request ID is remembered so it never alerts again
      knownPendingIdsRef.current.add(requestId);

      return { success: true };
    },
    [activeRequest, clearTimers, pendingRequests]
  );


  const clearPaymentOutcome = useCallback(() => {
    setPaymentOutcome(null);
    setActiveRequest(null);
    setCountdown(HOLD_SECONDS);
    resolvedRef.current = false;
  }, []);

  const clearNotificationBadge = useCallback(() => setNotificationBadge(0), []);

  const openApprovalCard = useCallback((request: GuardianRequest) => {
    setApprovalCard(request);
    setNotificationBadge(0);
  }, []);

  const closeApprovalCard = useCallback(() => {
    setApprovalCard(null);
  }, []);

  return (
    <GuardianContext.Provider
      value={{
        trustedContacts,
        isLoadingContacts,
        loadContacts,
        addContact,
        removeContact,
        isTrustedFeatureEnabled,
        toggleTrustedFeature,
        setTrustedFeatureEnabled,
        activeRequest,
        pendingRequests,
        countdown,
        paymentOutcome,
        initiateGuardianRequest,
        syncActiveRequestForTransaction,
        respondToRequest,
        clearPaymentOutcome,
        notificationBadge,
        clearNotificationBadge,
        approvalCard,
        openApprovalCard,
        closeApprovalCard,
      }}
    >
      {children}
    </GuardianContext.Provider>
  );
};

export const useGuardian = (): GuardianContextType => useContext(GuardianContext);
