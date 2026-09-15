import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useNavigation, useIsFocused } from "@react-navigation/native";
import { StaggerRevealCard } from "../components/common/StaggerRevealCard";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../theme/colors";
import { typography } from "../theme/typography";
import { spacing, radii, shadows } from "../theme/layout";
import { Header } from "../components/common/Header";
import { StatusBadge } from "../components/common/StatusBadge";
import { Button } from "../components/common/Button";
import { FloatingToast, ToastConfig } from "../components/common/FloatingToast";
import { PolicyModal, PolicyType } from "../components/common/PolicyModal";
import { EditProfileModal } from "../components/profile/EditProfileModal";
import { DeviceDetailsModal } from "../components/profile/DeviceDetailsModal";
import { HelpSupportModal } from "../components/profile/HelpSupportModal";
import { ServerEndpointModal } from "../components/profile/ServerEndpointModal";
import { useAuth } from "../context/AuthContext";
import { useBiometrics } from "../context/BiometricContext";
import { useSecurity } from "../context/SecurityContext";
import { useGuardian } from "../context/GuardianContext";
import { ConnectedAppsService, ConnectedApp } from "../services/connected-apps-service";
import { getApiBaseUrl } from "../services/api-client";
import { getUserDevices, getDeviceName, getDeviceType, RegisteredDevice } from "../services/device-info-service";
import { AppSwitch } from "../components/common/AppSwitch";

interface SettingRowProps {
  icon: string;
  label: string;
  sub?: string;
  onPress?: () => void;
  isLast?: boolean;
}

const SettingRow: React.FC<SettingRowProps> = ({ icon, label, sub, onPress, isLast }) => (
  <TouchableOpacity
    style={[rowStyles.row, isLast && rowStyles.rowLast]}
    onPress={onPress}
    activeOpacity={onPress ? 0.72 : 1}
    disabled={!onPress}
    accessibilityRole={onPress ? "button" : "none"}
  >
    <View style={rowStyles.iconWrap}>
      <Ionicons name={icon as any} size={16} color={colors.brand} />
    </View>
    <View style={rowStyles.textCol}>
      <Text style={rowStyles.label}>{label}</Text>
      {sub ? <Text style={rowStyles.sub} numberOfLines={1}>{sub}</Text> : null}
    </View>
    <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
  </TouchableOpacity>
);

interface ToggleRowProps {
  icon: string;
  label: string;
  sub?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  isLast?: boolean;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ icon, label, sub, value, onValueChange, isLast }) => (
  <View style={[rowStyles.row, isLast && rowStyles.rowLast]}>
    <View style={rowStyles.iconWrap}>
      <Ionicons name={icon as any} size={16} color={colors.brand} />
    </View>
    <View style={rowStyles.textCol}>
      <Text style={rowStyles.label}>{label}</Text>
      {sub ? <Text style={rowStyles.sub}>{sub}</Text> : null}
    </View>
    <AppSwitch value={value} onValueChange={onValueChange} />
  </View>
);

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.sm,
  },
  rowLast: { borderBottomWidth: 0 },
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: radii.sm + 2,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  textCol: { flex: 1 },
  label: {
    ...typography.bodySemibold,
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 18,
  },
  sub: {
    ...typography.small,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
});

