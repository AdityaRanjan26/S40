import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../theme/colors";
import { typography } from "../../theme/typography";
import { spacing, radii } from "../../theme/layout";
import { StatusBadge } from "../common/StatusBadge";
import { Button } from "../common/Button";
import { PreparedPaymentDraft, PaymentRiskEvaluationState, GuardianEscalationState } from "../../types/transaction";
import { PaymentRiskEvaluationCard } from "./PaymentRiskEvaluationCard";
import { GuardianEscalationCard } from "./GuardianEscalationCard";

interface PreparedPaymentCardProps {
  draft: PreparedPaymentDraft;
  onEdit: () => void;
  onReset?: () => void;
  onAnalyzeRisk?: () => void;
  isAnalyzing?: boolean;
  evaluationState?: PaymentRiskEvaluationState;
  onRetryEvaluation?: () => void;
  guardianState?: GuardianEscalationState;
  onRequestGuardianApproval?: () => void;
  onRetryGuardian?: () => void;
  isRequestingGuardian?: boolean;
  onProceedToPayment?: () => void;
  isProceedingToPayment?: boolean;
}

export const PreparedPaymentCard: React.FC<PreparedPaymentCardProps> = ({
  draft,
  onEdit,
  onReset,
  onAnalyzeRisk,
  isAnalyzing = false,
  evaluationState,
  onRetryEvaluation,
  guardianState,
  onRequestGuardianApproval,
  onRetryGuardian,
  isRequestingGuardian = false,
  onProceedToPayment,
  isProceedingToPayment = false,
}) => {
  const getSourceLabel = (source: PreparedPaymentDraft["source"]) => {
    switch (source) {
      case "QR":
        return "SCAN QR";
      case "UPI_ID":
        return "UPI ID";
      case "MOBILE":
        return "MOBILE NUMBER";
      case "PAYMENT_REQUEST":
        return "PAYMENT REQUEST";
      default:
        return source;
    }
  };

  return (
    <View
      style={styles.container}
      accessibilityRole="summary"
      accessibilityLabel="Prepared payment summary"
      testID="prepared-payment-card"
    >
      {/* Header Row */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Ionicons name="shield-checkmark" size={18} color={colors.brand} />
          <Text style={styles.headerTitle}>Payment Intake Prepared</Text>
        </View>
        <StatusBadge label="PREPARED" status="resolved" dot={true} />
      </View>

      <Text style={styles.subtitle}>
        Inputs validated and unified across payment intake channels.
      </Text>

      {/* Grid of Prepared Details */}
      <View style={styles.detailsGrid}>
        {/* Source */}
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Intake Source</Text>
          <View testID="prepared-source-badge">
            <StatusBadge
              label={getSourceLabel(draft.source)}
              status="neutral"
              dot={false}
            />
          </View>
        </View>

        {/* Recipient */}
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Recipient</Text>
          <View style={styles.recipientRow}>
            <Text
              style={styles.detailValue}
              numberOfLines={1}
              testID="prepared-recipient-text"
            >
              {draft.recipient}
            </Text>
            <StatusBadge
              label={draft.recipientType === "UPI_ID" ? "UPI ID" : "Mobile"}
              status="neutral"
              dot={false}
            />
          </View>
        </View>

        {/* Name if present */}
        {draft.recipientName && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Name / Merchant</Text>
            <Text
              style={styles.detailValue}
              numberOfLines={1}
              testID="prepared-name-text"
            >
              {draft.recipientName}
            </Text>
          </View>
        )}

        {/* Amount */}
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Prepared Amount</Text>
          <Text
            style={[styles.detailValue, styles.amountHighlight]}
            testID="prepared-amount-text"
          >
            ₹{draft.amount.toFixed(2)}
          </Text>
        </View>

        {/* Note if present */}
        {draft.note && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Note</Text>
            <Text
              style={[styles.detailValue, { fontStyle: "italic" }]}
              numberOfLines={2}
              testID="prepared-note-text"
            >
              {draft.note}
            </Text>
          </View>
        )}

        {/* Workflow Stage */}
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Intake Status</Text>
          <StatusBadge
            label={
              guardianState?.status === "AUTHORIZATION_READY"
                ? "AUTHORIZATION READY"
                : guardianState?.status === "APPROVED"
                ? "GUARDIAN APPROVED"
                : guardianState?.status === "APPROVAL_PENDING"
                ? "HOLD FOR GUARDIAN"
                : guardianState?.status === "REQUESTING_APPROVAL"
                ? "CONTACTING GUARDIAN..."
                : guardianState?.status === "APPROVAL_REQUIRED"
                ? "GUARDIAN REQUIRED"
                : guardianState?.status === "DECLINED"
                ? "GUARDIAN DECLINED"
                : guardianState?.status === "ERROR"
                ? "ESCALATION FAILED"
                : evaluationState?.status === "EVALUATED"
                ? "SECURITY EVALUATED"
                : evaluationState?.status === "ANALYZING"
                ? "ANALYZING SECURITY..."
                : evaluationState?.status === "ERROR"
                ? "EVALUATION FAILED"
                : evaluationState?.status === "EXPIRED"
                ? "EVALUATION EXPIRED"
                : "READY FOR SECURITY CHECK"
            }
            status={
              guardianState?.status === "AUTHORIZATION_READY" || guardianState?.status === "APPROVED" || (!guardianState && evaluationState?.status === "EVALUATED")
                ? "resolved"
                : guardianState?.status === "APPROVAL_PENDING" || guardianState?.status === "REQUESTING_APPROVAL" || evaluationState?.status === "ANALYZING"
                ? "pending"
                : guardianState?.status === "APPROVAL_REQUIRED" || guardianState?.status === "DECLINED" || guardianState?.status === "ERROR" || evaluationState?.status === "ERROR" || evaluationState?.status === "EXPIRED"
                ? "high"
                : "neutral"
            }
            dot={false}
          />
        </View>
      </View>

      {/* Strict Phase Boundary Disclaimer (Shown before evaluation is completed) */}
      {(!evaluationState || evaluationState.status === "IDLE") && (
        <View style={styles.disclaimerBox} testID="prepared-boundary-notice">
          <Ionicons
            name="information-circle-outline"
            size={14}
            color={colors.textSecondary}
            style={{ marginRight: 6, flexShrink: 0 }}
          />
          <Text style={styles.disclaimerText}>
            INTAKE PREPARED ONLY. NO RISK ANALYSIS PERFORMED. NO PAYMENT AUTHORIZED OR INITIATED.
          </Text>
        </View>
      )}

      {/* Primary Action Buttons (when idle / ready for analysis) */}
      {(!evaluationState || evaluationState.status === "IDLE") && (
        <View style={styles.actionsRow}>
          {onAnalyzeRisk && (
            <Button
              label="ANALYZE PAYMENT RISK"
              icon="shield-checkmark"
              variant="primary"
              size="sm"
              loading={isAnalyzing}
              onPress={onAnalyzeRisk}
              testID="analyze-payment-risk-btn"
              style={{ flex: 2 }}
            />
          )}
          <Button
            label="EDIT"
            icon="create-outline"
            variant="secondary"
            size="sm"
            onPress={onEdit}
            testID="edit-prepared-payment-btn"
            style={{ flex: 1 }}
          />
          {onReset && (
            <Button
              label="RESET"
              icon="refresh"
              variant="outline"
              size="sm"
              onPress={onReset}
              testID="reset-prepared-payment-btn"
              style={{ flex: 1 }}
            />
          )}
        </View>
      )}

      {/* Embedded Risk Evaluation Card (ANALYZING, EVALUATED, ERROR, EXPIRED) */}
      {evaluationState && evaluationState.status !== "IDLE" && (
        <View style={{ marginTop: spacing.xs }}>
          <PaymentRiskEvaluationCard
            evaluationState={evaluationState}
            onRetry={onRetryEvaluation || onAnalyzeRisk || (() => {})}
            onEditDetails={onEdit}
          />
        </View>
      )}

      {/* Embedded Guardian Escalation Card */}
      {guardianState && guardianState.status !== "IDLE" && (
        <View style={{ marginTop: spacing.xs }}>
          <GuardianEscalationCard
            guardianState={guardianState}
            draft={draft}
            evaluationData={evaluationState?.data}
            onRequestApproval={onRequestGuardianApproval || (() => {})}
            onRetry={onRetryGuardian || onRequestGuardianApproval || (() => {})}
            onEditDetails={onEdit}
            isRequesting={isRequestingGuardian}
            onProceedToPayment={onProceedToPayment}
            isProceedingToPayment={isProceedingToPayment}
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  headerTitle: {
    fontSize: typography.body.fontSize,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  subtitle: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  detailsGrid: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  detailLabel: {
    fontSize: typography.caption.fontSize,
    color: colors.textSecondary,
  },
  detailValue: {
    fontSize: typography.caption.fontSize,
    fontWeight: "600",
    color: colors.textPrimary,
    textAlign: "right",
  },
  recipientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  amountHighlight: {
    color: colors.brand,
    fontWeight: "800",
    fontSize: 15,
  },
  disclaimerBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.xs,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  disclaimerText: {
    fontSize: 10,
    color: colors.textSecondary,
    flex: 1,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
});
