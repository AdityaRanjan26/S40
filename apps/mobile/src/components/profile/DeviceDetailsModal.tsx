import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../theme/colors";
import { typography } from "../../theme/typography";
import { spacing, radii, shadows } from "../../theme/layout";
import { Button } from "../common/Button";
import { StatusBadge } from "../common/StatusBadge";
import { RegisteredDevice } from "../../services/device-info-service";

interface DeviceDetailsModalProps {
  visible: boolean;
  device: RegisteredDevice | null;
  onClose: () => void;
  onShowToast: (message: string, type?: "info" | "success" | "warning") => void;
}

const formatDate = (iso: string | null): string => {
  if (!iso) return "Unknown";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return "Unknown";
  }
};

export const DeviceDetailsModal: React.FC<DeviceDetailsModalProps> = ({
  visible,
  device,
  onClose,
  onShowToast,
}) => {
  const { width, height } = useWindowDimensions();
  const isLargeScreen = width >= 640;

  if (!visible) return null;

  const deviceName = device?.deviceName || "This device";
  const deviceType = device?.deviceType || "Unknown OS";

  const handleSetPrimary = () => {
    onShowToast(`${deviceName} is already your primary device`, "info");
  };

  const handleDeregister = () => {
    const confirmAction = () => {
      onClose();
      onShowToast("Cannot deregister the only active device session", "warning");
    };

    if (Platform.OS === "web") {
      const confirmed = typeof window !== "undefined"
        ? window.confirm("Deregistering your primary device will require re-enrollment through your security contact. Are you sure you want to proceed?")
        : true;
      if (confirmed) {
        confirmAction();
      }
    } else {
      Alert.alert(
        "Deregister Device",
        "This is your primary registered hardware token. Deregistering will require re-enrollment through your security contact.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Deregister",
            style: "destructive",
            onPress: confirmAction,
          },
        ]
      );
    }
  };

  const modalContent = (
    <View
      style={[
        styles.modalContainer,
        isLargeScreen && styles.modalContainerDesktop,
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.iconCircle}>
            <Ionicons name="phone-portrait-outline" size={18} color={colors.brand} />
          </View>
          <View>
            <Text style={styles.headerTitle}>Trusted Device Details</Text>
            <Text style={styles.headerSub}>Cryptographic hardware identity</Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={onClose}
          style={styles.closeBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityRole="button"
          accessibilityLabel="Close device details"
        >
          <Ionicons name="close" size={20} color={colors.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* Body Information */}
      <ScrollView
        style={styles.scrollBody}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.deviceHeroCard}>
          <View style={styles.heroTop}>
            <Text style={styles.deviceName}>{deviceName}</Text>
            <StatusBadge label="Primary Device" status="low" />
          </View>
          <Text style={styles.deviceOs}>{deviceType}</Text>
        </View>

        <View style={styles.specsCard}>
          <View style={styles.specRow}>
            <Text style={styles.specLabel}>Registration Status</Text>
            <Text style={styles.specValue}>Active & Verified</Text>
          </View>

          <View style={styles.specRow}>
            <Text style={styles.specLabel}>Hardware Token</Text>
            <Text style={styles.specValueMono}>{device?.deviceHash || "Not yet registered"}</Text>
          </View>

          <View style={styles.specRow}>
            <Text style={styles.specLabel}>Enclave Storage</Text>
            <Text style={styles.specValue}>Android StrongBox Keystore</Text>
          </View>

          <View style={styles.specRow}>
            <Text style={styles.specLabel}>Registered On</Text>
            <Text style={styles.specValue}>{formatDate(device?.registeredAt ?? null)}</Text>
          </View>

          <View style={styles.specRow}>
            <Text style={styles.specLabel}>Last Active Session</Text>
            <Text style={styles.specValue}>{device?.lastActive ? "Just now (This device)" : "Unknown"}</Text>
          </View>

          <View style={styles.specRowNoBorder}>
            <Text style={styles.specLabel}>Security Posture</Text>
            <View style={styles.safeTag}>
              <Ionicons name="checkmark-circle" size={14} color={colors.brand} />
              <Text style={styles.safeTagText}>{device?.securityStatus === "SECURE" ? "Pass (Zero Root/Anomaly)" : "Review Recommended"}</Text>
            </View>
          </View>
        </View>

        {/* Protection Note */}
        <View style={styles.infoBanner}>
          <Ionicons name="shield-checkmark-outline" size={16} color={colors.brand} />
          <Text style={styles.infoBannerText}>
            Avaran evaluates UPI intents only when origin matches this cryptographic device fingerprint.
          </Text>
        </View>
      </ScrollView>

      {/* Footer Actions */}
      <View style={styles.footer}>
        <Button
          label="Deregister Device"
          onPress={handleDeregister}
          variant="secondary"
          size="md"
          style={styles.actionBtn}
        />
        <Button
          label="Done"
          onPress={onClose}
          variant="primary"
          size="md"
          style={styles.actionBtn}
        />
      </View>
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType={isLargeScreen ? "fade" : "slide"}
      transparent={true}
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.modalOverlay,
          isLargeScreen && styles.modalOverlayCentered,
        ]}
      >
        {isLargeScreen ? (
          <>
            <TouchableOpacity
              style={styles.backdropCover}
              onPress={onClose}
              activeOpacity={1}
            />
            {modalContent}
          </>
        ) : (
          <SafeAreaView style={styles.safeAreaFull} edges={["top", "bottom", "left", "right"]}>
            {modalContent}
          </SafeAreaView>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.background,
    ...(Platform.OS === "web"
      ? ({
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 99999,
        } as any)
      : {}),
  },
  modalOverlayCentered: {
    backgroundColor: "rgba(0, 0, 0, 0.78)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.lg,
  },
  backdropCover: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
    zIndex: 1,
  },
  safeAreaFull: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
    zIndex: 10,
  },
  modalContainerDesktop: {
    width: "92%",
    maxWidth: 540,
    backgroundColor: colors.background,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.borderLight,
    ...shadows.lg,
    overflow: "hidden",
    zIndex: 10,
    ...(Platform.OS === "web"
      ? ({
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.75)",
        } as any)
      : {}),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flex: 1,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    fontSize: 18,
  },
  headerSub: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "web" ? ({ cursor: "pointer" } as any) : {}),
  },
  scrollBody: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  deviceHeroCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    ...shadows.sm,
  },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  deviceName: {
    ...typography.h3,
    color: colors.textPrimary,
    fontSize: 17,
  },
  deviceOs: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 13,
  },
  specsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    ...shadows.sm,
  },
  specRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  specRowNoBorder: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  specLabel: {
    ...typography.body,
    color: colors.textSecondary,
    fontSize: 13,
  },
  specValue: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 13,
  },
  specValueMono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.textPrimary,
    fontSize: 12,
    fontWeight: "600",
  },
  safeTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  safeTagText: {
    ...typography.smallSemibold,
    color: colors.brand,
    fontSize: 12,
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  infoBannerText: {
    ...typography.small,
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },
  footer: {
    flexDirection: "row",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    gap: spacing.md,
  },
  actionBtn: {
    flex: 1,
  },
});
