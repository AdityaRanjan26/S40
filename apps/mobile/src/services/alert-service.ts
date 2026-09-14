import { ApiClient, IS_DEMO_MODE, isDemoMode } from "./api-client";
import { DEMO_ALERTS } from "../data/demo-data";
import { AlertCategory } from "../types/alert";

export interface SecurityAlert {
  id: string;
  title: string;
  description: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  status: "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "DISMISSED" | "ACTIVE" | "ACKNOWLEDGED";
  timestamp: string;
  transactionId?: string | number;
  isRead: boolean;
  category?: AlertCategory;
  whatHappened?: string;
  whyFlagged?: string[];
  whatYouShouldDo?: string[];
}

type AlertListener = (alerts: SecurityAlert[]) => void;

const convertDemoAlerts = (): SecurityAlert[] => {
  return DEMO_ALERTS.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description,
    severity: a.severity,
    status: a.isRead ? "RESOLVED" : "ACTIVE",
    timestamp: a.timestamp,
    transactionId: a.metadata?.transactionId || (a.category === "payment" ? "1" : undefined),
    isRead: a.isRead,
    category: a.category,
    whatHappened: a.whatHappened,
    whyFlagged: a.whyFlagged,
    whatYouShouldDo: a.whatYouShouldDo,
  }));
};

class AlertManager {
  // Pre-populate with demo alerts; real API data overwrites on first successful fetch
  private alerts: SecurityAlert[] = convertDemoAlerts();
  private listeners: Set<AlertListener> = new Set();

  public subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    // Initial call
    try {
      listener([...this.alerts]);
    } catch {}
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const copy = [...this.alerts];
    this.listeners.forEach((listener) => {
      try {
        listener(copy);
      } catch {}
    });
  }

  /**
   * GET Alerts (Demo mode or API mode). `userId` selects the caller's own
   * scoped alerts (/api/v1/users/{id}/alerts); without it (e.g. before
   * login) real alerts can't be fetched, so demo data is shown instead of
   * a broken empty screen.
   */
  public async getAlerts(userId?: number): Promise<SecurityAlert[]> {
    if (isDemoMode() || !userId) {
      return [...this.alerts];
    }

    try {
      const res = await ApiClient.get<any[]>(`/api/v1/users/${userId}/alerts`);
      if (res.data && Array.isArray(res.data)) {
        // A real, empty result means "no alerts for this account" — it must
        // not fall back to demo data, or a freshly reset account would show
        // fabricated alerts that were never actually raised for it.
        this.alerts = res.data.map((a: any) => ({
          id: String(a.id),
          title: a.summary || "Security Alert",
          description: a.summary || "A security event was detected.",
          severity: a.severity || "MEDIUM",
          status: a.status || "OPEN",
          timestamp: a.created_at
            ? new Date(a.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : "Recently",
          transactionId: a.transaction_id,
          isRead: a.status !== "OPEN" && a.status !== "ACTIVE",
          whatHappened: a.summary,
          whyFlagged: [a.summary || "Flagged by security engine"],
          whatYouShouldDo: ["Review details in payments screen"],
        }));
        this.notify();
        return [...this.alerts];
      }
    } catch {
      // Network/auth failure — keep whatever was last successfully loaded
      // (initially demo data) rather than showing a broken empty screen.
    }

    return [...this.alerts];
  }

  public addAlert(alert: SecurityAlert): void {
    this.alerts = [alert, ...this.alerts];
    this.notify();
  }

  public resolveAlertForTransaction(transactionId: string): void {
    this.alerts = this.alerts.map((a) => {
      if (
        a.transactionId === transactionId ||
        String(a.transactionId) === transactionId ||
        (a.transactionId && transactionId.includes(String(a.transactionId)))
      ) {
        return {
          ...a,
          status: "RESOLVED",
          isRead: true,
        };
      }
      return a;
    });
    this.notify();
  }

  public markAsRead(alertId: string): void {
    this.alerts = this.alerts.map((a) =>
      a.id === alertId ? { ...a, isRead: true, status: "RESOLVED" } : a
    );
    this.notify();
  }

  public resolveAlert(alertId: string): void {
    this.markAsRead(alertId);
  }
}

export const AlertService = new AlertManager();
