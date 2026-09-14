import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing, radii, shadows } from "../theme/layout";
import { Header } from "../components/common/Header";
import { StatusBadge } from "../components/common/StatusBadge";
import { RiskGauge } from "../components/common/RiskGauge";
import { StaggerRevealCard } from "../components/common/StaggerRevealCard";
import { useAuth } from "../context/AuthContext";
import { useGuardian } from "../context/GuardianContext";
import { useAlertBadge } from "../context/AlertBadgeContext";
import { useSecurity } from "../context/SecurityContext";
import {
  PaymentService,
  UserPaymentOverview,
  UserTransaction,
  EMPTY_PAYMENT_OVERVIEW,
} from "../services/payment-service";
import { NotificationDropdown } from "../components/guardian/NotificationDropdown";
import { GuardianApprovalCard } from "../components/guardian/GuardianApprovalCard";
import { LinearGradient } from "expo-linear-gradient";
import {
  getRiskLevelFromScore,
  getStatusBadgeProps,
  validateAndLogRiskState,
} from "../utils/risk-scoring";

export const HomeScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { session, isPostLoginLoading } = useAuth();
  const { alerts: securityAlerts } = useSecurity();
  const {
    pendingRequests,
    notificationBadge,
    openApprovalCard,
    closeApprovalCard,
    approvalCard,
    respondToRequest,
    clearNotificationBadge,
  } = useGuardian();

  const [notifDropdownOpen, setNotifDropdownOpen] = useState(false);

  const [overview, setOverview] = useState<UserPaymentOverview>(EMPTY_PAYMENT_OVERVIEW);
  const [recentTxns, setRecentTxns] = useState<UserTransaction[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Increments once when the post-login splash finishes — replays the gauge animation visibly
  const [animationTrigger, setAnimationTrigger] = useState(0);
  // Tracks if we saw isPostLoginLoading=true (fresh login), so we know to replay on splash clear
  const wasPostLoginLoadingRef = useRef(false);
  // Tracks whether the initial card stagger animation has played in this session
  const hasPlayedHomeStaggerRef = useRef(false);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const userId = session?.userId || 1;
      const [ovData, txnData] = await Promise.all([
        PaymentService.getOverview(userId),
        PaymentService.getTransactions(userId, "all", 5, 0),
      ]);
      setOverview(ovData);
      setRecentTxns(txnData.items);
    } catch (e: any) {
      setError("Unable to sync latest financial protection data.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [session?.userId]);

  useEffect(() => {
    loadData();

    // Real-time synchronization subscription with PaymentService
    const unsubscribe = PaymentService.subscribe((updatedOverview, updatedTxns) => {
      setOverview(updatedOverview);
      setRecentTxns(updatedTxns.slice(0, 5));
    });

    return unsubscribe;
  }, [loadData]);

  // Replay the gauge animation exactly once when the post-login splash clears.
  // isPostLoginLoading goes true→false only during a fresh login (never during session restore).
  // Tab switching never changes this value, so the animation never replays on tab switches.
  useEffect(() => {
    if (isPostLoginLoading) {
      // Record that we are in a post-login splash flow
      wasPostLoginLoadingRef.current = true;
      return;
    }
    // isPostLoginLoading just became false
    if (wasPostLoginLoadingRef.current) {
      wasPostLoginLoadingRef.current = false;
      // Splash has fully faded out — replay the gauge animation now that the screen is visible
      setAnimationTrigger((t) => t + 1);
    }
  }, [isPostLoginLoading]);

  // Mark initial home stagger as completed after reveal sequence
  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => {
        hasPlayedHomeStaggerRef.current = true;
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [isLoading]);

  const onRefresh = () => {
    setIsRefreshing(true);
    loadData();
  };

  const userName = session?.name ? session.name.split(" ")[0] : "Rahul";
  const unreadAlerts = securityAlerts.filter((a: any) => !a.isRead);
  const activeReviewTxns = recentTxns.filter((t) => t.status === "Risk detected" || t.status === "Held");
  const suspiciousTx =
    activeReviewTxns.length > 0
      ? activeReviewTxns.reduce(
          (max, cur) => ((cur.riskScore ?? 0) > (max.riskScore ?? 0) ? cur : max),
          activeReviewTxns[0]
        )
      : null;

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return "Good morning";
    if (hour >= 12 && hour < 17) return "Good afternoon";
    return "Good evening";
  };

  return (
    <View style={styles.screen}>
      <Header />

      {/* Notification dropdown (modal overlay, positioned near bell) */}
      <NotificationDropdown
        visible={notifDropdownOpen}
        requests={pendingRequests}
        onSelectRequest={(req) => {
          openApprovalCard(req);
          setNotifDropdownOpen(false);
        }}
        onDismiss={() => setNotifDropdownOpen(false)}
      />

      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={colors.brand} />
          <Text style={styles.loadingText}>Syncing Avaran security shield...</Text>
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
          {error ? (
            <View style={styles.errorBanner}>
              <Ionicons name="cloud-offline-outline" size={16} color={colors.textMuted} />
              <Text style={styles.errorBannerText}>{error}</Text>
              <TouchableOpacity onPress={loadData} style={styles.retryBtn}>
                <Text style={styles.retryBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {/* Greeting */}
          <View style={styles.greetingRow}>
            <Text style={styles.greetingTitle}>
              {getGreeting()}, {userName}
            </Text>
            <TouchableOpacity
              style={styles.notificationBtn}
              activeOpacity={0.7}
              accessibilityLabel="Notifications"
              accessibilityRole="button"
              onPress={() => {
                clearNotificationBadge();
                setNotifDropdownOpen((v) => !v);
              }}
            >
              <Ionicons
                name="notifications-outline"
                size={22}
                color={
                  notificationBadge > 0 || pendingRequests.length > 0
                    ? colors.threat
                    : colors.textSecondary
                }
              />
              {(notificationBadge > 0 || pendingRequests.length > 0) && (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>
                    {notificationBadge > 0 ? notificationBadge : pendingRequests.length}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>

          {/* Guardian approval card (shown when guardian taps a notification) */}
          {approvalCard && (
            <GuardianApprovalCard
              request={approvalCard}
              onConfirm={() => respondToRequest(approvalCard.id, "APPROVED")}
              onReject={() => respondToRequest(approvalCard.id, "REJECTED")}
              onDismiss={closeApprovalCard}
            />
          )}

          {/* Protection Status Banner */}
          <View
            style={[
              styles.protectionBanner,
              overview.protectionStatus === "ATTENTION REQUIRED" && styles.protectionBannerAttention,
            ]}
          >
            <Ionicons
              name={overview.protectionStatus === "PROTECTED" ? "shield-checkmark" : "warning"}
              size={18}
              color={overview.protectionStatus === "PROTECTED" ? colors.safe : colors.caution}
            />
            <Text
              style={[
                styles.protectionText,
                overview.protectionStatus === "ATTENTION REQUIRED" && styles.protectionTextAttention,
              ]}
            >
              {overview.protectionStatus === "PROTECTED"
                ? "Protected — Your payments are being monitored."
                : "Attention required — 1 transaction needs review."}
            </Text>
          </View>

          {/* 1. HERO (PRIMARY): CURRENT RISK STATUS */}
          <View style={styles.heroSection}>
            <View style={styles.heroHeaderRow}>
              <Text style={styles.heroSectionHeading}>CURRENT RISK STATUS</Text>
            </View>

            <LinearGradient
              colors={
                (overview.currentRiskLevel || getRiskLevelFromScore(overview.currentRiskScore)) === "HIGH"
                  ? ["#FFFFFF", "rgba(247,238,236,0.7)"]
                  : (overview.currentRiskLevel || getRiskLevelFromScore(overview.currentRiskScore)) === "MEDIUM"
                  ? ["#FFFFFF", "rgba(254,243,199,0.5)"]
                  : ["#FFFFFF", "rgba(234,243,240,0.7)"]
              }
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[
                styles.heroRiskCard,
                (overview.currentRiskLevel || getRiskLevelFromScore(overview.currentRiskScore)) === "HIGH"
                  ? styles.heroRiskCardHigh
                  : styles.heroRiskCardLow,
              ]}
            >
              <RiskGauge
                score={Math.round(overview?.currentRiskScore ?? 0)}
                riskLevel={overview?.currentRiskLevel || getRiskLevelFromScore(overview?.currentRiskScore ?? 0)}
                size="md"
                animationTrigger={animationTrigger}
                enableRevealAnimation={true}
              />
            </LinearGradient>
          </View>

          {/* 2. SECONDARY (ACTIONABLE): NEEDS YOUR ATTENTION */}
          {suspiciousTx ? (() => {
            const attScore = suspiciousTx.riskScore ?? 0;
            const attLevel = suspiciousTx.riskLevel || getRiskLevelFromScore(attScore);
            const attBadge = getStatusBadgeProps(attLevel);
            validateAndLogRiskState({
              component: "HomeScreen:AttentionCard",
              transactionId: suspiciousTx.id,
              riskScore: attScore,
              riskLevel: attLevel,
            });

            return (
              <StaggerRevealCard
                index={0}
                baseDelay={1350}
                hasPlayed={hasPlayedHomeStaggerRef.current}
                style={styles.section}
              >
                <Text style={styles.sectionHeading}>NEEDS YOUR ATTENTION</Text>

                <TouchableOpacity
                  style={styles.attentionCard}
                  onPress={() => navigation.navigate("Payments", { selectedTxId: suspiciousTx.id })}
                  activeOpacity={0.85}
                >
                  <View style={styles.attentionTop}>
                    <View style={styles.attentionIconBox}>
                      <Ionicons
                        name="warning"
                        size={18}
                        color={attLevel === "HIGH" ? colors.threat : attLevel === "MEDIUM" ? colors.caution : colors.safe}
                      />
                    </View>
                    <View style={styles.attentionTextCol}>
                      <Text style={styles.attentionMerchant}>{suspiciousTx.merchant}</Text>
                      <Text style={styles.attentionAmount}>
                        ₹{(suspiciousTx?.amount ?? 0).toLocaleString("en-IN")}
                      </Text>
                    </View>
                    <StatusBadge label={attBadge.label} status={attBadge.status} dot={false} />
                  </View>

                  <View style={styles.attentionBottom}>
                    <Text style={styles.riskScoreText}>
                      Risk score: {suspiciousTx.riskScore ?? "—"}/100
                    </Text>
                    <View style={styles.reviewBtn}>
                      <Text style={styles.reviewBtnText}>Review Payment →</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              </StaggerRevealCard>
            );
          })() : null}

          {/* 3. SECONDARY (ALERTS): SECURITY ALERTS */}
          <StaggerRevealCard
            index={suspiciousTx ? 1 : 0}
            baseDelay={1350}
            hasPlayed={hasPlayedHomeStaggerRef.current}
            style={styles.section}
          >
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeading}>SECURITY ALERTS</Text>
              <TouchableOpacity onPress={() => navigation.navigate("Protection")}>
                <Text style={styles.seeAllText}>View center</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.alertSummaryCard}>
              <Ionicons
                name={unreadAlerts.length > 0 ? "notifications-circle" : "checkmark-circle"}
                size={20}
                color={unreadAlerts.length > 0 ? colors.threat : colors.safe}
              />
              <View style={styles.alertTextCol}>
                <Text style={styles.alertSummaryTitle}>
                  {unreadAlerts.length > 0
                    ? `${unreadAlerts.length} Security Alert${unreadAlerts.length > 1 ? "s" : ""}`
                    : "All Security Alerts Resolved"}
                </Text>
                <Text style={styles.alertSummarySub}>
                  {unreadAlerts.length > 0
                    ? "Unusual activity flagged for review."
                    : "No active payment threats detected."}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.viewAlertsBtn}
                onPress={() => navigation.navigate("Protection")}
              >
                <Text style={styles.viewAlertsBtnText}>VIEW</Text>
              </TouchableOpacity>
            </View>
          </StaggerRevealCard>

          {/* 4. SUPPORTING: PAYMENT OVERVIEW */}
          <StaggerRevealCard
            index={suspiciousTx ? 2 : 1}
            baseDelay={1350}
            hasPlayed={hasPlayedHomeStaggerRef.current}
            style={styles.section}
          >
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeading}>PAYMENT OVERVIEW</Text>
              <TouchableOpacity onPress={() => navigation.navigate("Payments")}>
                <Text style={styles.seeAllText}>View all</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.overviewCard}>
              <Text style={styles.overviewLabel}>Total this month</Text>
              <Text style={styles.totalAmount}>
                ₹{(overview?.totalAmountThisMonth ?? 0).toLocaleString("en-IN")}
              </Text>
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statNumber}>{overview?.transactionCount ?? 0}</Text>
                  <Text style={styles.statLabel}>Total</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statItem}>
                  <Text style={[styles.statNumber, { color: colors.safe }]}>{overview?.safeCount ?? 0}</Text>
                  <Text style={styles.statLabel}>Safe</Text>
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statItem}>
                  <Text style={[styles.statNumber, { color: colors.threat }]}>{overview?.needsReviewCount ?? 0}</Text>
                  <Text style={styles.statLabel}>Needs attention</Text>
                </View>
              </View>
            </View>
          </StaggerRevealCard>

          {/* 5. SUPPORTING: RECENT PAYMENTS */}
          <StaggerRevealCard
            index={suspiciousTx ? 3 : 2}
            baseDelay={1350}
            hasPlayed={hasPlayedHomeStaggerRef.current}
            style={styles.section}
          >
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeading}>RECENT PAYMENTS</Text>
              <TouchableOpacity onPress={() => navigation.navigate("Payments")}>
                <Text style={styles.seeAllText}>See all</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.paymentListCard}>
              {recentTxns.length === 0 ? (
                <Text style={styles.emptyText}>No recent transactions recorded.</Text>
              ) : (
                recentTxns.map((item, idx) => {
                  const isRisk = item.status === "Risk detected" || item.status === "Held";
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[
                        styles.paymentItem,
                        idx === recentTxns.length - 1 && styles.paymentItemNoBorder,
                      ]}
                      onPress={() => navigation.navigate("Payments", { selectedTxId: item.id })}
                      activeOpacity={0.78}
                    >
                      {/* Left icon identifier */}
                      <View style={[styles.paymentIconBox, isRisk && styles.paymentIconBoxRisk]}>
                        <Ionicons
                          name={isRisk ? "warning" : "checkmark-circle"}
                          size={17}
                          color={isRisk ? colors.threat : colors.safe}
                        />
                      </View>
                      {/* Merchant + meta */}
                      <View style={styles.paymentItemLeft}>
                        <Text style={styles.paymentMerchant} numberOfLines={1}>{item.merchant}</Text>
                        <Text style={styles.paymentDate}>{item.paymentMethod} · {item.date}</Text>
                      </View>
                      {/* Amount + badge */}
                      <View style={styles.paymentItemRight}>
                        <Text
                          style={[
                            styles.paymentAmount,
                            isRisk && { color: colors.threat },
                          ]}
                        >
                          ₹{(item?.amount ?? 0).toLocaleString("en-IN")}
                        </Text>
                        <StatusBadge
                          label={
                            isRisk
                              ? `${item.riskLevel || getRiskLevelFromScore(item.riskScore ?? 0)} RISK`
                              : item.status === "Reported"
                              ? "Reported"
                              : "Safe"
                          }
                          status={
                            isRisk
                              ? ((item.riskLevel || getRiskLevelFromScore(item.riskScore ?? 0)) === "HIGH" ? "high" : (item.riskLevel || getRiskLevelFromScore(item.riskScore ?? 0)) === "MEDIUM" ? "medium" : "low")
                              : item.status === "Reported"
                              ? "escalated"
                              : "low"
                          }
                          dot={false}
                        />
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </StaggerRevealCard>
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
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
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  errorBannerText: {
    ...typography.small,
    color: colors.textSecondary,
    flex: 1,
    fontSize: 13,
  },
  retryBtn: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
  },
  retryBtnText: {
    ...typography.smallSemibold,
    fontWeight: "700",
    color: colors.brand,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  greetingTitle: {
    ...typography.h2,
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: "700",
    flex: 1,
  },
  notificationBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.sm,
  },
  protectionBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  protectionBannerAttention: {
    borderColor: colors.cautionBorder,
  },
  protectionText: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 13,
    flex: 1,
  },
  protectionTextAttention: {
    color: colors.textPrimary,
  },
  heroSection: {
    marginBottom: spacing.xl,
  },
  heroHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  heroHeadingLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  heroSectionHeading: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "800",
    letterSpacing: 0.8,
    fontSize: 11,
  },
  liveShieldPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
    backgroundColor: colors.safeSurface,
    borderWidth: 1,
    borderColor: colors.safeBorder,
  },
  liveShieldPillAttention: {
    backgroundColor: colors.cautionSurface,
    borderColor: colors.cautionBorder,
  },
  liveShieldText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  heroRiskCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1.2,
    borderColor: colors.border,
    paddingVertical: spacing.lg + 2,
    paddingHorizontal: spacing.lg,
    ...shadows.lg,
  },
  heroRiskCardHigh: {
    borderColor: "rgba(163, 61, 53, 0.25)",
    backgroundColor: "#FFFFFF",
  },
  heroRiskCardLow: {
    borderColor: "rgba(23, 107, 91, 0.25)",
    backgroundColor: "#FFFFFF",
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  sectionHeading: {
    ...typography.caption,
    color: colors.textMuted,
    fontWeight: "700",
    letterSpacing: 0.6,
    fontSize: 11,
  },
  seeAllText: {
    ...typography.smallSemibold,
    color: colors.textPrimary,
    fontSize: 13,
  },
  overviewCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.lg,
    ...shadows.sm,
  },
  overviewLabel: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 13,
  },
  totalAmount: {
    ...typography.amountLarge,
    color: colors.textPrimary,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  statItem: {
    flex: 1,
    alignItems: "center",
  },
  statNumber: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  statLabel: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: colors.borderLight,
  },
  attentionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: "rgba(220, 38, 38, 0.35)",
    padding: spacing.lg,
    ...shadows.sm,
  },
  attentionTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  attentionIconBox: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  attentionTextCol: {
    flex: 1,
  },
  attentionMerchant: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 15,
  },
  attentionAmount: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: "700",
    fontSize: 17,
    marginTop: 1,
  },
  attentionBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.md,
  },
  riskScoreText: {
    ...typography.small,
    color: colors.textMuted,
    fontWeight: "600",
    fontSize: 13,
  },
  reviewBtn: {
    backgroundColor: colors.btnPrimaryBg,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
  },
  reviewBtnText: {
    ...typography.smallSemibold,
    color: colors.btnPrimaryText,
    fontSize: 12,
  },
  paymentListCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadows.sm,
  },
  paymentItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 1,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surface,
  },
  paymentIconBox: {
    width: 32,
    height: 32,
    borderRadius: radii.sm + 2,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  paymentIconBoxRisk: {
    backgroundColor: "rgba(163,61,53,0.07)",
    borderColor: colors.threatBorder,
  },
  paymentItemNoBorder: {
    borderBottomWidth: 0,
  },
  paymentItemLeft: {
    flex: 1,
    paddingRight: spacing.xs,
  },
  paymentMerchant: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 13.5,
  },
  paymentDate: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  paymentItemRight: {
    alignItems: "flex-end",
    gap: 4,
    flexShrink: 0,
  },
  paymentAmount: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontWeight: "600",
    fontSize: 14,
    letterSpacing: -0.2,
  },
  emptyText: {
    ...typography.body,
    color: colors.textMuted,
    paddingVertical: spacing.xl,
    textAlign: "center",
  },
  alertSummaryCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadows.sm,
  },
  alertTextCol: {
    flex: 1,
  },
  alertSummaryTitle: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 14,
  },
  alertSummarySub: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  viewAlertsBtn: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radii.sm,
  },
  viewAlertsBtnText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: "700",
    fontSize: 10,
  },
  bellBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: colors.threat,
    borderRadius: radii.full,
    minWidth: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
    borderWidth: 1.5,
    borderColor: colors.surface,
  },
  bellBadgeText: {
    color: colors.textInverse,
    fontSize: 9,
    fontWeight: "800",
    lineHeight: 11,
  },
});
