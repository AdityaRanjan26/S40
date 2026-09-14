import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
  Animated,
  Easing,
} from "react-native";
import { useRoute, useIsFocused } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing, radii, shadows } from "../theme/layout";
import { Header } from "../components/common/Header";
import { Card } from "../components/common/Card";
import { TextInput } from "../components/common/TextInput";
import { StatusBadge } from "../components/common/StatusBadge";
import { RiskGauge } from "../components/common/RiskGauge";
import { StaggerRevealCard } from "../components/common/StaggerRevealCard";
import { AnimatedAmount } from "../components/common/AnimatedAmount";
import { AiScanBanner } from "../components/common/AiScanBanner";
import { RiskContributionBar, ContributionItem } from "../components/common/RiskContributionBar";
import { Button } from "../components/common/Button";
import { FloatingToast, ToastConfig } from "../components/common/FloatingToast";
import { ChoosePaymentAppModal } from "../components/payment/ChoosePaymentAppModal";
import { QrScannerModal } from "../components/payment/QrScannerModal";
import { PaymentSourceSelector } from "../components/payment/PaymentSourceSelector";
import { UpiIdPaymentForm } from "../components/payment/UpiIdPaymentForm";
import { MobilePaymentForm } from "../components/payment/MobilePaymentForm";
import { QrPaymentInput } from "../components/payment/QrPaymentInput";
import { PaymentRequestList } from "../components/payment/PaymentRequestList";
import { PreparedPaymentCard } from "../components/payment/PreparedPaymentCard";
import { PaymentRequestService, IncomingPaymentRequest } from "../services/payment-request-service";
import {
  PaymentInputSource,
  PreparedPaymentDraft,
  PaymentRiskEvaluationState,
  GuardianEscalationState,
} from "../types/transaction";
import { Camera } from "expo-camera";
import * as Contacts from "expo-contacts";
import { applyScannedQrToForm } from "../utils/qr-scanner-helper";
import { applySelectedContactToForm } from "../utils/contact-picker-helper";
import { getRecipientType, isRecipientValid, RecipientType } from "../utils/recipient-type";
import { resolveRecipient } from "../services/recipient-resolution-service";
import { useAuth } from "../context/AuthContext";
import { useGuardian } from "../context/GuardianContext";
import { GuardianService } from "../services/guardian-service";
import { BiometricService } from "../services/biometric-service";
import {
  PaymentService,
  UserTransaction,
  UserPaymentOverview,
  EMPTY_PAYMENT_OVERVIEW,
  isTransactionTerminal,
  isTransactionPayable,
  PaymentDraft,
  PaymentWorkflowStage,
  validatePaymentAuthorizationStage,
  validatePaymentSubmissionStage,
  validatePaymentCompletionStage,
  assertNotEvaluationStage,
} from "../services/payment-service";
import {
  getRiskLevelFromScore,
  getStatusBadgeProps,
  validateAndLogRiskState,
  RiskLevel,
} from "../utils/risk-scoring";

export interface EvaluationDisplayResult {
  evaluation_id?: string;
  transaction_id?: string;
  stage: PaymentWorkflowStage;
  riskLevel?: RiskLevel;
  riskScore?: number;
  decision?: string;
  reasons?: string[];
  summary?: string;
  message?: string;
  status?: string;
  transactionStatus?: string;
  guardian_required?: boolean;
  verification_status?: string;
  recipient?: {
    raw_input: string;
    normalized: string;
    recipient_type: string;
    display_name?: string | null;
    resolution_status: string;
  };
  amount?: number;
  note?: string;
  timestamp?: string;
  disclaimer?: string;
  isAuthorized: false;
  isApproved: false;
  isCompleted: false;
  isSubmitted: false;
}


const NewPaymentHighlightCard: React.FC<{
  children: React.ReactNode;
  isNew: boolean;
}> = ({ children, isNew }) => {
  const pulseAnim = useRef(new Animated.Value(isNew ? 0 : 1)).current;

  useEffect(() => {
    if (isNew) {
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 350,
          easing: Easing.out(Easing.back(1.5)),
          useNativeDriver: false,
        }),
        Animated.delay(1200),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]).start();
    }
  }, [isNew, pulseAnim]);

  if (!isNew) return <>{children}</>;

  const borderColor = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.border, colors.brand],
  });

  const scale = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.015],
  });

  return (
    <Animated.View
      style={{
        transform: [{ scale }],
        borderWidth: 1,
        borderColor,
        borderRadius: radii.md,
      }}
    >
      {children}
    </Animated.View>
  );
};