export const ProfileScreen: React.FC = () => {
  const navigation = useNavigation<any>();
  const { session, updateProfile, logout } = useAuth();
  const { isBiometricsEnabled, setBiometricsEnabled, biometricStatus } = useBiometrics();
  const { alerts } = useSecurity();
  const { isTrustedFeatureEnabled, toggleTrustedFeature } = useGuardian();

  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(true);
  const [callProtectionEnabled, setCallProtectionEnabled] = useState<boolean>(true);
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(ConnectedAppsService.getApps());
  const [toastConfig, setToastConfig] = useState<ToastConfig | null>(null);
  const [isEditProfileVisible, setIsEditProfileVisible] = useState<boolean>(false);
  const [isDeviceDetailsVisible, setIsDeviceDetailsVisible] = useState<boolean>(false);
  const [isHelpSupportVisible, setIsHelpSupportVisible] = useState<boolean>(false);
  const [isServerModalVisible, setIsServerModalVisible] = useState<boolean>(false);
  const [activePolicyModal, setActivePolicyModal] = useState<PolicyType | null>(null);
  const [currentApiEndpoint, setCurrentApiEndpoint] = useState<string>(getApiBaseUrl());
  const [primaryDevice, setPrimaryDevice] = useState<RegisteredDevice | null>(null);

  const isFocused = useIsFocused();
  const hasPlayedProfileStaggerRef = useRef(false);

  useEffect(() => {
    if (isFocused && !hasPlayedProfileStaggerRef.current) {
      const timer = setTimeout(() => { hasPlayedProfileStaggerRef.current = true; }, 1000);
      return () => clearTimeout(timer);
    }
  }, [isFocused]);

  useEffect(() => {
    const unsubscribe = ConnectedAppsService.subscribe((updatedApps) => { setConnectedApps(updatedApps); });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!session?.userId) return;
    let cancelled = false;
    const localName = getDeviceName();
    const localType = getDeviceType();
    getUserDevices(session.userId).then((devices) => {
      if (cancelled) return;
      // The `devices` table only gains a row once this device has made a
      // transaction (see device-info-service.ts), so it can't reliably be
      // matched to "the current device" by id. Best-effort: use the row
      // whose reported name/type match this device's real, live values;
      // otherwise fall back to those live values with no backend record.
      const matched = devices.find((d) => d.deviceName === localName && d.deviceType === localType);
      setPrimaryDevice(
        matched || {
          id: 0,
          deviceName: localName,
          deviceType: localType,
          deviceHash: "",
          isPrimary: true,
          registeredAt: null,
          lastActive: null,
          securityStatus: "SECURE",
        }
      );
    });
    return () => { cancelled = true; };
  }, [session?.userId]);

  const showToast = (message: string, type: "info" | "success" | "warning" = "success") => {
    setToastConfig({ message, type });
  };

  const handleBiometricsToggle = async (value: boolean) => {
    const res = await setBiometricsEnabled(value);
    if (res.success) {
      showToast(value ? "Biometric Lock activated" : "Biometric Lock deactivated", value ? "success" : "info");
    } else {
      showToast(res.error || "Authentication required to change setting", "warning");
    }
  };
  const handleAlertsToggle = (value: boolean) => {
    setAlertsEnabled(value);
    showToast(value ? "Security Alerts activated" : "Security Alerts deactivated", value ? "success" : "info");
  };
  const handleCallProtectionToggle = (value: boolean) => {
    setCallProtectionEnabled(value);
    showToast(value ? "Call Protection activated" : "Call Protection deactivated", value ? "success" : "info");
  };
  const handleTrustedFeatureToggle = (value: boolean) => {
    toggleTrustedFeature();
    showToast(
      value
        ? "Trusted Contact review activated. High-risk payments will require Guardian approval."
        : "Trusted Contact review deactivated. High-risk payments can be continued by accepting the risk yourself.",
      value ? "success" : "info"
    );
  };
  const handleSaveProfile = async (data: { name: string; phone: string; email: string }) => {
    const res = await updateProfile(data);
    if (res.success) { showToast("Profile updated successfully", "success"); return true; }
    else { showToast(res.error || "Failed to update profile", "warning"); return false; }
  };
  const handleSignOut = async () => {
    await logout();
  };

  const initials = session?.name
    ? session.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : "U";

  return (
    <View style={styles.screen}>
      <Header title="AVARAN" />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

        {/* PROFILE HEADER */}
        <StaggerRevealCard index={0} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current}>
          <TouchableOpacity onPress={() => setIsEditProfileVisible(true)} activeOpacity={0.8}
            accessibilityRole="button" accessibilityLabel="Edit Profile" style={styles.userCardOuter}>
            <LinearGradient colors={["#FFFFFF", "#EAF3F0"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.userCardGradient}>
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
              <View style={styles.userTextCol}>
                <View style={styles.userNameRow}>
                  <Text style={styles.userName}>{session?.name || "Your Name"}</Text>
                  <View style={styles.editPill}>
                    <Ionicons name="pencil-outline" size={10} color={colors.brand} />
                    <Text style={styles.editPillText}>Edit</Text>
                  </View>
                </View>
                {session?.phone ? <Text style={styles.userPhone}>{session.phone}</Text> : null}
                {session?.email ? <Text style={styles.userEmail}>{session.email}</Text> : null}
              </View>
              <Ionicons name="chevron-forward" size={15} color={colors.brand} style={{ opacity: 0.45 }} />
            </LinearGradient>
          </TouchableOpacity>
        </StaggerRevealCard>

        {/* CONNECTED APPS */}
        <StaggerRevealCard index={1} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current} style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionLabel}>Connected Apps</Text>
            <TouchableOpacity onPress={() => navigation.navigate("ConnectedApps")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityRole="button">
              <Text style={styles.sectionAction}>Manage</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.card}>
            {connectedApps.map((app, idx) => (
              <TouchableOpacity key={app.id} style={[styles.appRow, idx === connectedApps.length - 1 && styles.appRowLast]}
                onPress={() => navigation.navigate("ConnectedApps")} activeOpacity={0.72} accessibilityRole="button"
                accessibilityLabel={`Manage ${app.name} protection`}>
                <View style={styles.appLeft}>
                  <View style={styles.appIconCircle}>
                    <Ionicons name={app.iconName as any} size={16} color={colors.brand} />
                  </View>
                  <View style={styles.appTextCol}>
                    <Text style={styles.appName}>{app.name}</Text>
                    <Text style={styles.appCategory}>{app.category}</Text>
                  </View>
                </View>
                <StatusBadge label={app.status} status={app.isProtected ? "low" : "neutral"} dot={false} />
              </TouchableOpacity>
            ))}
          </View>
        </StaggerRevealCard>

        {/* SECURITY CONTROLS */}
        <StaggerRevealCard index={2} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current} style={styles.section}>
          <Text style={styles.sectionLabel}>Security Controls</Text>
          <View style={styles.card}>
            <ToggleRow icon="finger-print" label="Device Biometric Lock" sub={`${biometricStatus.displayName} · Hardware Enrolled`} value={isBiometricsEnabled} onValueChange={handleBiometricsToggle} />
            <ToggleRow icon="notifications-outline" label="Security Alerts" sub="Real-time notification on threats" value={alertsEnabled} onValueChange={handleAlertsToggle} />
            <ToggleRow icon="mic-outline" label="Call Protection" sub="On-device acoustic fraud detection" value={callProtectionEnabled} onValueChange={handleCallProtectionToggle} />
            <ToggleRow
              icon="people-outline"
              label="Trusted Contact Review"
              sub={
                isTrustedFeatureEnabled
                  ? "High-risk payments require Guardian approval"
                  : "Off — you'll accept high-risk payments yourself"
              }
              value={isTrustedFeatureEnabled}
              onValueChange={handleTrustedFeatureToggle}
              isLast
            />
          </View>
        </StaggerRevealCard>

        {/* TRUSTED DEVICES */}
        <StaggerRevealCard index={3} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current} style={styles.section}>
          <Text style={styles.sectionLabel}>Trusted Devices</Text>
          <View style={styles.card}>
            <SettingRow icon="phone-portrait-outline" label={primaryDevice?.deviceName || "This device"} sub="Primary device · Registered hardware token" onPress={() => setIsDeviceDetailsVisible(true)} isLast />
          </View>
        </StaggerRevealCard>

        {/* SUPPORT & LEGAL */}
        <StaggerRevealCard index={4} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current} style={styles.section}>
          <Text style={styles.sectionLabel}>Support & Legal</Text>
          <View style={styles.card}>
            <SettingRow icon="help-circle-outline" label="Help & Support" onPress={() => setIsHelpSupportVisible(true)} />
            <SettingRow icon="shield-outline" label="Privacy Policy" onPress={() => setActivePolicyModal("privacy")} />
            <SettingRow icon="server-outline" label="Server Endpoint" sub={currentApiEndpoint} onPress={() => setIsServerModalVisible(true)} />
            <SettingRow icon="document-text-outline" label="Terms of Service" onPress={() => setActivePolicyModal("terms")} isLast />
          </View>
        </StaggerRevealCard>

        {/* LOG OUT */}
        <StaggerRevealCard index={5} baseDelay={60} hasPlayed={hasPlayedProfileStaggerRef.current}>
          <View style={styles.logoutSection}>
            <View style={styles.logoutDividerRow}>
              <View style={styles.logoutDividerLine} />
              <Text style={styles.logoutDividerLabel}>Account</Text>
              <View style={styles.logoutDividerLine} />
            </View>
            <Button label="LOG OUT" onPress={handleSignOut} variant="destructive" size="lg" />
          </View>
        </StaggerRevealCard>
      </ScrollView>

      <EditProfileModal visible={isEditProfileVisible} initialName={session?.name || "Your Name"} initialPhone={session?.phone || ""} initialEmail={session?.email || ""} onClose={() => setIsEditProfileVisible(false)} onSave={handleSaveProfile} />
      <DeviceDetailsModal visible={isDeviceDetailsVisible} device={primaryDevice} onClose={() => setIsDeviceDetailsVisible(false)} onShowToast={showToast} />
      <ServerEndpointModal visible={isServerModalVisible} onClose={() => setIsServerModalVisible(false)} onEndpointSaved={(newUrl) => { setCurrentApiEndpoint(newUrl); showToast(`Server endpoint updated: ${newUrl}`, "success"); }} />
      <HelpSupportModal visible={isHelpSupportVisible} onClose={() => setIsHelpSupportVisible(false)} onShowToast={showToast} onTriggerTestAlert={() => {}} />
      <PolicyModal visible={activePolicyModal !== null} type={activePolicyModal || "privacy"} onClose={() => setActivePolicyModal(null)} />
      <FloatingToast config={toastConfig} onDismiss={() => setToastConfig(null)} />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xxxl * 2 },
  userCardOuter: {
    borderRadius: radii.xl,
    borderWidth: 1.2,
    borderColor: colors.brandBorder,
    marginBottom: spacing.lg,
    overflow: "hidden",
    ...shadows.lg,
  },
  userCardGradient: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    gap: spacing.md,
  },
  avatarCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.brand,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarInitials: { color: "#FFFFFF", fontSize: 18, fontWeight: "700", letterSpacing: 0.5 },
  userTextCol: { flex: 1 },
  userNameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  userName: { ...typography.h3, color: colors.textPrimary, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  editPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.brandSurface,
    borderRadius: radii.full,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.brandBorder,
  },
  editPillText: { ...typography.caption, color: colors.brand, fontSize: 10, fontWeight: "700", letterSpacing: 0.2 },
  userPhone: { ...typography.small, color: colors.textSecondary, fontSize: 13, marginTop: 3 },
  userEmail: { ...typography.small, color: colors.textMuted, fontSize: 12, marginTop: 1 },
  section: { marginBottom: spacing.lg },
  sectionHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.xs + 2 },
  sectionLabel: { ...typography.bodySemibold, color: colors.textSecondary, fontSize: 12, fontWeight: "700", letterSpacing: 0.2, marginBottom: spacing.xs + 2 },
  sectionAction: { ...typography.smallSemibold, color: colors.brand, fontSize: 12 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    ...shadows.sm,
  },
  appRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  appRowLast: { borderBottomWidth: 0, paddingVertical: spacing.md },
  appLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1, paddingRight: spacing.sm },
  appIconCircle: {
    width: 34,
    height: 34,
    borderRadius: radii.sm + 2,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  appTextCol: { flex: 1 },
  appName: { ...typography.bodySemibold, color: colors.textPrimary, fontSize: 13.5, fontWeight: "600" },
  appCategory: { ...typography.small, color: colors.textMuted, fontSize: 11, marginTop: 1 },
  logoutSection: { marginTop: spacing.xl, marginBottom: spacing.lg, gap: spacing.lg },
  logoutDividerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  logoutDividerLine: { flex: 1, height: 1, backgroundColor: colors.borderLight },
  logoutDividerLabel: { ...typography.caption, color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
});
