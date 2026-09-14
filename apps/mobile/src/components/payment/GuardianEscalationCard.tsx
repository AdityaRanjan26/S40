import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../theme/colors";
import { typography } from "../../theme/typography";
import { spacing, radii } from "../../theme/layout";
import { StatusBadge } from "../common/StatusBadge";
import { Button } from "../common/Button";
import { AiScanBanner } from "../common/AiScanBanner";
import {
  PreparedPaymentDraft,
  GuardianEscalationState,
} from "../../types/transaction";
import { PaymentEvaluationData } from "../../services/payment-service";

interface GuardianEscalationCardProps {
  guardianState: GuardianEscalationState;
  draft: PreparedPaymentDraft;
  evaluationData?: PaymentEvaluationData;
  onRequestApproval: () => void;
  onRetry: () => void;
  onEditDetails?: () => void;
  isRequesting?: boolean;
  onProceedToPayment?: () => void;
  isProceedingToPayment?: boolean;
}

export const GuardianEscalationCard: React.FC<GuardianEscalationCardProps> = ({
  guardianState,
  draft,
  evaluationData,
  onRequestApproval,
  onRetry,
  onEditDetails,
  isRequesting = false,
  onProceedToPayment,
  isProceedingToPayment = false,
}) => {
  const { status, error, blockerNotice, remainingSeconds, requestId, resolutionNotes } =
    guardianState;

  if (status === "IDLE") {
    return null;
  }

  // ── 1. REQUESTING APPROVAL (LOADING) ───────────────────────────────────────
  if (status === "REQUESTING_APPROVAL") {
    return (
      <View
        style={styles.container}
        accessibilityRole="summary"
        accessibilityLabel="Requesting Guardian approval"
        testID="guardian-requesting-card"
      >
        <AiScanBanner isAnalyzing={true} />
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color={colors.brand} />
          <View style={{ flex: 1 }}>
            <Text style={styles.loadingTitle}>Dispatching Guardian Escalation...</Text>
            <Text style={styles.loadingSubtitle}>
              Connecting to designated trusted contact with transaction evaluation telemetry.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  // ── 2. APPROVAL REQUIRED (INITIAL HIGH-RISK GATE) ──────────────────────────
  if (status === "APPROVAL_REQUIRED") {
    return (
      <View
        style={[styles.container, { borderColor: colors.threat }]}
        accessibilityRole="alert"
        accessibilityLabel="Guardian approval required"
        testID="guardian-approval-required-card"
      >
        {/* Threat Header */}
        <View style={[styles.headerBanner, { backgroundColor: colors.threat + "18" }]}>
          <Ionicons name="shield-half-outline" size={20} color={colors.threat} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerBannerTitle, { color: colors.threat }]}>
              GUARDIAN APPROVAL REQUIRED
            </Text>
            <Text style={styles.headerBannerSubtitle}>
              High risk evaluation score detected. Family Shield approval must be granted before payment authorization.
            </Text>
          </View>
          <StatusBadge label="HIGH RISK GATE" status="high" dot={true} />
        </View>

        {/* Evaluation Context Summary */}
        <View style={styles.detailsGrid}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Intended Payee</Text>
            <Text style={styles.detailValue} numberOfLines={1}>
              {draft.recipient}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Amount</Text>
            <Text style={[styles.detailValue, { color: colors.threat, fontWeight: "800" }]}>
              ₹{draft.amount.toFixed(2)}
            </Text>
          </View>

          {evaluationData?.risk_score !== undefined && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Authoritative Risk Score</Text>
              <Text style={[styles.detailValue, { color: colors.threat, fontWeight: "700" }]}>
                {evaluationData.risk_score} / 100 ({evaluationData.risk_level})
              </Text>
            </View>
          )}

          {evaluationData?.evaluation_id && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Evaluation Ref</Text>
              <Text style={styles.evalIdText} numberOfLines={1}>
                {evaluationData.evaluation_id}
              </Text>
            </View>
          )}
        </View>

        {/* Reasons Bullet List */}
        {evaluationData?.plain_language_reasons &&
          evaluationData.plain_language_reasons.length > 0 && (
            <View style={styles.reasonsBox}>
              <Text style={styles.reasonsHeading}>Flagged Security Signals:</Text>
              {evaluationData.plain_language_reasons.map((reason: string, idx: number) => (
                <View key={idx} style={styles.reasonRow}>
                  <Ionicons name="alert-circle" size={13} color={colors.threat} style={{ marginTop: 2 }} />
                  <Text style={styles.reasonText}>{reason}</Text>
                </View>
              ))}
            </View>
          )}

        {/* Mandatory Strict Boundary Notice */}
        <View style={styles.boundaryNoticeBox} testID="guardian-boundary-notice">
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.boundaryNoticeText}>
            Guardian approval is required before payment authorization. No payment has been submitted or settled.
          </Text>
        </View>

        {/* Actions */}
        {/* Routes through onProceedToPayment (persists the real transaction,
            same as the LOW/MEDIUM path) rather than this card's own
            onRequestApproval -- that call targets
            POST /api/v1/guardian/requests/evaluation, which has no backend
            route (only POST /api/v1/guardian/requests exists, and it
            requires a real transaction_id). Once persisted, the
            already-working transaction-detail Guardian flow (useGuardian()'s
            initiateGuardianRequest + live polling) takes over correctly
            instead of this dead-end pre-transaction request. */}
        <View style={styles.actionsRow}>
          {onProceedToPayment ? (
            <Button
              label={isProceedingToPayment ? "Preparing Payment..." : "PROCEED TO GUARDIAN REVIEW"}
              icon="people"
              variant="primary"
              size="sm"
              loading={isProceedingToPayment}
              disabled={isProceedingToPayment}
              onPress={onProceedToPayment}
              testID="proceed-to-guardian-review-btn"
              style={{ flex: 2 }}
            />
          ) : (
            <Button
              label="REQUEST GUARDIAN APPROVAL"
              icon="people"
              variant="primary"
              size="sm"
              loading={isRequesting}
              onPress={onRequestApproval}
              testID="request-guardian-approval-btn"
              style={{ flex: 2 }}
            />
          )}
          {onEditDetails && (
            <Button
              label="EDIT"
              icon="create-outline"
              variant="outline"
              size="sm"
              disabled={isProceedingToPayment}
              onPress={onEditDetails}
              testID="edit-from-guardian-btn"
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    );
  }

  // ── 3. APPROVAL PENDING (HOLD COUNTDOWN) ────────────────────────────────────
  if (status === "APPROVAL_PENDING") {
    const displaySeconds = remainingSeconds ?? 120;
    const mins = Math.floor(displaySeconds / 60);
    const secs = displaySeconds % 60;
    const timeFormatted = `${mins}:${secs < 10 ? "0" : ""}${secs}`;

    return (
      <View
        style={[styles.container, { borderColor: colors.caution }]}
        accessibilityRole="summary"
        accessibilityLabel="Guardian approval pending hold"
        testID="guardian-pending-card"
      >
        <View style={[styles.headerBanner, { backgroundColor: colors.caution + "18" }]}>
          <Ionicons name="time" size={20} color={colors.caution} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerBannerTitle, { color: colors.caution }]}>
              HOLD FOR GUARDIAN APPROVAL
            </Text>
            <Text style={styles.headerBannerSubtitle}>
              Approval request active. Awaiting decision from your designated Family Guardian.
            </Text>
          </View>
          <StatusBadge label="PENDING HOLD" status="medium" dot={true} />
        </View>

        {/* Countdown Box */}
        <View style={styles.countdownBox} testID="guardian-countdown-box">
          <Text style={styles.countdownLabel}>Time Remaining in Hold Window</Text>
          <Text style={styles.countdownTime}>{timeFormatted}</Text>
          {requestId && (
            <Text style={styles.requestIdText}>Request ID: {requestId}</Text>
          )}
        </View>

        {/* Boundary Notice */}
        <View style={styles.boundaryNoticeBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.boundaryNoticeText}>
            Guardian approval is required before payment authorization. No payment has been submitted or settled.
          </Text>
        </View>

        {/* Actions */}
        <View style={styles.actionsRow}>
          {onEditDetails && (
            <Button
              label="CANCEL & EDIT"
              icon="close-outline"
              variant="outline"
              size="sm"
              onPress={onEditDetails}
              testID="cancel-pending-guardian-btn"
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    );
  }

  // ── 4. APPROVED STATE ──────────────────────────────────────────────────────
  if (status === "APPROVED") {
    return (
      <View
        style={[styles.container, { borderColor: colors.safe }]}
        accessibilityRole="alert"
        accessibilityLabel="Guardian approval granted"
        testID="guardian-approved-card"
      >
        <View style={[styles.headerBanner, { backgroundColor: colors.safe + "18" }]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.safe} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerBannerTitle, { color: colors.safe }]}>
              GUARDIAN APPROVAL GRANTED
            </Text>
            <Text style={styles.headerBannerSubtitle}>
              Trusted contact verified and approved this transaction. Security gate satisfied.
            </Text>
          </View>
          <StatusBadge label="APPROVED" status="resolved" dot={true} />
        </View>

        {resolutionNotes && (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>Guardian Note:</Text>
            <Text style={styles.notesText}>{resolutionNotes}</Text>
          </View>
        )}

        <View style={styles.boundaryNoticeBox}>
          <Ionicons name="shield-checkmark-outline" size={14} color={colors.safe} />
          <Text style={styles.boundaryNoticeText}>
            Guardian gate satisfied. Ready to proceed to payment authorization preparation.
          </Text>
        </View>
      </View>
    );
  }

  // ── 5. DECLINED STATE ──────────────────────────────────────────────────────
  if (status === "DECLINED") {
    return (
      <View
        style={[styles.container, { borderColor: colors.threat }]}
        accessibilityRole="alert"
        accessibilityLabel="Guardian declined payment"
        testID="guardian-declined-card"
      >
        <View style={[styles.headerBanner, { backgroundColor: colors.threat + "18" }]}>
          <Ionicons name="close-circle" size={22} color={colors.threat} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerBannerTitle, { color: colors.threat }]}>
              GUARDIAN DECLINED PAYMENT
            </Text>
            <Text style={styles.headerBannerSubtitle}>
              Your trusted contact reviewed this transaction and declined authorization for your safety.
            </Text>
          </View>
          <StatusBadge label="DECLINED" status="high" dot={true} />
        </View>

        {resolutionNotes && (
          <View style={styles.notesBox}>
            <Text style={styles.notesLabel}>Guardian Reason:</Text>
            <Text style={styles.notesText}>{resolutionNotes}</Text>
          </View>
        )}

        <View style={styles.boundaryNoticeBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.boundaryNoticeText}>
            This payment draft was not authorized. No funds were debited or transferred.
          </Text>
        </View>

        {onEditDetails && (
          <Button
            label="NEW PAYMENT"
            icon="refresh"
            variant="outline"
            size="sm"
            onPress={onEditDetails}
            testID="new-payment-after-declined-btn"
            style={{ marginTop: spacing.xs }}
          />
        )}
      </View>
    );
  }

  // ── 6. ERROR STATE ─────────────────────────────────────────────────────────
  if (status === "ERROR") {
    return (
      <View
        style={[styles.container, { borderColor: colors.threat }]}
        accessibilityRole="alert"
        accessibilityLabel="Guardian escalation error"
        testID="guardian-error-card"
      >
        <View style={styles.errorHeaderRow}>
          <Ionicons name="alert-circle" size={22} color={colors.threat} />
          <View style={{ flex: 1 }}>
            <Text style={styles.errorTitle}>Guardian Escalation Unavailable</Text>
            <Text style={styles.errorSubtitle}>
              {error || "Unable to dispatch approval request to trusted contact."}
            </Text>
          </View>
        </View>

        {blockerNotice && (
          <View style={styles.blockerNoticeBox} testID="guardian-blocker-notice">
            <Ionicons name="shield-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.blockerNoticeText}>{blockerNotice}</Text>
          </View>
        )}

        <View style={styles.boundaryNoticeBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.boundaryNoticeText}>
            Guardian approval is required before payment authorization. No payment has been submitted or settled.
          </Text>
        </View>

        <View style={styles.actionsRow}>
          <Button
            label="RETRY ESCALATION"
            icon="refresh"
            variant="primary"
            size="sm"
            onPress={onRetry}
            testID="retry-guardian-escalation-btn"
            style={{ flex: 1 }}
          />
          {onEditDetails && (
            <Button
              label="EDIT DETAILS"
              variant="outline"
              size="sm"
              onPress={onEditDetails}
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    );
  }

  // ── 7. EXPIRED STATE ───────────────────────────────────────────────────────
  if (status === "EXPIRED") {
    return (
      <View
        style={[styles.container, { borderColor: colors.caution }]}
        accessibilityRole="alert"
        accessibilityLabel="Guardian approval window expired"
        testID="guardian-expired-card"
      >
        <View style={styles.errorHeaderRow}>
          <Ionicons name="time-outline" size={22} color={colors.caution} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.errorTitle, { color: colors.caution }]}>
              Guardian Approval Window Expired
            </Text>
            <Text style={styles.errorSubtitle}>
              The 2-minute approval window elapsed without a response. For your security, the payment hold has expired.
            </Text>
          </View>
        </View>

        <View style={styles.boundaryNoticeBox}>
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.boundaryNoticeText}>
            Guardian approval is required before payment authorization. No payment has been submitted or settled.
          </Text>
        </View>

        <View style={styles.actionsRow}>
          <Button
            label="RE-REQUEST APPROVAL"
            icon="refresh"
            variant="primary"
            size="sm"
            onPress={onRetry}
            testID="re-request-guardian-btn"
            style={{ flex: 1 }}
          />
          {onEditDetails && (
            <Button
              label="EDIT DETAILS"
              variant="outline"
              size="sm"
              onPress={onEditDetails}
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    );
  }

  // ── 8. AUTHORIZATION READY STATE ───────────────────────────────────────────
  if (status === "AUTHORIZATION_READY") {
    const isLowRisk = evaluationData?.risk_level === "LOW";
    const guardianNotice = isLowRisk
      ? "No Guardian approval required (verified low risk)."
      : "Guardian approval verified and satisfied.";

    return (
      <View
        style={[styles.container, { borderColor: colors.brand }]}
        accessibilityRole="summary"
        accessibilityLabel="Payment authorization ready"
        testID="authorization-ready-card"
      >
        <View style={[styles.headerBanner, { backgroundColor: colors.brand + "18" }]}>
          <Ionicons name="shield-checkmark" size={22} color={colors.brand} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerBannerTitle, { color: colors.brand }]}>
              PAYMENT AUTHORIZATION READY
            </Text>
            <Text style={styles.headerBannerSubtitle}>{guardianNotice}</Text>
          </View>
          <StatusBadge label="READY FOR AUTH" status="resolved" dot={true} />
        </View>

        {/* Summary Grid */}
        <View style={styles.detailsGrid}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Intended Payee</Text>
            <Text style={styles.detailValue} numberOfLines={1}>
              {draft.recipient}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Prepared Amount</Text>
            <Text style={[styles.detailValue, { color: colors.brand, fontWeight: "800" }]}>
              ₹{draft.amount.toFixed(2)}
            </Text>
          </View>

          {evaluationData && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Risk Level & Score</Text>
              <Text style={styles.detailValue}>
                {evaluationData.risk_level} ({evaluationData.risk_score}/100)
              </Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Guardian Clearance</Text>
            <StatusBadge
              label={isLowRisk ? "EXEMPT (LOW RISK)" : "GUARDIAN APPROVED"}
              status="resolved"
              dot={false}
            />
          </View>
        </View>

        {/* Strict Non-Execution Phase Boundary Disclaimer */}
        <View style={styles.strictBoundaryBox} testID="authorization-boundary-notice">
          <Ionicons name="information-circle-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.strictBoundaryText}>
            AUTHORIZATION READY ONLY. NO PAYMENT HAS BEEN SUBMITTED OR SETTLED. NO UPI APP LAUNCHED.
          </Text>
        </View>

        {/* Proceed / Edit Actions */}
        <View style={styles.actionsRow}>
          {onProceedToPayment && (
            <Button
              label={isProceedingToPayment ? "Preparing Payment..." : "PROCEED TO PAY"}
              icon="arrow-forward-circle"
              variant="primary"
              size="sm"
              loading={isProceedingToPayment}
              disabled={isProceedingToPayment}
              onPress={onProceedToPayment}
              testID="proceed-to-payment-btn"
              style={{ flex: 2 }}
            />
          )}
          {onEditDetails && (
            <Button
              label="EDIT"
              icon="create-outline"
              variant="outline"
              size="sm"
              disabled={isProceedingToPayment}
              onPress={onEditDetails}
              testID="edit-from-auth-ready-btn"
              style={{ flex: 1 }}
            />
          )}
        </View>
      </View>
    );
  }

  return null;
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    borderWidth: 1.5,
    padding: spacing.md,
    marginVertical: spacing.xs,
    gap: spacing.sm,
  },
  loadingBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    borderRadius: radii.sm,
  },
  loadingTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  loadingSubtitle: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    marginTop: 2,
    lineHeight: 15,
  },
  headerBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.sm,
  },
  headerBannerTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  headerBannerSubtitle: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    marginTop: 1,
    lineHeight: 15,
  },
  detailsGrid: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: 6,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detailLabel: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  detailValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: "600",
    color: colors.textPrimary,
  },
  evalIdText: {
    fontSize: 10,
    color: colors.textMuted,
    fontFamily: "monospace",
  },
  reasonsBox: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: 4,
  },
  reasonsHeading: {
    fontSize: typography.caption.fontSize,
    fontWeight: "700",
    color: colors.textPrimary,
    marginBottom: 2,
  },
  reasonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  reasonText: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    flex: 1,
    lineHeight: 16,
  },
  boundaryNoticeBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.xs,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  boundaryNoticeText: {
    fontSize: 10,
    color: colors.textSecondary,
    fontWeight: "600",
    letterSpacing: 0.2,
    flex: 1,
    lineHeight: 14,
  },
  strictBoundaryBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radii.xs,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  strictBoundaryText: {
    fontSize: 9.5,
    color: colors.textSecondary,
    fontWeight: "700",
    letterSpacing: 0.2,
    flex: 1,
    lineHeight: 14,
  },
  countdownBox: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: "center",
    gap: 4,
  },
  countdownLabel: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  countdownTime: {
    fontSize: 32,
    fontWeight: "800",
    color: colors.caution,
    letterSpacing: 1,
  },
  requestIdText: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: "monospace",
    marginTop: 2,
  },
  notesBox: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  notesLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  notesText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontStyle: "italic",
  },
  errorHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  errorTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: "700",
    color: colors.threat,
  },
  errorSubtitle: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    marginTop: 2,
    lineHeight: 15,
  },
  blockerNoticeBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderRadius: radii.xs,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  blockerNoticeText: {
    fontSize: 10.5,
    color: colors.textSecondary,
    lineHeight: 15,
    flex: 1,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