export const PaymentsScreen: React.FC = () => {
  const { width } = useWindowDimensions();
  const route = useRoute<any>();
  const { session } = useAuth();
  const {
    activeRequest,
    countdown,
    paymentOutcome,
    clearPaymentOutcome,
    initiateGuardianRequest,
    syncActiveRequestForTransaction,
    isTrustedFeatureEnabled,
    trustedContacts,
  } = useGuardian();

  const isFocused = useIsFocused();
  const [overview, setOverview] = useState<UserPaymentOverview>(EMPTY_PAYMENT_OVERVIEW);
  const [transactions, setTransactions] = useState<UserTransaction[]>([]);
  const [filter, setFilter] = useState<"all" | "review" | "safe">("all");
  const [selectedTx, setSelectedTx] = useState<UserTransaction | null>(null);
  const [awaitingGuardian, setAwaitingGuardian] = useState(false);

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActing, setIsActing] = useState<boolean>(false);
  const [isAuthorizing, setIsAuthorizing] = useState<boolean>(false);
  const [isStartingGuardian, setIsStartingGuardian] = useState<boolean>(false);

  // Risk Score Result Reveal & List Stagger Animation States (run once on first view)
  const hasPlayedRevealRef = useRef(false);
  const hasPlayedListStaggerRef = useRef(false);
  const hasInitialSelectionDoneRef = useRef(false);
  const [isAiScanning, setIsAiScanning] = useState<boolean>(true);

  // New Payment Detection Tracking
  const [newlyDetectedIds, setNewlyDetectedIds] = useState<Set<string>>(new Set());
  const knownTxIdsRef = useRef<Set<string>>(new Set());

  // AVARAN PAY Quick Payment Entry Form (Frontend-only state)
  const [entryRecipient, setEntryRecipient] = useState<string>("");
  const [entryAmount, setEntryAmount] = useState<string>("");
  const [entryNote, setEntryNote] = useState<string>("");
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [isPersistingPayment, setIsPersistingPayment] = useState<boolean>(false);
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(null);
  const [evaluationResult, setEvaluationResult] = useState<EvaluationDisplayResult | null>(null);
  const [isScannerVisible, setIsScannerVisible] = useState<boolean>(false);
  const formVersionRef = useRef<number>(0);

  // Payment Input Phase states
  const [paymentSource, setPaymentSource] = useState<PaymentInputSource>("UPI_ID");
  const [preparedDraft, setPreparedDraft] = useState<PreparedPaymentDraft | null>(null);
  const [scannedQrPayload, setScannedQrPayload] = useState<string>("");
  const [pendingRequestsCount, setPendingRequestsCount] = useState<number>(0);
  const [evaluationState, setEvaluationState] = useState<PaymentRiskEvaluationState>({
    status: "IDLE",
  });
  const [guardianState, setGuardianState] = useState<GuardianEscalationState>({
    status: "IDLE",
  });
  const isRequestingGuardianRef = useRef<boolean>(false);

  // Fetch pending payment requests count for badge
  useEffect(() => {
    PaymentRequestService.getPendingRequests()
      .then((res) => {
        if (!res.error && res.requests) {
          setPendingRequestsCount(res.requests.length);
        }
      })
      .catch(() => {});
  }, []);

  // Check TTL expiration of active risk evaluation and associated Guardian escalation
  useEffect(() => {
    if (evaluationState.status !== "EVALUATED" || !evaluationState.expiresAt) return;

    const expiresTime = new Date(evaluationState.expiresAt).getTime();
    const timeUntilExpiry = expiresTime - Date.now();

    if (timeUntilExpiry <= 0) {
      setEvaluationState((prev) =>
        prev.status === "EVALUATED" ? { ...prev, status: "EXPIRED" } : prev
      );
      setGuardianState((prev) =>
        prev.status !== "IDLE" ? { ...prev, status: "EXPIRED" } : prev
      );
      return;
    }

    const timer = setTimeout(() => {
      setEvaluationState((prev) =>
        prev.status === "EVALUATED" ? { ...prev, status: "EXPIRED" } : prev
      );
      setGuardianState((prev) =>
        prev.status !== "IDLE" ? { ...prev, status: "EXPIRED" } : prev
      );
    }, timeUntilExpiry);

    return () => clearTimeout(timer);
  }, [evaluationState.status, evaluationState.expiresAt]);

  const handleSelectPaymentSource = (source: PaymentInputSource) => {
    setPaymentSource(source);
    setPreparedDraft(null);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
  };

  const handlePreparePayment = (params: {
    recipient: string;
    amount: number;
    note?: string;
    recipientName?: string;
    qrPayload?: string;
    requestId?: string;
  }) => {
    const res = PaymentService.preparePaymentInput({
      source: paymentSource,
      recipient: params.recipient,
      amount: params.amount,
      note: params.note,
      recipientName: params.recipientName,
      qrPayload: params.qrPayload,
      requestId: params.requestId,
    });

    if (!res.success) {
      showToast(res.error || "Failed to prepare payment", "warning");
      return;
    }

    setPreparedDraft(res.draft);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
    setEntryRecipient(res.draft.recipient);
    setEntryAmount(String(res.draft.amount));
    if (res.draft.note) setEntryNote(res.draft.note);
    showToast("✓ Payment details prepared successfully", "success");
  };

  const handleEvaluatePreparedRisk = async (draftToEvaluate?: PreparedPaymentDraft) => {
    const draft = draftToEvaluate || preparedDraft;
    if (!draft) return;

    setEvaluationState({ status: "ANALYZING" });
    setGuardianState({ status: "IDLE" });
    const currentVer = ++formVersionRef.current;

    try {
      const res = await PaymentService.evaluatePreparedPayment(draft, session?.userId);

      // Guard against race conditions if user modified form in flight
      if (formVersionRef.current !== currentVer) return;

      if (!res.success) {
        setEvaluationState({
          status: "ERROR",
          error: res.error || "Risk evaluation failed. Please check network or try again.",
        });
        setGuardianState({ status: "IDLE" });
        showToast(res.error || "Risk evaluation failed", "warning");
        return;
      }

      const evalData = res.data;
      const nowIso = new Date().toISOString();
      const expiresAt = evalData.expires_at;

      // Defensive check if already expired
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
        setEvaluationState({
          status: "EXPIRED",
          data: evalData,
          evaluatedAt: nowIso,
          expiresAt,
        });
        setGuardianState({ status: "EXPIRED" });
        showToast("Risk evaluation has expired", "warning");
        return;
      }

      setEvaluationState({
        status: "EVALUATED",
        data: evalData,
        evaluatedAt: nowIso,
        expiresAt,
      });

      // Authoritative Guardian Escalation logic based on backend evaluation
      if (evalData.guardian_required) {
        setGuardianState({
          status: "APPROVAL_REQUIRED",
        });
      } else {
        setGuardianState({
          status: "AUTHORIZATION_READY",
        });
      }

      showToast(`Evaluation complete: ${evalData.risk_level} risk`, "info");
    } catch (err: any) {
      if (formVersionRef.current !== currentVer) return;
      setEvaluationState({
        status: "ERROR",
        error: err?.message || "Unexpected evaluation error",
      });
      setGuardianState({ status: "IDLE" });
      showToast(err?.message || "Unexpected evaluation error", "warning");
    }
  };

  const handleRequestGuardianApproval = async () => {
    if (!preparedDraft || !evaluationState.data) return;
    if (isRequestingGuardianRef.current) return; // Prevent duplicate requests

    isRequestingGuardianRef.current = true;
    setGuardianState({ status: "REQUESTING_APPROVAL" });
    const currentVer = ++formVersionRef.current;

    try {
      const res = await GuardianService.requestEvaluationGuardianApproval({
        evaluationId: evaluationState.data.evaluation_id,
        userId: session?.userId || 1,
        amount: preparedDraft.amount,
        recipient: preparedDraft.recipient,
        riskScore: evaluationState.data.risk_score,
        riskLevel: evaluationState.data.risk_level,
        reasons: evaluationState.data.plain_language_reasons || [],
      });

      if (formVersionRef.current !== currentVer) return; // Race-condition guard

      if (!res.success) {
        setGuardianState({
          status: "ERROR",
          error: res.error,
          blockerNotice: res.blockerNotice,
        });
        showToast(res.error || "Guardian escalation unavailable", "warning");
        return;
      }

      setGuardianState({
        status: "APPROVAL_PENDING",
        requestId: res.requestId,
        expiresAt: res.expiresAt,
        remainingSeconds: res.remainingSeconds,
      });

      showToast("✓ Guardian approval request dispatched", "info");
    } catch (err: any) {
      if (formVersionRef.current !== currentVer) return;
      setGuardianState({
        status: "ERROR",
        error: err?.message || "Failed to dispatch Guardian request",
      });
      showToast(err?.message || "Failed to dispatch Guardian request", "warning");
    } finally {
      isRequestingGuardianRef.current = false;
    }
  };

  // Bridges the "Payment Intake" advisory flow (preparedDraft + evaluationState
  // + guardianState) into the real transaction/payment-app-launch flow below —
  // handleEvaluateAndPay's older single-step flow did this inline via
  // persistPaymentDraftCard + setSelectedTx, but the newer two-step
  // prepare/analyze UI (PreparedPaymentCard/GuardianEscalationCard) never
  // wired an equivalent "proceed" step, leaving AUTHORIZATION_READY as a dead
  // end with no way to actually pay. This restores that final step.
  const handleProceedToPayment = async () => {
    if (isPersistingPayment) return;
    if (!preparedDraft || !evaluationState.data) return;

    setIsPersistingPayment(true);
    try {
      const persistRes = await PaymentService.persistPaymentDraftCard(
        evaluationState.data,
        preparedDraft,
        session?.userId || 1
      );

      if (!persistRes.success || !persistRes.transaction) {
        showToast(persistRes.error || "Failed to create payment. Please try again.", "warning");
        return;
      }

      const persistedTx = persistRes.transaction;
      setSelectedTx(persistedTx);
      setPreparedDraft(null);
      setEvaluationState({ status: "IDLE" });
      setGuardianState({ status: "IDLE" });
      setEntryRecipient("");
      setEntryAmount("");
      setEntryNote("");
      setScannedQrPayload("");

      await loadPayments();
      showToast("Payment created. Choose how to complete it below.", "success");
    } catch (err: any) {
      showToast(err?.message || "Failed to create payment", "warning");
    } finally {
      setIsPersistingPayment(false);
    }
  };

  const handleAcceptPaymentRequest = (req: IncomingPaymentRequest) => {
    setPaymentSource("PAYMENT_REQUEST");
    handlePreparePayment({
      recipient: req.upiId,
      amount: req.amount,
      note: req.note,
      recipientName: req.requesterName,
      requestId: req.id,
    });
  };

  const handleRecipientChange = (value: string) => {
    setEntryRecipient(value);
    setPaymentDraft(null);
    setEvaluationResult(null);
    setPreparedDraft(null);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
    formVersionRef.current += 1;
  };

  const handleAmountChange = (value: string) => {
    setEntryAmount(value);
    setPaymentDraft(null);
    setEvaluationResult(null);
    setPreparedDraft(null);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
    formVersionRef.current += 1;
  };

  const handleNoteChange = (value: string) => {
    setEntryNote(value);
    setPaymentDraft(null);
    setEvaluationResult(null);
    setPreparedDraft(null);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
    formVersionRef.current += 1;
  };

  // Pure recipient-type detection for entry input (local, non-disruptive, preserves input exactly)
  const recipientType: RecipientType = useMemo(() => getRecipientType(entryRecipient), [entryRecipient]);

  const handleOpenScanner = async () => {
    try {
      const permission = await Camera.requestCameraPermissionsAsync();
      if (!permission.granted) {
        showToast("Camera permission is required to scan QR codes", "warning");
        return;
      }
      setIsScannerVisible(true);
    } catch {
      showToast("Camera permission is required to scan QR codes", "warning");
    }
  };

  const handleQrScan = (rawPayload: string) => {
    setIsScannerVisible(false);
    const result = applyScannedQrToForm(
      { recipient: entryRecipient, amount: entryAmount, note: entryNote },
      rawPayload
    );

    if (!result.success) {
      showToast(result.error, "warning");
      return;
    }

    setScannedQrPayload(rawPayload);
    setPaymentSource("QR");
    setEntryRecipient(result.updatedForm.recipient);
    if (result.updatedForm.amount) {
      setEntryAmount(result.updatedForm.amount);
    }
    if (result.updatedForm.note) {
      setEntryNote(result.updatedForm.note);
    }
    setPaymentDraft(null);
    setEvaluationResult(null);
    setPreparedDraft(null);
    setEvaluationState({ status: "IDLE" });
    setGuardianState({ status: "IDLE" });
    formVersionRef.current += 1;
    showToast("QR code scanned successfully", "success");
  };

  const handlePickContact = async () => {
    try {
      const permission = await Contacts.requestPermissionsAsync();
      if (!permission.granted) {
        showToast("Contacts permission is required to select a contact", "warning");
        return;
      }

      let contact: any = null;
      if (typeof (Contacts as any).Contact?.presentPicker === "function") {
        contact = await (Contacts as any).Contact.presentPicker();
      } else if (typeof (Contacts as any).presentContactPickerAsync === "function") {
        contact = await (Contacts as any).presentContactPickerAsync();
      }

      if (!contact) {
        return;
      }

      if (!contact.phones && !contact.phoneNumbers && typeof contact.getPhones === "function") {
        try {
          contact = {
            ...contact,
            phones: await contact.getPhones(),
          };
        } catch {
          // fallback to raw contact
        }
      }

      const result = applySelectedContactToForm(
        { recipient: entryRecipient, amount: entryAmount, note: entryNote },
        contact
      );

      if (!result.success) {
        showToast(result.error, "warning");
        return;
      }

      setPaymentSource("MOBILE");
      setEntryRecipient(result.updatedForm.recipient);
      setPaymentDraft(null);
      setEvaluationResult(null);
      setPreparedDraft(null);
      setEvaluationState({ status: "IDLE" });
      setGuardianState({ status: "IDLE" });
      formVersionRef.current += 1;
      showToast("Contact selected successfully", "success");
    } catch {
      showToast("Contacts permission is required to select a contact", "warning");
    }
  };

  const handleEvaluateAndPay = async () => {
    if (isEvaluating) return;

    if (!isRecipientValid(entryRecipient)) {
      showToast("Enter a valid UPI ID or mobile number", "warning");
      return;
    }

    const parsedAmount = entryAmount.trim() === "" ? NaN : Number(entryAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showToast("Enter a valid amount greater than zero", "warning");
      return;
    }

    const draftResult = PaymentService.createPaymentDraft({
      recipient: entryRecipient.trim(),
      amount: parsedAmount,
      note: entryNote.trim() || undefined,
    });

    if (!draftResult.success) {
      showToast(draftResult.error, "warning");
      return;
    }

    const draft = draftResult.draft;
    setIsEvaluating(true);
    setPaymentDraft(null);
    setEvaluationResult(null);
    const evaluationVersion = ++formVersionRef.current;

    try {
      const evalResult = await PaymentService.evaluatePayment({
        recipient: draft.recipient,
        amount: draft.amount,
        note: draft.note,
        user_id: session?.userId,
      });

      // Race-condition guard: if form inputs were modified while evaluation was in flight, discard
      if (formVersionRef.current !== evaluationVersion) {
        return;
      }

      if (!evalResult.success) {
        showToast(evalResult.error || "Unable to evaluate payment draft", "warning");
        return;
      }

      setPaymentDraft(draft);
      const evalData = evalResult.data;
      const derivedRiskLevel: RiskLevel = evalData.risk_level;

      // Part 2: Persist the successful evaluation as an advisory payment card
      const persistRes = await PaymentService.persistPaymentDraftCard(
        evalData,
        draft,
        session?.userId || 1
      );

      // Race-condition guard: check again after async persistence
      if (formVersionRef.current !== evaluationVersion) {
        return;
      }

      const persistedTx = persistRes.transaction;

      setEvaluationResult({
        evaluation_id: evalData.evaluation_id || persistedTx?.evaluationId,
        transaction_id: persistedTx ? String(persistedTx.id) : undefined,
        stage: "EVALUATION_COMPLETED",
        riskLevel: derivedRiskLevel,
        riskScore: evalData.risk_score,
        decision: evalData.decision,
        reasons: evalData.plain_language_reasons,
        recipient: evalData.recipient,
        amount: evalData.amount ?? draft.amount,
        note: evalData.note ?? draft.note,
        timestamp: evalData.timestamp,
        disclaimer: evalData.disclaimer,
        status: evalData.decision,
        transactionStatus: persistedTx?.status || "Held",
        guardian_required: Boolean(evalData.guardian_required || persistedTx?.guardianRequired),
        verification_status: evalData.recipient?.display_name ? "VERIFIED" : "UNVERIFIED",
        isAuthorized: false,
        isApproved: false,
        isCompleted: false,
        isSubmitted: false,
      });

      // PART 1: Clear form inputs so the user can start a new payment immediately.
      // The evaluation result card (evaluationResult state) is NOT cleared — it stays
      // visible so the user can review the risk score, reasons, and action buttons.
      setEntryRecipient("");
      setEntryAmount("");
      setEntryNote("");

      // Automatically select the newly persisted card if available
      if (persistedTx) {
        setSelectedTx(persistedTx);
      }

      await loadPayments();
      showToast(`Evaluation complete: ${derivedRiskLevel} risk`, "info");
    } catch (err: any) {
      showToast(err?.message || "Unable to evaluate payment draft", "warning");

    } finally {
      setIsEvaluating(false);
    }
  };

  // Mark list stagger as completed after initial reveal
  useEffect(() => {
    if (isFocused && !isLoading && !hasPlayedListStaggerRef.current) {
      const timer = setTimeout(() => {
        hasPlayedListStaggerRef.current = true;
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isLoading]);

  // Trigger the reveal animation when Payments page is first focused and data is ready
  useEffect(() => {
    if (isFocused && !isLoading && selectedTx && !hasPlayedRevealRef.current) {
      const timer = setTimeout(() => {
        hasPlayedRevealRef.current = true;
      }, 2200);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isLoading, selectedTx]);

  // Modals & Toast State
  const [toastConfig, setToastConfig] = useState<ToastConfig | null>(null);
  const [isChooseAppModalVisible, setIsChooseAppModalVisible] = useState<boolean>(false);

  const showToast = (message: string, type: "info" | "success" | "warning" = "success") => {
    setToastConfig({ message, type });
  };

  const loadPayments = useCallback(async () => {
    try {
      const userId = session?.userId || 1;
      const [ovData, txnData] = await Promise.all([
        PaymentService.getOverview(userId),
        PaymentService.getTransactions(userId, "all"),
      ]);
      setOverview(ovData);
      setTransactions(txnData.items);

      // Auto-select on initial load only once (does not override user's manual close)
      if (!hasInitialSelectionDoneRef.current && txnData.items.length > 0) {
        hasInitialSelectionDoneRef.current = true;
        txnData.items.forEach((t) => knownTxIdsRef.current.add(t.id));

        const requestedId = route.params?.selectedTxId;
        if (requestedId) {
          const found = txnData.items.find(
            (t) => t.id === requestedId || String(t.id) === String(requestedId)
          );
          if (found) {
            setSelectedTx(found);
            return;
          }
        }

        const firstRisk = txnData.items.find(
          (t) => t.status === "Risk detected" || t.status === "Held"
        );
        if (firstRisk) setSelectedTx(firstRisk);
        else setSelectedTx(txnData.items[0]);
      } else if (knownTxIdsRef.current.size > 0) {
        // Detect newly added transaction
        const brandNew = new Set<string>();
        txnData.items.forEach((t) => {
          if (!knownTxIdsRef.current.has(t.id)) {
            brandNew.add(t.id);
            knownTxIdsRef.current.add(t.id);
          }
        });
        if (brandNew.size > 0) {
          setNewlyDetectedIds(brandNew);
          setTimeout(() => setNewlyDetectedIds(new Set()), 3000);
        }
      }
    } catch {
      // Fallback
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [session?.userId, route.params?.selectedTxId]);

  useEffect(() => {
    loadPayments();

    // Subscribe to real-time updates from centralized PaymentService
    const unsubscribe = PaymentService.subscribe((updatedOverview, updatedTxns) => {
      setOverview(updatedOverview);
      setTransactions(updatedTxns);

      // Detect newly added transactions in real-time stream
      if (knownTxIdsRef.current.size > 0) {
        const brandNew = new Set<string>();
        updatedTxns.forEach((t) => {
          if (!knownTxIdsRef.current.has(t.id)) {
            brandNew.add(t.id);
            knownTxIdsRef.current.add(t.id);
          }
        });
        if (brandNew.size > 0) {
          setNewlyDetectedIds(brandNew);
          setTimeout(() => setNewlyDetectedIds(new Set()), 3000);
        }
      }

      // Keep selectedTx synchronized with latest status or deselect if no longer matching filter
      setSelectedTx((prev) => {
        if (!prev) return null;
        const fresh = updatedTxns.find((t) => t.id === prev.id);
        if (!fresh) return null;

        // If in "review" tab and this item is now completed/approved, auto-shift to next review item or close
        if (
          filter === "review" &&
          (fresh.isCompleted ||
            fresh.status === "Approved by you" ||
            fresh.status === "Safe" ||
            fresh.status === "Completed" ||
            fresh.status === "Blocked" ||
            fresh.status === "Reported")
        ) {
          const nextReview = updatedTxns.find(
            (t) => t.status === "Risk detected" || t.status === "Held"
          );
          return nextReview || null;
        }

        return fresh;
      });
    });

    return unsubscribe;
  }, [loadPayments, filter]);

  // If navigation param selectedTxId changes, switch selection
  useEffect(() => {
    const requestedId = route.params?.selectedTxId;
    if (requestedId) {
      PaymentService.getTransactions(session?.userId || 1, "all").then((data) => {
        const found = data.items.find(
          (t) => t.id === requestedId || String(t.id) === String(requestedId)
        );
        if (found) {
          setSelectedTx(found);
        }
      });
    }
  }, [route.params?.selectedTxId, session?.userId]);

  // Sync active guardian request when viewing an active held/risk transaction (HIGH risk only)
  useEffect(() => {
    const isHigh =
      selectedTx?.riskLevel === "HIGH" ||
      (typeof selectedTx?.riskScore === "number" && (selectedTx?.riskScore ?? 0) >= 61);
    if (
      selectedTx &&
      !selectedTx.isCompleted &&
      isHigh &&
      (selectedTx.status === "Risk detected" || selectedTx.status === "Held")
    ) {
      syncActiveRequestForTransaction(selectedTx);
    }
  }, [selectedTx?.id, selectedTx?.status, selectedTx?.riskLevel, selectedTx?.riskScore, syncActiveRequestForTransaction]);

  // Filtered transactions computed dynamically from centralized state
  const visibleTransactions = useMemo(() => {
    if (filter === "review") {
      return transactions.filter((t) => t.status === "Risk detected" || t.status === "Held");
    }
    if (filter === "safe") {
      return transactions.filter(
        (t) => t.status === "Safe" || t.status === "Approved by you" || t.status === "Completed"
      );
    }
    return transactions;
  }, [transactions, filter]);

  const handleSelectFilter = (newFilter: "all" | "review" | "safe") => {
    setFilter(newFilter);
    let items = transactions;
    if (newFilter === "review") {
      items = transactions.filter((t) => t.status === "Risk detected" || t.status === "Held");
    } else if (newFilter === "safe") {
      items = transactions.filter(
        (t) => t.status === "Safe" || t.status === "Approved by you" || t.status === "Completed"
      );
    }
    if (items.length > 0) {
      setSelectedTx(items[0]);
    }
  };

  // Watch for guardian decision and update UI accordingly
  useEffect(() => {
    if (!paymentOutcome) return;

    if (paymentOutcome === "APPROVED") {
      showToast("✓ Trusted contact approved your payment", "success");
      loadPayments();
    } else if (paymentOutcome === "REJECTED") {
      showToast("⚠ Payment rejected by trusted contact", "warning");
      loadPayments();
    } else if (paymentOutcome === "EXPIRED") {
      showToast("Guardian approval window expired. Payment cancelled.", "info");
      loadPayments();
    }
  }, [paymentOutcome, loadPayments]);

  const onRefresh = () => {
    setIsRefreshing(true);
    loadPayments();
  };

  const handleAuthorize = async (
    txId: string,
    stage?: PaymentWorkflowStage | { stage?: any } | string | null
  ) => {
    if (isAuthorizing || isActing || !selectedTx) return;

    if (stage !== undefined) {
      const validation = validatePaymentAuthorizationStage(stage);
      if (!validation.valid) {
        showToast(validation.error || "Cannot authorize payment from this stage", "warning");
        return;
      }
    }

    setIsAuthorizing(true);
    try {
      const authResult = await BiometricService.authenticate(
        "Verify your identity to authorize high-risk payment"
      );
      if (!authResult.success) {
        setIsAuthorizing(false);
        showToast("Verification was not completed. Your payment remains pending.", "info");
        return;
      }

      const res = await PaymentService.authorizeTransaction(
        txId,
        authResult.isFallback ? "DEVICE_CREDENTIAL" : "BIOMETRIC",
        stage || "PAYMENT_AUTHORIZED"
      );
      setIsAuthorizing(false);

      if (res.success) {
        const updatedSelected: UserTransaction = {
          ...selectedTx,
          authorizationStatus: "AUTHORIZED",
        };
        setSelectedTx(updatedSelected);

        showToast("✓ Identity Verified. Completing your secure payment...", "success");
        await loadPayments();
        setIsChooseAppModalVisible(true);
      } else {
        showToast(res.error || "Authorization failed. Please try again.", "warning");
      }
    } catch {
      setIsAuthorizing(false);
      showToast("Verification error. Your payment remains pending.", "warning");
    }
  };

  const handleConfirm = async (
    txId: string,
    stage?: PaymentWorkflowStage | { stage?: any } | string | null
  ) => {
    if (isActing || isAuthorizing || isStartingGuardian) return;
    if (!selectedTx) return;

    if (stage !== undefined) {
      const validation = assertNotEvaluationStage(stage);
      if (!validation.valid) {
        showToast(validation.error || "Cannot proceed with payment from evaluation stage", "warning");
        return;
      }
    }

    if (isTransactionTerminal(selectedTx)) {
      showToast("This payment has already been completed or finalized", "info");
      return;
    }

    const isHighRisk =
      selectedTx.riskLevel === "HIGH" ||
      (typeof selectedTx.riskScore === "number" && selectedTx.riskScore >= 61);

    let contacts = trustedContacts;
    if (contacts.length === 0 && session?.userId) {
      contacts = await GuardianService.getTrustedContacts(session.userId);
    }

    // High risk with Guardian enabled and contact available: Guardian approval is required
    if (isHighRisk && isTrustedFeatureEnabled && contacts.length > 0) {
      // If already approved by Guardian, proceed with authorization or app selector
      if (selectedTx.canonicalStatus === "GUARDIAN_APPROVED" || selectedTx.status === "Approved by you") {
        if (
          selectedTx.authorizationRequired !== false &&
          selectedTx.authorizationStatus !== "AUTHORIZED"
        ) {
          await handleAuthorize(selectedTx.id);
          return;
        }
        setIsChooseAppModalVisible(true);
        return;
      }

      setIsStartingGuardian(true);
      try {
        setAwaitingGuardian(true);
        await initiateGuardianRequest(selectedTx);
        showToast("Awaiting approval from your Trusted Contact...", "info");
        await loadPayments();
      } finally {
        setIsStartingGuardian(false);
      }
      return;
    }

    // High-Risk without Guardian: Biometric Authorization Check
    if (
      isHighRisk &&
      selectedTx.authorizationRequired !== false &&
      selectedTx.authorizationStatus !== "AUTHORIZED"
    ) {
      await handleAuthorize(selectedTx.id);
      return;
    }

    // Otherwise (low/medium risk or guardian disabled), open payment app selector directly
    setIsChooseAppModalVisible(true);
  };

  const handleReport = async (txId: string) => {
    if (isActing) return;
    if (!selectedTx) return;

    if (selectedTx.status === "Reported") {
      showToast("This transaction has already been reported", "info");
      return;
    }

    setIsActing(true);
    const res = await PaymentService.reportTransaction(txId);
    setIsActing(false);
    if (res.success) {
      showToast("⚠ Fraud report submitted. Payment blocked.", "warning");
      await loadPayments();
    } else {
      showToast(res.error || "Unable to complete this action", "warning");
    }
  };

  const handleCancel = async (txId: string) => {
    if (isActing) return;
    if (!selectedTx) return;

    if (isTransactionTerminal(selectedTx)) {
      showToast("This payment is completed and cannot be cancelled", "info");
      return;
    }

    setIsActing(true);
    const res = await PaymentService.cancelTransaction(txId);
    setIsActing(false);
    if (res.success) {
      showToast("Payment cancelled successfully", "info");
      await loadPayments();
    } else {
      showToast(res.error || "Unable to complete this action", "warning");
    }
  };

  const handlePaymentCompleted = async (
    txId: string,
    stage?: PaymentWorkflowStage | { stage?: any } | string | null,
    options?: { hasActiveContext?: boolean }
  ): Promise<{ success: boolean; error?: string }> => {
    if (stage !== undefined) {
      const validation = validatePaymentCompletionStage(stage);
      if (!validation.valid) {
        showToast(validation.error || "Invalid workflow stage for payment completion", "warning");
        return { success: false, error: validation.error };
      }
    }

    const trustedAudit = selectedTx?.trustedApproval?.required
      ? {
          required: true,
          contactName: selectedTx.trustedApproval.contactName || trustedContacts[0]?.name || "Your trusted contact",
          decision: "Approved" as const,
          decisionTime: "Just now",
        }
      : { required: false };

    const res = await PaymentService.completeTransaction(
      txId,
      "Google Pay UPI",
      trustedAudit,
      stage || "PAYMENT_COMPLETED",
      options
    );
    if (res.success) {
      showToast("✓ Payment completed and recorded in transaction history", "success");
      await loadPayments();
    } else {
      showToast(res.error || "Unable to complete payment on server", "warning");
    }
    return res;
  };

  const getDynamicContributions = (tx: UserTransaction): ContributionItem[] => {
    if (tx.riskLevel === "HIGH" || (typeof tx.riskScore === "number" && tx.riskScore >= 61)) {
      return [
        { label: "Transaction Patterns", percentage: 45, color: colors.threat },
        { label: "Recipient History", percentage: 30, color: colors.caution },
        { label: "Device Trust", percentage: 25, color: colors.textSecondary },
      ];
    }
    if (tx.riskLevel === "MEDIUM" || (typeof tx.riskScore === "number" && tx.riskScore >= 31)) {
      return [
        { label: "Transaction Baseline", percentage: 25, color: colors.caution },
        { label: "Recipient Verification", percentage: 20, color: colors.caution },
        { label: "Device Trust", percentage: 10, color: colors.safe },
      ];
    }
    return [
      { label: "Transaction Patterns", percentage: 4, color: colors.safe },
      { label: "Behavioural Profile", percentage: 2, color: colors.safe },
      { label: "Device Trust", percentage: 2, color: colors.safe },
      { label: "Recipient History", percentage: 0, color: colors.safe },
      { label: "Other Factors", percentage: 0, color: colors.textMuted },
    ];
  };

  const isCurrentActiveTx = Boolean(selectedTx && isTransactionPayable(selectedTx) && !isTransactionTerminal(selectedTx));

  const allCount = transactions.length;
  const reviewCount = transactions.filter((t) => isTransactionPayable(t)).length;
  const safeCount = transactions.filter((t) => isTransactionTerminal(t)).length;

  const filterTabs = [
    { key: "all", label: "All", count: allCount, isAlert: false },
    {
      key: "review",
      label: "Needs Review",
      count: reviewCount,
      isAlert: reviewCount > 0,
    },
    { key: "safe", label: "Completed", count: safeCount, isAlert: false },
  ] as const;

  return (
    <View style={styles.screen}>
      <Header />

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>Loading payment records...</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={onRefresh}
              colors={[colors.brand]}
              tintColor={colors.brand}
            />
          }
        >
          {/* 1. Transaction Summary Header */}
          <View style={styles.titleSection}>
            <Text style={styles.screenHeading}>AVARAN PAY</Text>
            <Text style={styles.screenSubtitle}>
              {overview?.transactionCount ?? allCount} transactions ·{" "}
              <AnimatedAmount
                amount={overview?.totalAmountThisMonth ?? 0}
                prefix="₹"
                style={styles.screenSubtitleAmount}
                duration={900}
                animateOnlyOnce={hasPlayedRevealRef.current}
              />
              {" "}this month
            </Text>
          </View>

          {/* AVARAN PAY Entry Card */}
          <Card variant="default" style={styles.entryCard}>
            <View style={styles.entryCardHeader}>
              <Text style={styles.entryCardTitle}>Payment Intake</Text>
              <Text style={styles.entryCardSubtitle}>
                Select an intake method to prepare payment details
              </Text>
            </View>

            {preparedDraft ? (
              <PreparedPaymentCard
                draft={preparedDraft}
                evaluationState={evaluationState}
                onAnalyzeRisk={() => handleEvaluatePreparedRisk(preparedDraft)}
                onRetryEvaluation={() => handleEvaluatePreparedRisk(preparedDraft)}
                isAnalyzing={evaluationState.status === "ANALYZING"}
                guardianState={guardianState}
                onRequestGuardianApproval={handleRequestGuardianApproval}
                onRetryGuardian={handleRequestGuardianApproval}
                isRequestingGuardian={guardianState.status === "REQUESTING_APPROVAL"}
                onProceedToPayment={handleProceedToPayment}
                isProceedingToPayment={isPersistingPayment}
                onEdit={() => {
                  setPreparedDraft(null);
                  setEvaluationState({ status: "IDLE" });
                  setGuardianState({ status: "IDLE" });
                }}
                onReset={() => {
                  setPreparedDraft(null);
                  setEvaluationState({ status: "IDLE" });
                  setGuardianState({ status: "IDLE" });
                  setEntryRecipient("");
                  setEntryAmount("");
                  setEntryNote("");
                  setScannedQrPayload("");
                }}
              />
            ) : (
              <>
                <PaymentSourceSelector
                  activeSource={paymentSource}
                  onSelectSource={handleSelectPaymentSource}
                  pendingRequestsCount={pendingRequestsCount}
                />

                {paymentSource === "UPI_ID" && (
                  <UpiIdPaymentForm
                    onPreparePayment={handlePreparePayment}
                    initialRecipient={entryRecipient}
                    initialAmount={entryAmount}
                    initialNote={entryNote}
                  />
                )}

                {paymentSource === "MOBILE" && (
                  <MobilePaymentForm
                    onPreparePayment={handlePreparePayment}
                    onPickContact={handlePickContact}
                    initialMobile={entryRecipient}
                    initialAmount={entryAmount}
                    initialNote={entryNote}
                  />
                )}

                {paymentSource === "QR" && (
                  <QrPaymentInput
                    onPreparePayment={handlePreparePayment}
                    onLaunchScanner={handleOpenScanner}
                    scannedPayload={scannedQrPayload || undefined}
                  />
                )}

                {paymentSource === "PAYMENT_REQUEST" && (
                  <PaymentRequestList
                    onAcceptRequest={handleAcceptPaymentRequest}
                  />
                )}
              </>
            )}

            {/* Evaluation Result Section (Clean compact advisory summary) */}
            {evaluationResult && (
              <View
                style={styles.evaluationResultCard}
                accessibilityRole="summary"
                accessibilityLabel="Payment evaluation summary"
                testID="evaluation-result-section"
              >
                {/* Header Row */}
                <View style={styles.evalHeaderRow}>
                  <View style={styles.evalHeaderLeft}>
                    <Ionicons name="shield-checkmark" size={16} color={colors.brand} />
                    <Text style={styles.evalHeaderTitle}>Evaluation Summary</Text>
                  </View>
                  {(() => {
                    const evaluatedLevel: RiskLevel | null =
                      evaluationResult.riskLevel ||
                      (typeof evaluationResult.riskScore === "number"
                        ? getRiskLevelFromScore(evaluationResult.riskScore)
                        : null);

                    if (evaluatedLevel) {
                      const badge = getStatusBadgeProps(evaluatedLevel);
                      return <StatusBadge label={badge.label} status={badge.status} />;
                    }
                    return <StatusBadge label="EVALUATION COMPLETED" status="neutral" />;
                  })()}
                </View>

                {/* Recipient & Amount Details Grid */}
                <View style={styles.evalDetailGrid}>
                  <View style={styles.evalDetailRow}>
                    <Text style={styles.evalDetailLabel}>Recipient</Text>
                    <View style={styles.evalRecipientBadgeRow}>
                      <Text style={styles.evalDetailValue} numberOfLines={2}>
                        {evaluationResult.recipient?.raw_input || paymentDraft?.recipient}
                      </Text>
                      <StatusBadge
                        label={
                          evaluationResult.recipient?.recipient_type === "PHONE"
                            ? "Mobile"
                            : "UPI ID"
                        }
                        status="neutral"
                        dot={false}
                      />
                    </View>
                  </View>

                  {evaluationResult.recipient?.display_name ? (
                    <View style={styles.evalDetailRow}>
                      <Text style={styles.evalDetailLabel}>Resolved Name</Text>
                      <View style={styles.evalRecipientBadgeRow}>
                        <Text style={styles.evalDetailValue} numberOfLines={1}>
                          {evaluationResult.recipient.display_name}
                        </Text>
                        <StatusBadge label="RESOLVED" status="resolved" dot={false} />
                      </View>
                    </View>
                  ) : null}

                  <View style={styles.evalDetailRow}>
                    <Text style={styles.evalDetailLabel}>Evaluated Amount</Text>
                    <Text style={[styles.evalDetailValue, { color: colors.brand, fontWeight: "700" }]}>
                      ₹{(evaluationResult.amount ?? paymentDraft?.amount ?? 0).toFixed(2)}
                    </Text>
                  </View>

                  <View style={styles.evalDetailRow}>
                    <Text style={styles.evalDetailLabel}>Workflow Stage</Text>
                    <StatusBadge label={evaluationResult.stage || "EVALUATION_COMPLETED"} status="neutral" dot={false} />
                  </View>

                  {evaluationResult.transactionStatus && (
                    <View style={styles.evalDetailRow}>
                      <Text style={styles.evalDetailLabel}>Transaction Status</Text>
                      <StatusBadge label={evaluationResult.transactionStatus} status="neutral" dot={false} />
                    </View>
                  )}

                  {evaluationResult.evaluation_id && (
                    <View style={styles.evalDetailRow}>
                      <Text style={styles.evalDetailLabel}>Evaluation Ref</Text>
                      <Text style={[styles.evalDetailValue, { fontSize: 11, color: colors.textMuted }]} numberOfLines={1}>
                        {evaluationResult.evaluation_id}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Informational State Disclaimer (Exact mandatory notice) */}
                <View style={styles.evalDisclaimerRow}>
                  <Ionicons
                    name="information-circle-outline"
                    size={14}
                    color={colors.textSecondary}
                    style={{ marginRight: 5, flexShrink: 0 }}
                  />
                  <Text style={styles.evalDisclaimerText}>
                    ADVISORY PRE-PAYMENT EVALUATION ONLY. NO PAYMENT AUTHORIZED OR INITIATED.
                  </Text>
                </View>
              </View>
            )}
          </Card>

          {/* 2. Filter Tabs: ALL | NEEDS REVIEW | COMPLETED / SAFE */}
          <View style={styles.filterSection}>
            <View style={styles.filterTrack}>
              {filterTabs.map((f) => {
                const isActive = filter === f.key;
                return (
                  <TouchableOpacity
                    key={f.key}
                    onPress={() => handleSelectFilter(f.key)}
                    style={[
                      styles.filterTab,
                      isActive && styles.filterTabActive,
                      ...(Platform.OS === "web" ? [{ cursor: "pointer", userSelect: "none" } as any] : []),
                    ]}
                    activeOpacity={0.75}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: isActive }}
                  >
                    <Text style={[styles.filterTabText, isActive && styles.filterTabTextActive]}>
                      {f.label}
                    </Text>
                    <View
                      style={[
                        styles.countPill,
                        isActive ? styles.countPillActive : styles.countPillInactive,
                        f.isAlert && !isActive && styles.countPillAlert,
                      ]}
                    >
                      <Text
                        style={[
                          styles.countPillText,
                          isActive ? styles.countPillTextActive : styles.countPillTextInactive,
                          f.isAlert && !isActive && styles.countPillTextAlert,
                        ]}
                      >
                        {f.count}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* 3. PAYMENT DETAILS & RISK ASSESSMENT CARD */}
          {selectedTx && (
            <View style={[styles.detailCard, isCurrentActiveTx ? styles.detailCardActive : styles.detailCardReadOnly]}>
              <View style={styles.detailTopRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.detailBadgeRow}>
                    <Text style={styles.detailHeading}>
                      {isCurrentActiveTx ? "PAYMENT EVALUATION SUMMARY" : "COMPLETED TRANSACTION RECORD"}
                    </Text>
                    {!isCurrentActiveTx && (
                      <View style={styles.readOnlyTag}>
                        <Ionicons name="lock-closed" size={11} color={colors.textMuted} style={{ marginRight: 3 }} />
                        <Text style={styles.readOnlyTagText}>READ-ONLY AUDIT</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.detailMerchant} numberOfLines={2} ellipsizeMode="tail">
                    {selectedTx.merchant}
                  </Text>
                  <AnimatedAmount
                    amount={selectedTx?.amount ?? 0}
                    prefix="₹"
                    style={styles.detailAmount}
                    duration={900}
                    animateOnlyOnce={hasPlayedRevealRef.current}
                  />

                  {/* Structured Summary Key-Values */}
                  <View style={styles.summaryGrid}>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Payment Method</Text>
                      <Text style={styles.summaryValue}>
                        {selectedTx.paymentAppUsed || selectedTx.paymentMethod}
                      </Text>
                    </View>

                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Recipient Type</Text>
                      <View style={styles.summaryBadgeRow}>
                        <Text style={styles.summaryValue}>
                          {selectedTx.recipientType === "PHONE" ? "Mobile Number" : "UPI ID"}
                        </Text>
                        <StatusBadge
                          label={selectedTx.resolutionStatus || (selectedTx.displayName ? "RESOLVED" : "UNVERIFIED")}
                          status={selectedTx.resolutionStatus === "RESOLVED" || selectedTx.displayName ? "resolved" : "neutral"}
                          dot={false}
                        />
                      </View>
                    </View>

                    {selectedTx.displayName && (
                      <View style={styles.summaryRow}>
                        <Text style={styles.summaryLabel}>Resolved Name</Text>
                        <Text style={styles.summaryValue} numberOfLines={1}>
                          {selectedTx.displayName}
                        </Text>
                      </View>
                    )}

                    {selectedTx.note && (
                      <View style={styles.summaryRow}>
                        <Text style={styles.summaryLabel}>Note</Text>
                        <Text style={[styles.summaryValue, { fontStyle: "italic" }]} numberOfLines={2}>
                          {selectedTx.note}
                        </Text>
                      </View>
                    )}

                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Workflow Stage</Text>
                      <StatusBadge label={selectedTx.workflowStage || "EVALUATION_COMPLETED"} status="neutral" dot={false} />
                    </View>

                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Transaction Status</Text>
                      <StatusBadge label={selectedTx.status} status={selectedTx.status === "Risk detected" || selectedTx.status === "Held" ? "pending" : "neutral"} dot={false} />
                    </View>

                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Reference / Eval ID</Text>
                      <Text style={styles.summaryRefText} numberOfLines={2}>
                        TXN-{selectedTx.id} {selectedTx.evaluationId ? `· ${selectedTx.evaluationId}` : ""}
                      </Text>
                    </View>
                  </View>
                </View>
                <TouchableOpacity
                  onPress={() => setSelectedTx(null)}
                  style={styles.closeBtn}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Close payment details"
                >
                  <Ionicons name="close" size={18} color={colors.textPrimary} />
                </TouchableOpacity>
              </View>

              {/* RISK ASSESSMENT SECTION */}
              <View style={styles.assessmentSection}>
                <Text style={styles.assessmentHeading}>
                  {isCurrentActiveTx ? "AVARAN RISK ASSESSMENT" : "PRE-TRANSACTION RISK ASSESSMENT"}
                </Text>

                {/* AI SCANNING / ANALYSIS ANIMATION BANNER */}
                <AiScanBanner
                  isAnalyzing={isAiScanning && !hasPlayedRevealRef.current}
                  onAnalysisComplete={() => {
                    setIsAiScanning(false);
                  }}
                />

                {(() => {
                  const dtScore = selectedTx.riskScore ?? 0;
                  const dtLevel = selectedTx.riskLevel || getRiskLevelFromScore(dtScore);
                  validateAndLogRiskState({
                    component: "PaymentsScreen:DetailCard",
                    transactionId: selectedTx.id,
                    riskScore: dtScore,
                    riskLevel: dtLevel,
                  });
                  return (
                    <RiskGauge
                      score={dtScore}
                      riskLevel={dtLevel}
                      size="md"
                      enableRevealAnimation={!hasPlayedRevealRef.current}
                    />
                  );
                })()}

                {/* 1. WHY WAS THIS PAYMENT FLAGGED / ANALYSIS FACTORS */}
                <StaggerRevealCard
                  index={0}
                  baseDelay={1350}
                  staggerInterval={120}
                  hasPlayed={hasPlayedRevealRef.current}
                >
                  <View style={styles.reasonsContainer}>
                    <Text style={styles.reasonsTitle}>
                      {selectedTx.riskLevel === "HIGH"
                        ? "Why was this payment flagged?"
                        : selectedTx.riskLevel === "MEDIUM"
                        ? "Risk Advisory Notice"
                        : "Risk analysis & signature"}
                    </Text>
                    {selectedTx.reasons && selectedTx.reasons.length > 0 ? (
                      selectedTx.reasons.map((r, i) => (
                        <View key={i} style={styles.reasonBulletRow}>
                          <Ionicons
                            name={
                              selectedTx.riskLevel === "HIGH"
                                ? "alert-circle"
                                : selectedTx.riskLevel === "MEDIUM"
                                ? "warning"
                                : "checkmark-circle"
                            }
                            size={14}
                            color={
                              selectedTx.riskLevel === "HIGH"
                                ? colors.threat
                                : selectedTx.riskLevel === "MEDIUM"
                                ? colors.caution
                                : colors.safe
                            }
                            style={{ marginRight: 6, marginTop: 2 }}
                          />
                          <Text style={styles.reasonBulletText}>{r}</Text>
                        </View>
                      ))
                    ) : (
                      <View style={styles.reasonBulletRow}>
                        <Ionicons name="checkmark-circle" size={14} color={colors.safe} style={{ marginRight: 6, marginTop: 2 }} />
                        <Text style={styles.reasonBulletText}>
                          Standard verified transaction signature.
                        </Text>
                      </View>
                    )}
                  </View>
                </StaggerRevealCard>

                {/* 2. HISTORICAL TRUSTED APPROVAL AUDIT (READ-ONLY) */}
                {!isCurrentActiveTx && (
                  <StaggerRevealCard
                    index={1}
                    baseDelay={1350}
                    staggerInterval={120}
                    hasPlayed={hasPlayedRevealRef.current}
                  >
                    <View style={styles.auditCard}>
                      <View style={styles.auditHeader}>
                        <Ionicons name="shield-checkmark" size={16} color={colors.brand} />
                        <Text style={styles.auditTitle}>Trusted Contact Approval Record</Text>
                      </View>
                      <View style={styles.auditRow}>
                        <Text style={styles.auditLabel}>Trusted Approval Required:</Text>
                        <Text style={styles.auditValue}>
                          {selectedTx.trustedApproval?.required ? "Yes" : "No (Safe Baseline)"}
                        </Text>
                      </View>
                      {selectedTx.trustedApproval?.required && (
                        <>
                          <View style={styles.auditRow}>
                            <Text style={styles.auditLabel}>Trusted Contact:</Text>
                            <Text style={styles.auditValue}>
                              {selectedTx.trustedApproval.contactName || trustedContacts[0]?.name || "Your trusted contact"}
                            </Text>
                          </View>
                          <View style={styles.auditRow}>
                            <Text style={styles.auditLabel}>Decision:</Text>
                            <Text style={[styles.auditValue, { color: colors.safeText, fontWeight: "700" }]}>
                              {selectedTx.trustedApproval.decision || "Approved"}
                            </Text>
                          </View>
                          <View style={styles.auditRow}>
                            <Text style={styles.auditLabel}>Timestamp:</Text>
                            <Text style={styles.auditValue}>
                              {selectedTx.trustedApproval.decisionTime || selectedTx.date}
                            </Text>
                          </View>
                        </>
                      )}
                      <View style={styles.auditRow}>
                        <Text style={styles.auditLabel}>Payment Gateway Used:</Text>
                        <Text style={styles.auditValue}>
                          {selectedTx.paymentAppUsed || selectedTx.paymentMethod}
                        </Text>
                      </View>
                    </View>
                  </StaggerRevealCard>
                )}

                {/* 3. RISK CONTRIBUTION HORIZONTAL VISUALIZATION */}
                <StaggerRevealCard
                  index={2}
                  baseDelay={1350}
                  staggerInterval={120}
                  hasPlayed={hasPlayedRevealRef.current}
                >
                  <RiskContributionBar contributions={getDynamicContributions(selectedTx)} />
                </StaggerRevealCard>

                {/* 4. CURRENT PAYMENT ACTIONS vs HISTORICAL SETTLED BANNER */}
                <StaggerRevealCard
                  index={3}
                  baseDelay={1350}
                  staggerInterval={120}
                  hasPlayed={hasPlayedRevealRef.current}
                >
                  {isCurrentActiveTx ? (
                    <View style={styles.decisionBlock}>
                      {/* 1. Guardian Waiting State (Active hold / countdown) */}
                      {!paymentOutcome &&
                      !isTransactionTerminal(selectedTx) &&
                      selectedTx.status !== "Approved by you" &&
                      selectedTx.canonicalStatus !== "GUARDIAN_APPROVED" &&
                      ((awaitingGuardian && activeRequest && activeRequest.status === "PENDING") ||
                        (activeRequest &&
                          activeRequest.status === "PENDING" &&
                          String(activeRequest.transactionId) === String(selectedTx.id))) ? (
                        <View style={styles.guardianWaitBlock}>
                          <View style={styles.guardianWaitHeader}>
                            <View style={styles.guardianWaitHeaderLeft}>
                              <View style={styles.guardianWaitIconBox}>
                                <Ionicons name="hourglass-outline" size={18} color={colors.caution} />
                              </View>
                              <View style={{ flex: 1 }}>
                                <Text style={styles.guardianWaitTitle}>Waiting for trusted contact approval</Text>
                                <Text style={styles.guardianWaitSub}>
                                  Approval is required from your trusted contact before this transfer can proceed.
                                </Text>
                              </View>
                            </View>
                            {(() => {
                              const waitLevel = selectedTx.riskLevel || getRiskLevelFromScore(selectedTx.riskScore ?? 0);
                              const waitBadge = getStatusBadgeProps(waitLevel);
                              return <StatusBadge label={waitBadge.label} status={waitBadge.status} />;
                            })()}
                          </View>

                          <View style={styles.guardianWaitDetails}>
                            <View style={styles.guardianWaitAmountRow}>
                              <Text style={styles.guardianWaitAmount}>
                                ₹{(selectedTx.amount ?? 0).toLocaleString("en-IN")}
                              </Text>
                              <Text style={styles.guardianWaitMerchant}>
                                To: {selectedTx.merchant}
                              </Text>
                            </View>
                            <Text style={styles.guardianWaitNotice}>
                              Sent to {trustedContacts[0]?.name || "your trusted contact"}. Your payment will automatically update once reviewed.
                            </Text>
                          </View>

                          <View style={styles.countdownRow}>
                            <Ionicons
                              name="time-outline"
                              size={15}
                              color={countdown <= 15 ? colors.threat : colors.caution}
                            />
                            <Text
                              style={[
                                styles.countdownNum,
                                { color: countdown <= 15 ? colors.threat : colors.caution },
                              ]}
                            >
                              {countdown}s
                            </Text>
                            <Text style={styles.countdownLabel}>remaining to approve</Text>
                          </View>
                        </View>
                      ) : paymentOutcome === "APPROVED" || selectedTx.status === "Approved by you" ? (
                        /* 2. Guardian Approved State */
                        <View style={styles.approvedCard}>
                          <View style={styles.approvedHeader}>
                            <View style={styles.approvedIconBox}>
                              <Ionicons name="checkmark-circle" size={22} color={colors.safe} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.approvedTitle}>Trusted contact approved your payment</Text>
                              <Text style={styles.approvedSubtitle}>
                                ₹{(selectedTx.amount ?? 0).toLocaleString("en-IN")} payment to {selectedTx.merchant} is authorized and verified.
                              </Text>
                            </View>
                          </View>
                          <View style={styles.actionRow}>
                            <Button
                              label="PROCEED TO PAY"
                              icon="arrow-forward-circle"
                              onPress={() => setIsChooseAppModalVisible(true)}
                              variant="primary"
                              size="md"
                              style={styles.actionBtn}
                            />
                          </View>
                        </View>
                      ) : paymentOutcome === "REJECTED" ? (
                        /* 3. Guardian Rejected State */
                        <View style={styles.rejectedCard}>
                          <View style={styles.rejectedHeader}>
                            <View style={styles.rejectedIconBox}>
                              <Ionicons name="close-circle" size={22} color={colors.threat} />
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.rejectedTitle}>Payment rejected by trusted contact</Text>
                              <Text style={styles.rejectedSubtitle}>
                                Your trusted contact declined this transaction of ₹{(selectedTx.amount ?? 0).toLocaleString("en-IN")} due to security risk. This payment cannot continue.
                              </Text>
                            </View>
                          </View>
                        </View>
                      ) : paymentOutcome === "EXPIRED" ? (
                        /* 4. Guardian Expired State */
                        <View style={styles.expiredBlock}>
                          <Ionicons name="time-outline" size={16} color={colors.textMuted} />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.expiredTitle}>Guardian approval window expired</Text>
                            <Text style={styles.expiredText}>
                              The 2-minute review window timed out. Payment cancelled for security.
                            </Text>
                          </View>
                        </View>
                      ) : (
                        /* 5. Active Confirmation Actions (Unified layout for Low, Medium, and High risk) */
                        <View style={{ width: "100%" }}>
                          {selectedTx.authorizationStatus === "AUTHORIZED" && (
                            <View style={styles.authVerifiedBanner}>
                              <Ionicons name="checkmark-circle" size={15} color={colors.safe} />
                              <Text style={styles.authVerifiedText}>
                                Biometric Identity Verified · Signature Valid
                              </Text>
                            </View>
                          )}
                          <View style={styles.actionRow}>
                            <Button
                              label={
                                isStartingGuardian
                                  ? "Requesting Guardian..."
                                  : isAuthorizing
                                  ? "Verifying..."
                                  : "CONFIRM PAYMENT"
                              }
                              icon="arrow-forward-circle"
                              onPress={() => handleConfirm(selectedTx.id)}
                              loading={isActing || isAuthorizing || isStartingGuardian}
                              disabled={isActing || isAuthorizing || isStartingGuardian}
                              variant="primary"
                              size="md"
                              style={styles.actionBtn}
                            />
                            <Button
                              label="CANCEL"
                              icon="close-circle-outline"
                              onPress={() => handleCancel(selectedTx.id)}
                              loading={isActing}
                              disabled={isActing || isAuthorizing || isStartingGuardian}
                              variant="outline"
                              size="md"
                              style={styles.actionBtnCancel}
                            />
                          </View>
                        </View>
                      )}

                      {!awaitingGuardian && paymentOutcome !== "EXPIRED" && (
                        <TouchableOpacity
                          style={[
                            styles.cancelActionBtn,
                            isActing && styles.cancelActionBtnDisabled,
                          ]}
                          onPress={() => handleCancel(selectedTx.id)}
                          disabled={isActing || isAuthorizing || isStartingGuardian}
                          activeOpacity={0.7}
                          accessibilityRole="button"
                          accessibilityLabel="Cancel payment"
                        >
                          <Ionicons name="close-circle-outline" size={15} color={colors.textMuted} style={{ marginRight: 5 }} />
                          <Text style={styles.cancelActionText}>Cancel payment</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  ) : (
                    /* Completed Historical Settled Banner (Read-Only) */
                    <View style={styles.settledCard}>
                      <View style={styles.settledIconBoxSafe}>
                        <Ionicons name="checkmark" size={20} color={colors.safe} />
                      </View>
                      <View style={styles.settledTextCol}>
                        <Text style={[styles.settledTitle, { color: colors.safeText }]}>
                          PAYMENT COMPLETED & RECORDED
                        </Text>
                        <Text style={styles.settledSubtitle}>
                          This is a secure historical transaction record. No further actions required.
                        </Text>
                      </View>
                    </View>
                  )}
                </StaggerRevealCard>
              </View>
            </View>
          )}

          {/* 4. TRANSACTION LIST */}
          <Text style={styles.listHeading}>
            {filter === "review"
              ? "TRANSACTIONS REQUIRING REVIEW"
              : filter === "safe"
              ? "COMPLETED PAYMENT HISTORY"
              : "ALL TRANSACTIONS"}
          </Text>

          <View style={styles.paymentList}>
            {visibleTransactions.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="file-tray-outline" size={28} color={colors.textMuted} />
                <Text style={styles.emptyText}>
                  {filter === "review"
                    ? "No transactions currently require review. All payments are verified."
                    : filter === "safe"
                    ? "No completed transactions recorded."
                    : "No transactions found."}
                </Text>
              </View>
            ) : (
              visibleTransactions.map((item, idx) => {
                const isRisk = item.status === "Risk detected" || item.status === "Held";
                const isSelected = selectedTx?.id === item.id;
                const isNewlyDetected = newlyDetectedIds.has(item.id);
                const isLast = idx === visibleTransactions.length - 1;
                return (
                  <StaggerRevealCard
                    key={item.id}
                    index={idx}
                    baseDelay={hasPlayedRevealRef.current ? 0 : 1350}
                    staggerInterval={80}
                    hasPlayed={hasPlayedListStaggerRef.current}
                  >
                    <NewPaymentHighlightCard isNew={isNewlyDetected}>
                      <TouchableOpacity
                        style={[
                          styles.txnCard,
                          isRisk && !isSelected && styles.txnCardRisk,
                          isSelected && styles.txnCardSelected,
                          isSelected && isRisk && styles.txnCardSelectedRisk,
                          isLast && styles.txnCardLast,
                        ]}
                        onPress={() => {
                          setSelectedTx(item);
                          if (paymentOutcome) clearPaymentOutcome();
                        }}
                        activeOpacity={0.8}
                      >
                        {/* Derive risk level before applying any colors so MEDIUM ≠ HIGH */}
                        {(() => {
                          const itemLevel = item.riskLevel || getRiskLevelFromScore(item.riskScore ?? 0);
                          const riskIconColor = isRisk
                            ? (itemLevel === "HIGH" ? colors.threat : colors.caution)
                            : colors.safe;
                          const riskAmtColor = isRisk
                            ? (itemLevel === "HIGH" ? colors.threat : colors.caution)
                            : colors.textPrimary;
                          const iconBoxStyle = isRisk
                            ? (itemLevel === "HIGH" ? styles.txnIconBoxRisk : styles.txnIconBoxCaution)
                            : {};

                          return (
                            <>
                              <View style={styles.txnLeft}>
                                <View
                                  style={[
                                    styles.txnIconBox,
                                    iconBoxStyle,
                                    isSelected && styles.txnIconBoxSelected,
                                  ]}
                                >
                                  <Ionicons
                                    name={isRisk ? "warning" : "checkmark-circle"}
                                    size={18}
                                    color={riskIconColor}
                                  />
                                </View>
                                <View style={styles.txnTextCol}>
                                  <Text style={styles.txnMerchant}>{item.merchant}</Text>
                                  <Text style={styles.txnMeta}>
                                    {item.paymentAppUsed || item.paymentMethod} · {item.date}
                                  </Text>
                                </View>
                              </View>

                              <View style={styles.txnRight}>
                                <AnimatedAmount
                                  amount={item?.amount ?? 0}
                                  prefix="₹"
                                  style={[
                                    styles.txnAmount,
                                    { color: riskAmtColor },
                                  ]}
                                  animateOnlyOnce={hasPlayedListStaggerRef.current}
                                  duration={600}
                                />
                                <StatusBadge
                                  label={
                                    isRisk
                                      ? `${itemLevel} RISK`
                                      : item.status === "Reported"
                                      ? "Reported"
                                      : item.status === "Blocked"
                                      ? "Blocked"
                                      : "Completed"
                                  }
                                  status={
                                    isRisk
                                      ? (itemLevel === "HIGH" ? "high" : itemLevel === "MEDIUM" ? "medium" : "low")
                                      : item.status === "Reported"
                                      ? "escalated"
                                      : "low"
                                  }
                                  dot={false}
                                />
                              </View>
                            </>
                          );
                        })()}
                      </TouchableOpacity>
                    </NewPaymentHighlightCard>
                  </StaggerRevealCard>
                );
              })
            )}
          </View>
        </ScrollView>
      )}

      {/* Choose Installed Payment App Modal (Only enabled connected apps) */}
      <ChoosePaymentAppModal
        visible={isChooseAppModalVisible}
        transaction={selectedTx}
        onClose={() => setIsChooseAppModalVisible(false)}
        onPaymentCompleted={handlePaymentCompleted}
        onShowToast={showToast}
      />

      {/* QR Scanner Modal for AVARAN PAY */}
      <QrScannerModal
        visible={isScannerVisible}
        onClose={() => setIsScannerVisible(false)}
        onScan={handleQrScan}
      />

      {/* Floating Toast notification */}
      <FloatingToast config={toastConfig} onDismiss={() => setToastConfig(null)} />
    </View>
  );
};

const styles = StyleSheet.create({
  recipientInputContainer: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs + 2,
  },
  recipientTypeHint: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: -2,
    marginBottom: spacing.xs + 2,
    paddingHorizontal: 2,
  },
  secondaryActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs + 2,
  },
  secondaryActionBtn: {
    flex: 1,
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    gap: 6,
    ...(Platform.OS === "web" ? ({ cursor: "pointer", userSelect: "none" } as any) : {}),
  },
  secondaryActionBtnText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  amountInputContainer: {
    marginVertical: spacing.xs,
  },
  noteInputContainer: {
    marginVertical: spacing.xs,
  },
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  titleSection: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    marginBottom: spacing.xs,
  },
  entryCard: {
    marginBottom: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderColor: colors.borderLight,
    borderWidth: 1,
    borderRadius: radii.lg,
    ...shadows.sm,
  },
  entryCardHeader: {
    marginBottom: spacing.sm,
  },
  entryCardTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: "700",
    fontSize: 18,
    lineHeight: 24,
    letterSpacing: -0.3,
  },
  entryCardSubtitle: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    marginBottom: spacing.xs,
  },
  evaluateBtn: {
    marginTop: spacing.md,
  },
  screenHeading: {
    ...typography.h2,
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: "700",
  },
  screenSubtitle: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  screenSubtitleAmount: {
    color: colors.textPrimary,
    fontWeight: "700",
  },
  filterSection: {
    marginBottom: spacing.md,
  },
  filterTrack: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    padding: 3,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 4,
  },
  filterTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    gap: 6,
  },
  filterTabActive: {
    backgroundColor: colors.btnPrimaryBg,
    ...shadows.sm,
  },
  filterTabText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 12,
    textTransform: "none",
    letterSpacing: 0.1,
  },
  filterTabTextActive: {
    color: colors.btnPrimaryText,
    fontWeight: "700",
  },
  countPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radii.full,
    minWidth: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  countPillActive: {
    backgroundColor: "rgba(255, 255, 255, 0.2)",
  },
  countPillInactive: {
    backgroundColor: colors.borderLight,
  },
  countPillAlert: {
    backgroundColor: colors.threatSurface,
    borderWidth: 1,
    borderColor: colors.threatBorder,
  },
  countPillText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: "700",
  },
  countPillTextActive: {
    color: colors.btnPrimaryText,
  },
  countPillTextInactive: {
    color: colors.textSecondary,
  },
  countPillTextAlert: {
    color: colors.threatText,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 13,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    paddingBottom: spacing.xxxl * 2,
  },
  detailCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1.2,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.lg,
    width: "100%",
    ...shadows.lg,
  },
  detailCardActive: {
    borderColor: "rgba(23, 107, 91, 0.35)",
    ...shadows.hero,
  },
  detailCardReadOnly: {
    borderColor: colors.borderLight,
    ...shadows.md,
  },
  detailTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    width: "100%",
    gap: spacing.sm,
  },
  detailBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  detailHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "800",
    fontSize: 10,
    letterSpacing: 0.6,
  },
  readOnlyTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  readOnlyTagText: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: "700",
    color: colors.textMuted,
  },
  detailMerchant: {
    ...typography.h2,
    color: colors.textPrimary,
    fontSize: 18,
    lineHeight: 24,
    fontWeight: "800",
    marginTop: 2,
    flexWrap: "wrap",
  },
  detailAmount: {
    ...typography.amountLarge,
    color: colors.textPrimary,
    marginVertical: 4,
  },
  summaryGrid: {
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    gap: 6,
    width: "100%",
  },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingVertical: 2,
  },
  summaryLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    flexShrink: 0,
  },
  summaryValue: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 12,
    flexShrink: 1,
    textAlign: "right",
  },
  summaryBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    flexShrink: 1,
  },
  summaryRefText: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10.5,
    flexShrink: 1,
    textAlign: "right",
  },
  detailMeta: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 13,
  },
  detailRef: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 2,
    textTransform: "none",
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
  assessmentSection: {
    marginTop: spacing.md,
    width: "100%",
  },
  assessmentHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "800",
    fontSize: 10,
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
  },
  reasonsContainer: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    width: "100%",
  },
  reasonsTitle: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 13,
    marginBottom: spacing.xs,
  },
  reasonBulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginVertical: 3,
    width: "100%",
  },
  reasonBulletText: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
    flexShrink: 1,
    flexWrap: "wrap",
  },
  auditCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    marginVertical: spacing.sm,
    width: "100%",
  },
  auditHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  auditTitle: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: "700",
  },
  auditRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  auditLabel: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
  },
  auditValue: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 12,
    flexShrink: 1,
  },
  decisionBlock: {
    marginTop: spacing.md,
    gap: spacing.sm,
    width: "100%",
  },
  actionRow: {
    flexDirection: "row",
    gap: spacing.sm,
    width: "100%",
    alignItems: "center",
    flexWrap: "wrap",
  },
  actionBtn: {
    flex: 1,
    minWidth: 140,
    flexGrow: 1,
  },
  actionBtnCancel: {
    flex: 1,
    minWidth: 100,
    flexGrow: 1,
  },
  cancelActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    marginTop: 2,
    ...(Platform.OS === "web" ? ({ cursor: "pointer", userSelect: "none" } as any) : {}),
  },
  cancelActionBtnDisabled: {
    opacity: 0.5,
  },
  cancelActionText: {
    ...typography.smallSemibold,
    color: colors.textMuted,
    fontSize: 13,
  },
  settledCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.safeSurface,
    borderWidth: 1,
    borderColor: colors.safeBorder,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  settledIconBoxSafe: {
    width: 36,
    height: 36,
    borderRadius: radii.full,
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  settledTextCol: {
    flex: 1,
  },
  settledTitle: {
    ...typography.bodySemibold,
    fontSize: 13,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  settledSubtitle: {
    ...typography.small,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  },
  listHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "800",
    letterSpacing: 0.6,
    fontSize: 11,
    marginBottom: spacing.xs,
  },
  paymentList: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadows.sm,
  },
  txnCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
  txnCardRisk: {
    backgroundColor: "rgba(163,61,53,0.025)",
  },
  txnCardSelected: {
    backgroundColor: colors.surfaceSecondary,
    borderLeftWidth: 3,
    borderLeftColor: colors.brand,
    paddingLeft: spacing.lg - 3,
  },
  txnCardSelectedRisk: {
    backgroundColor: "rgba(163,61,53,0.05)",
    borderLeftWidth: 3,
    borderLeftColor: colors.threat,
    paddingLeft: spacing.lg - 3,
  },
  txnCardLast: {
    borderBottomWidth: 0,
  },
  txnLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  txnIconBox: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  txnIconBoxRisk: {
    backgroundColor: "rgba(163,61,53,0.07)",
    borderColor: colors.threatBorder,
  },
  // PART 2: Amber/caution icon box for MEDIUM-risk transactions
  txnIconBoxCaution: {
    backgroundColor: "rgba(168,117,32,0.07)",
    borderColor: colors.cautionBorder,
  },
  txnIconBoxSelected: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  txnTextCol: {
    flex: 1,
  },
  txnMerchant: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 13.5,
    lineHeight: 18,
  },
  txnMeta: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 16,
  },
  txnRight: {
    alignItems: "flex-end",
    gap: 4,
    flexShrink: 0,
    paddingLeft: spacing.xs,
  },
  txnAmount: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: -0.2,
  },
  emptyContainer: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
  },
  emptyText: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  guardianWaitBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.cautionBorder,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
    ...shadows.md,
  },
  guardianWaitHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  guardianWaitHeaderLeft: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    flex: 1,
  },
  guardianWaitIconBox: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.cautionSurface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.cautionBorder,
    marginTop: 1,
  },
  guardianWaitTitle: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  guardianWaitSub: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 1,
  },
  guardianWaitDetails: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 3,
  },
  guardianWaitAmountRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  guardianWaitAmount: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  guardianWaitMerchant: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  guardianWaitNotice: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  countdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: colors.cautionSurface,
    borderRadius: radii.sm,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    alignSelf: "flex-start",
  },
  countdownNum: {
    ...typography.smallSemibold,
    fontWeight: "800",
    fontSize: 13,
  },
  countdownLabel: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 11,
  },
  approvedCard: {
    backgroundColor: colors.safeSurface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.safeBorder,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
    ...shadows.sm,
  },
  approvedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  approvedIconBox: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(16, 185, 129, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  approvedTitle: {
    ...typography.bodySemibold,
    color: colors.safeText,
    fontSize: 14,
    fontWeight: "700",
  },
  approvedSubtitle: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  rejectedCard: {
    backgroundColor: colors.threatSurface,
    borderRadius: radii.lg,
    borderWidth: 1.5,
    borderColor: colors.threatBorder,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
    ...shadows.sm,
  },
  rejectedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  rejectedIconBox: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(220, 38, 38, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  rejectedTitle: {
    ...typography.bodySemibold,
    color: colors.threatText,
    fontSize: 14,
    fontWeight: "700",
  },
  rejectedSubtitle: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
  },
  expiredBlock: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  expiredTitle: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  expiredText: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 1,
  },
  authRequiredCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm,
    ...shadows.sm,
  },
  authRequiredHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  authBadgeIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.threatSurface,
    borderWidth: 1,
    borderColor: colors.threatBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  authRequiredTitle: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  authRequiredSubtitle: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  authVerifiedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.safeSurface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.safeBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  authVerifiedText: {
    ...typography.smallSemibold,
    color: colors.safeText,
    fontSize: 12,
  },
  evaluationResultCard: {
    marginTop: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  evalDetailGrid: {
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    gap: spacing.xs,
  },
  evalDetailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
    paddingVertical: 2,
  },
  evalDetailLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    flexShrink: 0,
  },
  evalDetailValue: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 12,
    flexShrink: 1,
    textAlign: "right",
  },
  evalRecipientBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    flexShrink: 1,
  },
  evalHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  evalHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flex: 1,
  },
  evalHeaderTitle: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  evalGaugeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  evalGaugeDetails: {
    flex: 1,
    justifyContent: "center",
  },
  evalScoreLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  evalScoreValue: {
    ...typography.h3,
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
    marginTop: 1,
  },
  evalLevelDescription: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
    lineHeight: 16,
  },
  evalReasonsContainer: {
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    gap: 6,
  },
  evalReasonsTitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    marginBottom: 2,
  },
  evalReasonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  evalReasonText: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    flex: 1,
  },
  evalSummaryText: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  evalDisclaimerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  evalDisclaimerText: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
    flex: 1,
  },
});
