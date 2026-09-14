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
} from "react-native";
import { useNavigation, useIsFocused } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing, radii, shadows } from "../theme/layout";
import { Header } from "../components/common/Header";
import { StatusBadge } from "../components/common/StatusBadge";
import { Button } from "../components/common/Button";
import { FloatingToast, ToastConfig } from "../components/common/FloatingToast";
import { StaggerRevealCard } from "../components/common/StaggerRevealCard";
import {
  ProtectionModuleModal,
  ProtectionFeatureItem,
} from "../components/protection/ProtectionModuleModal";
import { StatementUploadCard } from "../components/protection/StatementUploadCard";
import { AlertDetailsModal } from "../components/protection/AlertDetailsModal";
import { useAuth } from "../context/AuthContext";
import {
  PaymentService,
  UserPaymentOverview,
  EMPTY_PAYMENT_OVERVIEW,
} from "../services/payment-service";
import { AlertService, SecurityAlert } from "../services/alert-service";
import { useAlertBadge } from "../context/AlertBadgeContext";

interface CallAlertState {
  id: string;
  callerName: string;
  callerNumber: string;
  timeDetected: string;
  riskLevel: "HIGH" | "MEDIUM";
  signals: string[];
}

const PAYMENT_FEATURES: ProtectionFeatureItem[] = [
  {
    icon: "shield-checkmark",
    title: "Suspicious Payment Detection",
    desc: "Intercepts anomalous UPI & card payments before funds leave your account.",
  },
  {
    icon: "analytics",
    title: "Transaction Pattern Analysis",
    desc: "Compares amounts, frequency, and time-of-day against 90-day baseline.",
  },
  {
    icon: "business",
    title: "Merchant Verification",
    desc: "Cross-checks handles against National Payment Safety Registry.",
  },
  {
    icon: "warning",
    title: "Unusual Amount Detection",
    desc: "Detects spikes 3× or higher than typical transfer amounts.",
  },
  {
    icon: "speedometer",
    title: "Fraud Risk Scoring",
    desc: "Calculates live 0-100 anomaly index using XGBoost multi-signal models.",
  },
  {
    icon: "lock-closed",
    title: "Payment Blocking Support",
    desc: "Allows one-tap instant blocking and immediate dispute logging.",
  },
];

const RISK_FEATURES: ProtectionFeatureItem[] = [
  {
    icon: "pulse",
    title: "Behavioral Profile Detection",
    desc: "Analyzes typical app usage velocity and payment interaction dynamics.",
  },
  {
    icon: "hardware-chip",
    title: "Device Trust Analysis",
    desc: "Validates secure enclave hardware keys and detects unrecognized devices.",
  },
  {
    icon: "person",
    title: "Recipient History Profiling",
    desc: "Flags first-time recipients and unverified UPI virtual payment handles.",
  },
  {
    icon: "trending-up",
    title: "ML Anomaly Engine",
    desc: "IsolationForest behavioral model evaluating statistical deviations.",
  },
  {
    icon: "location",
    title: "Geolocation Geofencing",
    desc: "Identifies impossible travel speed or unusual regional access points.",
  },
];

const CALL_FEATURES: ProtectionFeatureItem[] = [
  {
    icon: "mic",
    title: "Voice Stream Signal Interception",
    desc: "Heuristic keyword matching for OTP, PIN, and CVV solicitation.",
  },
  {
    icon: "alert",
    title: "Social Engineering Detection",
    desc: "Detects urgency, coercion, and impersonation of banking authorities.",
  },
  {
    icon: "call",
    title: "Instant Scam Call Reporting",
    desc: "Logs scam numbers directly to telecom anti-fraud intelligence registry.",
  },
  {
    icon: "checkmark-done",
    title: "Verified Caller Safe-listing",
    desc: "Whitelist verified bank relationship managers and trusted personal contacts.",
  },
];

