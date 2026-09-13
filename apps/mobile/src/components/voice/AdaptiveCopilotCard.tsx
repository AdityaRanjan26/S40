import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../theme/colors";
import { typography } from "../../theme/typography";
import { spacing, radii, shadows } from "../../theme/layout";
import { AdaptiveCopilotGuidance, MultimodalFusionMetrics } from "../../types/voice";

export interface AdaptiveCopilotCardProps {
  guidance: AdaptiveCopilotGuidance;
  fusionMetrics?: MultimodalFusionMetrics | null;
  onChallengeSuccess?: () => void;
  onChallengeFailure?: () => void;
  onTerminateCall?: () => void;
  style?: ViewStyle;
}

const CHALLENGE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  VOICE_LIVENESS: "mic-circle-outline",
  ADMINISTRATIVE_TRAP: "shield-checkmark-outline",
};

const CHALLENGE_TITLES: Record<string, string> = {
  VOICE_LIVENESS: "Acoustic Liveness Verification",
  ADMINISTRATIVE_TRAP: "Identity & Jurisdiction Verification",
};

export const AdaptiveCopilotCard: React.FC<AdaptiveCopilotCardProps> = ({
  guidance,
  fusionMetrics,
  onChallengeSuccess,
  onChallengeFailure,
  onTerminateCall,
  style,
}) => {
  const isTermination = guidance.escalationAction === "TERMINATE_CALL";
  const iconName = CHALLENGE_ICONS[guidance.challengeType] || "shield-outline";
  const title = CHALLENGE_TITLES[guidance.challengeType] || "Security Verification Required";

  return (
    <View
      style={[
        styles.card,
        isTermination ? styles.cardCritical : styles.cardWarning,
        style,
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View
          style={[
            styles.iconWrap,
            isTermination ? styles.iconWrapCritical : styles.iconWrapWarning,
          ]}
        >
          <Ionicons
            name={isTermination ? "alert-circle" : iconName}
            size={20}
            color={isTermination ? colors.threat : colors.caution}
          />
        </View>
        <View style={styles.headerTextWrap}>
          <View style={styles.headerTopLine}>
            <Text
              style={[
                styles.title,
                isTermination ? styles.titleCritical : styles.titleWarning,
              ]}
            >
              {isTermination ? "CRITICAL: DISCONNECT RECOMMENDED" : "ADAPTIVE DEFENSE COPILOT"}
            </Text>
            {fusionMetrics && (
              <View style={styles.fusionBadge}>
                <Text style={styles.fusionBadgeText}>
                  FUSED {fusionMetrics.fusedRiskScore}%
                </Text>
              </View>
            )}
          </View>
          <Text style={styles.challengeCategory}>{title}</Text>
        </View>
      </View>

      {/* Recommended Action / Prompt */}
      {guidance.recommendedChallenge && (
        <View
          style={[
            styles.actionBox,
            isTermination ? styles.actionBoxCritical : styles.actionBoxWarning,
          ]}
        >
          <Ionicons
            name={isTermination ? "close-circle" : "flash-outline"}
            size={16}
            color={isTermination ? colors.threat : colors.caution}
            style={styles.actionIcon}
          />
          <Text
            style={[
              styles.actionText,
              isTermination ? styles.actionTextCritical : styles.actionTextWarning,
            ]}
          >
            {guidance.recommendedChallenge}
          </Text>
        </View>
      )}

      {/* Explanation */}
      {guidance.explanation && (
        <Text style={styles.explanationText}>
          {guidance.explanation}
        </Text>
      )}

      {/* Primary factors if provided */}
      {fusionMetrics?.primaryRiskFactors && fusionMetrics.primaryRiskFactors.length > 0 && (
        <View style={styles.factorsRow}>
          <Text style={styles.factorsLabel}>Risk Factors:</Text>
          {fusionMetrics.primaryRiskFactors.map((factor, idx) => (
            <View key={idx} style={styles.factorChip}>
              <Text style={styles.factorChipText}>{factor}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Action Buttons */}
      <View style={styles.buttonsRow}>
        {isTermination ? (
          <TouchableOpacity
            style={styles.hangUpPrimaryBtn}
            onPress={onTerminateCall}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Hang up call immediately"
          >
            <Ionicons name="call" size={16} color={colors.textInverse} />
            <Text style={styles.hangUpPrimaryText}>Hang Up Call Immediately</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={styles.passedBtn}
              onPress={onChallengeSuccess}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Caller passed verification"
            >
              <Ionicons name="checkmark-circle-outline" size={15} color={colors.brand} />
              <Text style={styles.passedBtnText}>Caller Answered Accurately</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.failedBtn}
              onPress={onChallengeFailure || onTerminateCall}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Caller failed or deflected"
            >
              <Ionicons name="alert-circle-outline" size={15} color={colors.threat} />
              <Text style={styles.failedBtnText}>Failed / Deflected</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    padding: spacing.md,
    marginVertical: spacing.sm,
    ...shadows.sm,
  },
  cardWarning: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.cautionBorder,
  },
  cardCritical: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.threatBorder,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapWarning: {
    backgroundColor: colors.cautionSurface,
    borderWidth: 1,
    borderColor: colors.cautionBorder,
  },
  iconWrapCritical: {
    backgroundColor: colors.threatSurface,
    borderWidth: 1,
    borderColor: colors.threatBorder,
  },
  headerTextWrap: {
    flex: 1,
  },
  headerTopLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    ...typography.caption,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  titleWarning: {
    color: colors.cautionText,
  },
  titleCritical: {
    color: colors.threatText,
  },
  fusionBadge: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fusionBadgeText: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: "700",
    color: colors.textPrimary,
  },
  challengeCategory: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
    marginTop: 1,
  },
  actionBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: radii.lg,
    padding: spacing.sm + 2,
    marginVertical: spacing.xs + 2,
    borderWidth: 1,
  },
  actionBoxWarning: {
    backgroundColor: colors.cautionSurface,
    borderColor: colors.cautionBorder,
  },
  actionBoxCritical: {
    backgroundColor: colors.threatSurface,
    borderColor: colors.threatBorder,
  },
  actionIcon: {
    marginTop: 2,
    marginRight: spacing.xs,
  },
  actionText: {
    ...typography.bodySemibold,
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },
  actionTextWarning: {
    color: colors.textPrimary,
  },
  actionTextCritical: {
    color: colors.threatText,
    fontWeight: "700",
  },
  explanationText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
    lineHeight: 16,
    marginVertical: 2,
  },
  factorsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: spacing.xs,
  },
  factorsLabel: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: "700",
    color: colors.textMuted,
  },
  factorChip: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radii.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  factorChipText: {
    ...typography.caption,
    fontSize: 10,
    color: colors.textSecondary,
  },
  buttonsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.xs + 2,
  },
  passedBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.brandSurface,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.brandBorder,
  },
  passedBtnText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: "700",
    color: colors.brandDark,
  },
  failedBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: colors.threatSurface,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.xs,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.threatBorder,
  },
  failedBtnText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: "700",
    color: colors.threat,
  },
  hangUpPrimaryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.threat,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  hangUpPrimaryText: {
    ...typography.bodySemibold,
    fontSize: 13,
    color: colors.textInverse,
    fontWeight: "800",
  },
});
