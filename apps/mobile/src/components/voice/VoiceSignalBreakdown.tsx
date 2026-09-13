import React from "react";
import { View, Text, StyleSheet, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../theme/colors";
import { typography } from "../../theme/typography";
import { spacing, radii, shadows } from "../../theme/layout";
import { StatusBadge } from "../common/StatusBadge";
import {
  CombinedVoiceAnalysis,
  AcousticAnalysis,
  safeNormalizeVoiceAnalysis,
} from "../../types/voice";

export interface VoiceSignalBreakdownProps {
  analysis?: CombinedVoiceAnalysis | null;
  showSourceTag?: boolean;
  style?: ViewStyle;
}

const getRiskColor = (level?: string | null) => {
  if (level === "HIGH") return colors.threat;
  if (level === "MEDIUM") return colors.caution;
  return colors.safe;
};

export const getAcousticDisplay = (acoustic: AcousticAnalysis | null) => {
  const status = acoustic?.status || "unavailable";
  const hasValidScore =
    status === "available" &&
    typeof acoustic?.riskScore === "number" &&
    !Number.isNaN(acoustic.riskScore);

  if (hasValidScore) {
    const isSynthetic = acoustic?.isSyntheticVoice;
    const evidenceList = acoustic?.acousticEvidence || [];
    const evidenceText =
      evidenceList.length > 0
        ? evidenceList.map((e) => e.replace(/_/g, " ")).join(" · ")
        : isSynthetic
        ? "AI Voice clone: pitch flatline & vocoder anomalies"
        : "Natural vocal dynamics & genuine timbre verified";

    return {
      isAvailable: true,
      score: acoustic!.riskScore,
      level: acoustic!.riskLevel || "LOW",
      statusLabel: isSynthetic ? "AI CLONE" : acoustic!.riskLevel || "LOW",
      badgeStatus: (acoustic!.riskLevel === "HIGH"
        ? "high"
        : acoustic!.riskLevel === "MEDIUM"
        ? "medium"
        : "low") as "high" | "medium" | "low",
      subText: evidenceText,
      isSynthetic,
    };
  }

  if (status === "pending") {
    return {
      isAvailable: false,
      score: null,
      level: null,
      statusLabel: "PENDING",
      badgeStatus: "pending" as const,
      subText: "Acoustic spoof analysis in progress...",
      isSynthetic: false,
    };
  }

  if (status === "failed") {
    return {
      isAvailable: false,
      score: null,
      level: null,
      statusLabel: "FAILED",
      badgeStatus: "high" as const,
      subText: acoustic?.errorMessage || "Acoustic analysis failed to process audio",
      isSynthetic: false,
    };
  }

  return {
    isAvailable: false,
    score: null,
    level: null,
    statusLabel: "UNAVAILABLE",
    badgeStatus: "neutral" as const,
    subText: acoustic?.reason
      ? `Acoustic analysis unavailable (${acoustic.reason})`
      : "Acoustic stream idle · Requires active voice buffer",
    isSynthetic: false,
  };
};

export const VoiceSignalBreakdown: React.FC<VoiceSignalBreakdownProps> = ({
  analysis,
  showSourceTag = true,
  style,
}) => {
  const safeAnalysis = safeNormalizeVoiceAnalysis(analysis);
  const acousticInfo = getAcousticDisplay(safeAnalysis.acousticAnalysis);
  const hasAcoustic = acousticInfo.isAvailable;
  const isMultiModal = hasAcoustic;

  return (
    <View style={[styles.container, style]}>
      {showSourceTag && (
        <View style={styles.sourceTagRow}>
          <Ionicons
            name={isMultiModal ? "git-merge-outline" : "document-text-outline"}
            size={13}
            color={isMultiModal ? colors.brand : colors.textSecondary}
          />
          <Text style={styles.sourceTagText}>
            {isMultiModal
              ? "Multi-Modal Bayesian Fusion · Audio & NLP Active"
              : "Transcript-based score · Audio telemetry in standby"}
          </Text>
        </View>
      )}

      <View style={styles.breakdownCard}>
        <View style={styles.breakdownHeader}>
          <View style={styles.breakdownTitleRow}>
            <Ionicons name="analytics-outline" size={15} color={colors.textMuted} />
            <Text style={styles.breakdownTitle}>MULTIMODAL SIGNAL BREAKDOWN</Text>
          </View>
          <StatusBadge
            label={isMultiModal ? "MULTI-MODAL" : "TRANSCRIPT ONLY"}
            status={isMultiModal ? "low" : "medium"}
            dot={false}
          />
        </View>

        {/* Transcript Risk Stream */}
        <View style={styles.streamRow}>
          <View style={styles.streamIconContainer}>
            <Ionicons name="chatbubbles-outline" size={18} color={colors.brand} />
          </View>
          <View style={styles.streamDetails}>
            <View style={styles.streamTopLine}>
              <Text style={styles.streamName}>Transcript & Scam Intent NLP</Text>
              <Text
                style={[
                  styles.streamScore,
                  { color: getRiskColor(safeAnalysis.transcriptAnalysis.riskLevel) },
                ]}
              >
                {safeAnalysis.transcriptAnalysis.riskScore} / 100 ·{" "}
                {safeAnalysis.transcriptAnalysis.riskLevel}
              </Text>
            </View>
            <Text style={styles.streamSub}>
              {safeAnalysis.transcriptAnalysis.matchedPhrases?.length
                ? `Matched: "${safeAnalysis.transcriptAnalysis.matchedPhrases.slice(0, 2).join('", "')}"`
                : "Multilingual Aho-Corasick & coercion pattern analyzer"}
            </Text>
          </View>
        </View>

        <View style={styles.breakdownDivider} />

        {/* Acoustic Risk Stream */}
        <View style={styles.streamRow}>
          <View
            style={[
              styles.streamIconContainer,
              acousticInfo.isSynthetic && { backgroundColor: colors.threatSurface, borderColor: colors.threatBorder },
            ]}
          >
            <Ionicons
              name={hasAcoustic ? (acousticInfo.isSynthetic ? "alert-circle" : "mic") : "mic-off-outline"}
              size={18}
              color={acousticInfo.isSynthetic ? colors.threat : hasAcoustic ? colors.brand : colors.textMuted}
            />
          </View>
          <View style={styles.streamDetails}>
            <View style={styles.streamTopLine}>
              <Text style={styles.streamName}>Audio Anti-Spoofing & Voice Clone</Text>
              {hasAcoustic && typeof acousticInfo.score === "number" ? (
                <Text
                  style={[
                    styles.streamScore,
                    { color: getRiskColor(acousticInfo.level) },
                  ]}
                >
                  {acousticInfo.score} / 100 · {acousticInfo.statusLabel}
                </Text>
              ) : (
                <StatusBadge
                  label={acousticInfo.statusLabel}
                  status={acousticInfo.badgeStatus}
                  dot={false}
                />
              )}
            </View>
            <Text
              style={[
                styles.streamSub,
                acousticInfo.isSynthetic && { color: colors.threat, fontWeight: "600" },
              ]}
            >
              {acousticInfo.subText}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  sourceTagRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  sourceTagText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 11,
  },
  breakdownCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
    ...shadows.sm,
  },
  breakdownHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  breakdownTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  breakdownTitle: {
    ...typography.caption,
    color: colors.textMuted,
    letterSpacing: 0.8,
    fontWeight: "700",
  },
  streamRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.xs,
  },
  streamIconContainer: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  streamDetails: {
    flex: 1,
  },
  streamTopLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  streamName: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 13,
  },
  streamScore: {
    ...typography.smallSemibold,
    fontSize: 12,
  },
  streamSub: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 2,
    fontSize: 11,
  },
  breakdownDivider: {
    height: 1,
    backgroundColor: colors.borderLight,
    marginVertical: spacing.xs,
  },
});