export const ProtectionScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { session } = useAuth();
  const { clearProtectionBadge } = useAlertBadge();

  const [overview, setOverview] = useState<UserPaymentOverview>(EMPTY_PAYMENT_OVERVIEW);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [isActing, setIsActing] = useState<boolean>(false);
  const isFocused = useIsFocused();
  const hasPlayedProtectionStaggerRef = useRef(false);

  useEffect(() => {
    if (isFocused && !isLoading && !hasPlayedProtectionStaggerRef.current) {
      const timer = setTimeout(() => {
        hasPlayedProtectionStaggerRef.current = true;
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isFocused, isLoading]);

  // Module switches
  const [paymentProtectionEnabled, setPaymentProtectionEnabled] = useState<boolean>(true);
  const [riskDetectionEnabled, setRiskDetectionEnabled] = useState<boolean>(true);
  const [callProtectionEnabled, setCallProtectionEnabled] = useState<boolean>(true);

  // Modals state
  const [activeModuleModal, setActiveModuleModal] = useState<"payment" | "risk" | "call" | null>(null);
  const [selectedAlertForModal, setSelectedAlertForModal] = useState<SecurityAlert | null>(null);

  // Active call alert state — no real call-scam detection is wired to this
  // yet (see handleReportCall/handleMarkSafe below), so it starts empty
  // rather than showing a fabricated "scam detected" card on every load.
  const [activeCallAlert, setActiveCallAlert] = useState<CallAlertState | null>(null);

  // Toast state
  const [toastConfig, setToastConfig] = useState<ToastConfig | null>(null);

  // Last real statement-upload receipt — statusFn below echoes this back
  // instead of fabricating a status (see that prop for why).
  const lastStatementReceiptRef = useRef<import("../services/statement-upload-service").StatementUploadResponse | null>(null);

  const showToast = (message: string, type: "info" | "success" | "warning" = "success") => {
    setToastConfig({ message, type });
  };

  const loadProtection = useCallback(async () => {
    try {
      const userId = session?.userId || 1;
      const [ovData, alertData] = await Promise.all([
        PaymentService.getOverview(userId),
        AlertService.getAlerts(session?.userId),
      ]);
      setOverview(ovData);
      setAlerts(alertData);
    } catch {
      // Fallback
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [session?.userId]);

  useEffect(() => {
    loadProtection();

    // Subscribe to PaymentService updates
    const unsubPayment = PaymentService.subscribe((updatedOverview) => {
      setOverview(updatedOverview);
    });

    // Subscribe to AlertService updates
    const unsubAlerts = AlertService.subscribe((updatedAlerts) => {
      setAlerts(updatedAlerts);
    });

    return () => {
      unsubPayment();
      unsubAlerts();
    };
  }, [loadProtection]);

  const onRefresh = () => {
    setIsRefreshing(true);
    loadProtection();
  };

  // Top Shield Banner Status Calculation
  const protectionStatusDetails = useMemo(() => {
    const totalEnabled =
      (paymentProtectionEnabled ? 1 : 0) +
      (riskDetectionEnabled ? 1 : 0) +
      (callProtectionEnabled ? 1 : 0);

    const hasActiveThreat =
      (overview.needsReviewCount > 0) ||
      alerts.some((a) => a.severity === "HIGH" && a.status === "ACTIVE") ||
      (activeCallAlert !== null);

    if (totalEnabled === 3) {
      if (hasActiveThreat) {
        return {
          title: "Protection Attention Required",
          sub: "High-risk security anomalies detected. Action recommended.",
          icon: "alert-circle" as const,
          color: colors.threat,
          statusLabel: "ATTENTION",
          statusColor: "high" as const,
        };
      }
      return {
        title: "All Protection Shields Active",
        sub: "Real-time scoring active across connected payment apps.",
        icon: "shield-checkmark" as const,
        color: colors.safe,
        statusLabel: "ACTIVE",
        statusColor: "low" as const,
      };
    } else if (totalEnabled > 0) {
      return {
        title: "Partial Protection Active",
        sub: "Some security modules are currently disabled.",
        icon: "warning" as const,
        color: colors.caution,
        statusLabel: "PARTIAL",
        statusColor: "medium" as const,
      };
    } else {
      return {
        title: "Protection Disabled",
        sub: "All real-time protection shields are currently offline.",
        icon: "shield-outline" as const,
        color: colors.textMuted,
        statusLabel: "OFFLINE",
        statusColor: "escalated" as const,
      };
    }
  }, [
    paymentProtectionEnabled,
    riskDetectionEnabled,
    callProtectionEnabled,
    overview.needsReviewCount,
    alerts,
    activeCallAlert,
  ]);

  const handleTogglePaymentProtection = (val: boolean) => {
    setPaymentProtectionEnabled(val);
    showToast(val ? "✓ Payment Protection enabled" : "Payment Protection disabled", val ? "success" : "info");
  };

  const handleToggleRiskDetection = (val: boolean) => {
    setRiskDetectionEnabled(val);
    showToast(val ? "✓ Risk Detection enabled" : "Risk Detection disabled", val ? "success" : "info");
  };

  const handleToggleCallProtection = (val: boolean) => {
    setCallProtectionEnabled(val);
    showToast(val ? "✓ Call Protection enabled" : "Call Protection disabled", val ? "success" : "info");
  };

  const handleReportCall = () => {
    if (isActing || !activeCallAlert) return;
    setIsActing(true);

    AlertService.addAlert({
      id: `alert-call-${Date.now()}`,
      title: "Suspicious Scam Call Reported",
      description: `Caller ${activeCallAlert.callerNumber} flagged for impersonation & OTP solicitation.`,
      severity: "HIGH",
      status: "ACTIVE",
      timestamp: "Just now",
      isRead: false,
    });

    setActiveCallAlert(null);
    clearProtectionBadge();
    setIsActing(false);
    showToast("⚠ Suspicious call reported successfully", "warning");
  };

  const handleMarkCallSafe = () => {
    if (isActing || !activeCallAlert) return;
    setIsActing(true);

    AlertService.addAlert({
      id: `alert-call-safe-${Date.now()}`,
      title: "Caller Verified Safe",
      description: `Caller ${activeCallAlert.callerNumber} marked as legitimate contact.`,
      severity: "LOW",
      status: "RESOLVED",
      timestamp: "Just now",
      isRead: true,
    });

    setActiveCallAlert(null);
    clearProtectionBadge();
    setIsActing(false);
    showToast("✓ Call marked as safe", "success");
  };

  const handleResolveAlert = (alertId: string) => {
    AlertService.markAsRead(alertId);
    showToast("✓ Security alert resolved", "success");
  };

  const handleViewPayment = (transactionId: string | number) => {
    navigation.navigate("Payments", { selectedTxId: String(transactionId) });
  };

  return (
    <View style={styles.screen}>
      <Header />

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>Syncing security shields...</Text>
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
          {/* 1. Screen Title & Subtitle */}
          <View style={styles.titleSection}>
            <Text style={styles.screenHeading}>Protection</Text>
            <Text style={styles.screenSubtitle}>Your Avaran protection is active.</Text>
          </View>

          {/* 2. Active Protection Banner */}
          <StaggerRevealCard
            index={0}
            baseDelay={60}
            hasPlayed={hasPlayedProtectionStaggerRef.current}
          >
            <View style={styles.statusBanner}>
              <View
                style={[
                  styles.statusIconBox,
                  protectionStatusDetails.color === colors.threat && {
                    backgroundColor: "rgba(239, 68, 68, 0.15)",
                  },
                ]}
              >
                <Ionicons
                  name={protectionStatusDetails.icon}
                  size={24}
                  color={protectionStatusDetails.color}
                />
              </View>
              <View style={styles.statusTextCol}>
                <Text style={styles.statusTitle}>{protectionStatusDetails.title}</Text>
                <Text style={styles.statusSub}>{protectionStatusDetails.sub}</Text>
              </View>
            </View>
          </StaggerRevealCard>

          {/* 3. Protection Modules (Same vertical flow as mobile) */}
          <StaggerRevealCard
            index={1}
            baseDelay={60}
            hasPlayed={hasPlayedProtectionStaggerRef.current}
            style={styles.section}
          >
            <Text style={styles.sectionHeading}>PROTECTION MODULES</Text>

            {/* Module 1: Payment Protection */}
            <TouchableOpacity
              style={styles.moduleCard}
              onPress={() => setActiveModuleModal("payment")}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Open Payment Protection configuration"
            >
              <View style={styles.moduleTopRow}>
                <View style={styles.moduleLeft}>
                  <View style={styles.moduleIconCircle}>
                    <Ionicons name="card-outline" size={18} color={colors.textPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moduleTitle}>Payment Protection</Text>
                    <Text style={styles.moduleDesc}>
                      Detects suspicious payments before completion.
                    </Text>
                  </View>
                </View>
                <StatusBadge
                  label={paymentProtectionEnabled ? "ACTIVE" : "DISABLED"}
                  status={paymentProtectionEnabled ? "low" : "high"}
                />
              </View>
            </TouchableOpacity>

            {/* Module 2: Risk Detection */}
            <TouchableOpacity
              style={styles.moduleCard}
              onPress={() => setActiveModuleModal("risk")}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Open Risk Detection configuration"
            >
              <View style={styles.moduleTopRow}>
                <View style={styles.moduleLeft}>
                  <View style={styles.moduleIconCircle}>
                    <Ionicons name="pulse-outline" size={18} color={colors.textPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moduleTitle}>Risk Detection</Text>
                    <Text style={styles.moduleDesc}>
                      Identifies unusual transaction, device and behavioral activity.
                    </Text>
                  </View>
                </View>
                <StatusBadge
                  label={riskDetectionEnabled ? "ACTIVE" : "DISABLED"}
                  status={riskDetectionEnabled ? "low" : "high"}
                />
              </View>
            </TouchableOpacity>

            {/* Module 3: Call Protection */}
            <TouchableOpacity
              style={styles.moduleCard}
              onPress={() => setActiveModuleModal("call")}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Open Call Protection configuration"
            >
              <View style={styles.moduleTopRow}>
                <View style={styles.moduleLeft}>
                  <View style={styles.moduleIconCircle}>
                    <Ionicons name="call-outline" size={18} color={colors.textPrimary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.moduleTitle}>Call Protection</Text>
                    <Text style={styles.moduleDesc}>
                      Helps identify potentially fraudulent calls.
                    </Text>
                  </View>
                </View>
                <StatusBadge
                  label={callProtectionEnabled ? "ACTIVE" : "DISABLED"}
                  status={callProtectionEnabled ? "low" : "high"}
                />
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.tryLiveDemoRow}
              onPress={() => navigation.navigate("Voice")}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Try the live voice scam call demo"
            >
              <Ionicons name="play-circle-outline" size={16} color={colors.brand} />
              <Text style={styles.tryLiveDemoText}>Try Live Call Demo →</Text>
            </TouchableOpacity>
          </StaggerRevealCard>

          {/* 4. Call / Social Engineering Alert */}
          {activeCallAlert && callProtectionEnabled && (
            <View style={styles.section}>
              <Text style={styles.sectionHeading}>CALL / SOCIAL-ENGINEERING ALERT</Text>

              <View style={styles.scamCard}>
                <View style={styles.scamHeaderRow}>
                  <View style={styles.scamTitleCol}>
                    <View style={styles.scamIconTag}>
                      <Ionicons name="alert-circle" size={16} color={colors.threat} />
                      <Text style={styles.scamTagText}>Potential scam detected</Text>
                    </View>
                    <Text style={styles.callerName}>{activeCallAlert.callerName}</Text>
                    <Text style={styles.callerNumberText}>{activeCallAlert.callerNumber}</Text>
                    <Text style={styles.callerTime}>{activeCallAlert.timeDetected}</Text>
                  </View>
                  <StatusBadge label={activeCallAlert.riskLevel} status="high" />
                </View>

                {/* Detected Indicators */}
                <View style={styles.indicatorsBox}>
                  <Text style={styles.indicatorsHeading}>SIGNAL ANALYSIS</Text>
                  {activeCallAlert.signals.map((sig, idx) => (
                    <View key={idx} style={styles.indicatorBullet}>
                      <Ionicons name="close-circle" size={14} color={colors.threat} />
                      <Text style={styles.indicatorText}>{sig}</Text>
                    </View>
                  ))}
                </View>

                {/* Actions */}
                <View style={styles.scamActionsRow}>
                  <Button
                    label="REPORT CALL"
                    icon="alert-circle"
                    onPress={handleReportCall}
                    loading={isActing}
                    disabled={isActing}
                    variant="destructive"
                    size="md"
                    style={{ flex: 1 }}
                  />
                  <Button
                    label="MARK AS SAFE"
                    icon="checkmark-circle"
                    onPress={handleMarkCallSafe}
                    loading={isActing}
                    disabled={isActing}
                    variant="secondary"
                    size="md"
                    style={{ flex: 1 }}
                  />
                </View>
              </View>
            </View>
          )}

          {/* 5. Bank Statement & Behavioral Baseline */}
          <StaggerRevealCard
            index={2}
            baseDelay={60}
            hasPlayed={hasPlayedProtectionStaggerRef.current}
            style={styles.section}
          >
            <Text style={styles.sectionHeading}>BEHAVIORAL BASELINE & STATEMENTS</Text>
            <StatementUploadCard
              userId={session?.userId ?? 0}
              onFileSelected={(file) => {
                showToast(`Statement selected: ${file.name}`, "info");
              }}
              onFileRemoved={() => {
                showToast("Statement removed", "info");
              }}
              onUploadSuccess={(receipt) => {
                lastStatementReceiptRef.current = receipt;
                showToast(
                  receipt.trained
                    ? `Baseline calculated: typical payment ~₹${receipt.p50_amount?.toFixed(0) ?? "?"}`
                    : receipt.status === "FAILED"
                    ? receipt.message || "Statement could not be processed"
                    : `Parsed ${receipt.parsed_rows ?? 0} transaction(s) from your statement`,
                  receipt.status === "FAILED" ? "warning" : "success"
                );
              }}
              onUploadError={(err) => {
                showToast(
                  err.message || "Statement upload failed",
                  "warning"
                );
              }}
              // This endpoint (POST /api/v1/users/{userId}/statement/upload)
              // is always synchronous — the upload response IS the final
              // result, there's no async job to poll. statusFn short-
              // circuits the "Refresh Status" button to just re-confirm
              // that, instead of hitting the unrelated OCR-preview
              // endpoint's /api/v1/statements/{upload_id}/status (which
              // has no record of this upload_id and would 404).
              //
              // It must echo the REAL last receipt, not a fixed value —
              // this used to hardcode status: "COMPLETED" unconditionally,
              // so refreshing after a genuinely FAILED parse silently
              // relabeled it as successful.
              statusFn={async (uploadId) => {
                const receipt = lastStatementReceiptRef.current;
                return {
                  status: 200,
                  data: {
                    upload_id: uploadId,
                    user_id: session?.userId ?? 0,
                    filename: receipt?.filename ?? "",
                    status: (receipt?.status as "RECEIVED" | "PROCESSING" | "COMPLETED" | "FAILED") ?? "FAILED",
                    message:
                      receipt?.message ??
                      "No record of this upload — it may not have completed.",
                    created_at: receipt?.uploaded_at ?? new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    error_detail: null,
                  },
                };
              }}
            />
          </StaggerRevealCard>

          {/* 6. Recent Security Alerts */}
          <StaggerRevealCard
            index={3}
            baseDelay={60}
            hasPlayed={hasPlayedProtectionStaggerRef.current}
            style={styles.section}
          >
            <Text style={styles.sectionHeading}>RECENT SECURITY ALERTS</Text>

            <View style={styles.alertsCard}>
              {alerts.length === 0 ? (
                <Text style={styles.emptyText}>No recent alerts detected.</Text>
              ) : (
                alerts.map((a, idx) => (
                  <TouchableOpacity
                    key={a.id}
                    style={[
                      styles.alertItem,
                      idx === alerts.length - 1 && styles.alertItemNoBorder,
                    ]}
                    onPress={() => setSelectedAlertForModal(a)}
                    activeOpacity={0.75}
                  >
                    <View style={styles.alertItemTop}>
                      <View style={styles.alertTitleRow}>
                        <Ionicons
                          name={
                            a.severity === "HIGH"
                              ? "alert-circle"
                              : "information-circle-outline"
                          }
                          size={16}
                          color={a.severity === "HIGH" ? colors.threat : colors.brand}
                        />
                        <Text style={styles.alertTitle}>{a.title}</Text>
                      </View>
                      <StatusBadge
                        label={a.severity}
                        status={a.severity === "HIGH" ? "high" : "low"}
                      />
                    </View>
                    <Text style={styles.alertDesc}>{a.description}</Text>
                    <View style={styles.alertFooter}>
                      <Text style={styles.alertTimestamp}>{a.timestamp}</Text>
                      {a.transactionId ? (
                        <TouchableOpacity
                          onPress={(e) => {
                            e.stopPropagation?.();
                            handleViewPayment(a.transactionId!);
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={styles.viewRelatedLink}>View Payment →</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </View>
          </StaggerRevealCard>
        </ScrollView>
      )}

      {/* Module Configuration Modals */}
      <ProtectionModuleModal
        visible={activeModuleModal === "payment"}
        onClose={() => setActiveModuleModal(null)}
        moduleKey="payment"
        title="Payment Protection"
        desc="Pre-transaction anomaly scoring & threat interception"
        icon="card-outline"
        isEnabled={paymentProtectionEnabled}
        onToggle={handleTogglePaymentProtection}
        features={PAYMENT_FEATURES}
      />

      <ProtectionModuleModal
        visible={activeModuleModal === "risk"}
        onClose={() => setActiveModuleModal(null)}
        moduleKey="risk"
        title="Risk Detection Engine"
        desc="Device keystore, behavioral & transaction delta analysis"
        icon="pulse-outline"
        isEnabled={riskDetectionEnabled}
        onToggle={handleToggleRiskDetection}
        features={RISK_FEATURES}
      />

      <ProtectionModuleModal
        visible={activeModuleModal === "call"}
        onClose={() => setActiveModuleModal(null)}
        moduleKey="call"
        title="Call & Social Engineering Protection"
        desc="Real-time voice stream heuristics & scam caller detection"
        icon="call-outline"
        isEnabled={callProtectionEnabled}
        onToggle={handleToggleCallProtection}
        features={CALL_FEATURES}
      />

      {/* Alert Details Modal */}
      <AlertDetailsModal
        alert={selectedAlertForModal}
        visible={selectedAlertForModal !== null}
        onClose={() => setSelectedAlertForModal(null)}
        onResolve={handleResolveAlert}
        onViewPayment={handleViewPayment}
      />

      {/* Floating Toast notification */}
      <FloatingToast config={toastConfig} onDismiss={() => setToastConfig(null)} />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tryLiveDemoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  tryLiveDemoText: {
    ...typography.bodySemibold,
    color: colors.brand,
    fontSize: 13,
  },
  titleSection: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    marginBottom: spacing.xs,
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
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1.2,
    borderColor: colors.border,
    ...shadows.lg,
  },
  statusIconBox: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: "rgba(23, 107, 91, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  statusTextCol: {
    flex: 1,
  },
  statusTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
  statusSub: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "800",
    letterSpacing: 0.6,
    fontSize: 11,
    marginBottom: spacing.xs,
  },
  moduleCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    ...shadows.sm,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
  moduleTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  moduleLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    flex: 1,
  },
  moduleIconCircle: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  moduleTitle: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  moduleDesc: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  scamCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1.2,
    borderColor: colors.threatBorder,
    padding: spacing.lg,
    ...shadows.lg,
  },
  scamHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.sm,
  },
  scamTitleCol: {
    flex: 1,
  },
  scamIconTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  scamTagText: {
    ...typography.smallSemibold,
    color: colors.threatText,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  callerName: {
    ...typography.h3,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
  callerNumberText: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 13,
    marginTop: 1,
  },
  callerTime: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  indicatorsBox: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    padding: spacing.md,
    marginVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  indicatorsHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
  },
  indicatorBullet: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginVertical: 3,
  },
  indicatorText: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
  },
  scamActionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  alertsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    ...shadows.sm,
  },
  emptyText: {
    ...typography.small,
    color: colors.textMuted,
    paddingVertical: spacing.lg,
    textAlign: "center",
  },
  alertItem: {
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
  alertItemNoBorder: {
    borderBottomWidth: 0,
  },
  alertItemTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
    gap: spacing.sm,
  },
  alertTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    flex: 1,
  },
  alertTitle: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  alertDesc: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  alertFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  alertTimestamp: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
  },
  viewRelatedLink: {
    ...typography.smallSemibold,
    color: colors.brand,
    fontSize: 12,
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
});
