import React from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../lib/colors";
import { loadCredentials } from "../lib/storage";
import Constants from "expo-constants";

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string) ??
  process.env.EXPO_PUBLIC_API_URL ??
  "http://localhost:4200/";

function StatusRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: "ok" | "warn" | "error" | "info";
}) {
  const color =
    status === "ok" ? Colors.green :
    status === "warn" ? Colors.orange :
    status === "error" ? Colors.red :
    Colors.grayLight;

  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, { color }]}>{value}</Text>
    </View>
  );
}

function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Ionicons name={icon as any} size={14} color={Colors.purple} />
      <Text style={styles.sectionHeaderText}>{title}</Text>
    </View>
  );
}

export default function DiagnosticsScreen() {
  const router = useRouter();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["diagnostics"],
    queryFn: async () => {
      const creds = await loadCredentials();
      const headers: Record<string, string> = { Accept: "application/json" };
      if ((creds as any).keyId) headers["x-kalshi-key-id"] = (creds as any).keyId;
      if ((creds as any).privateKeyB64) headers["x-kalshi-private-key"] = (creds as any).privateKeyB64;
      const res = await fetch(`${BASE_URL}api/diagnostics`, { headers });
      return res.json() as any;
    },
    refetchInterval: 30000,
  });

  const d = data || {};
  const kalshi = d.kalshi || {};
  const feed = d.market_feed || {};
  const at = d.auto_trade || {};
  const eng = d.engine || {};
  const scans = d.scans || {};
  const pos = d.positions || {};
  const learn = d.learning || {};

  const fmtLatency = (ms: number | null) => ms == null ? "—" : `${ms}ms`;
  const fmtTime = (iso: string | null | undefined) => {
    if (!iso) return "Never";
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return "Never";
    return new Date(iso).toLocaleString([], {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.nav}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>System Diagnostics</Text>
        <TouchableOpacity onPress={() => refetch()} style={styles.refreshBtn}>
          {isRefetching
            ? <ActivityIndicator size="small" color={Colors.purple} />
            : <Ionicons name="refresh-outline" size={18} color={Colors.gray} />
          }
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={Colors.purple} />
          <Text style={styles.loadingText}>Running diagnostics…</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={Colors.purple} />
          }
        >
          {/* ── Kalshi Connection ──────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="KALSHI CONNECTION" icon="link-outline" />
            <StatusRow
              label="API Reachable"
              value={kalshi.reachable ? "YES" : "NO"}
              status={kalshi.reachable ? "ok" : "error"}
            />
            <View style={styles.divider} />
            <StatusRow
              label="Latency"
              value={fmtLatency(kalshi.latency_ms)}
              status={
                kalshi.latency_ms == null ? undefined :
                kalshi.latency_ms < 300 ? "ok" :
                kalshi.latency_ms < 1000 ? "warn" : "error"
              }
            />
            <View style={styles.divider} />
            <StatusRow
              label="Credentials"
              value={kalshi.credentials_present ? "Present" : "Not configured"}
              status={kalshi.credentials_present ? "ok" : "warn"}
            />
          </View>

          {/* ── Market Feed ────────────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="MARKET FEED" icon="pulse-outline" />
            <StatusRow
              label="Status"
              value={
                feed.status === "live" ? "LIVE" :
                feed.status === "no_data" ? "NO DATA" :
                feed.status === "error" ? "ERROR" : "UNKNOWN"
              }
              status={
                feed.status === "live" ? "ok" :
                feed.status === "no_data" ? "warn" : "error"
              }
            />
            <View style={styles.divider} />
            <StatusRow
              label="Markets Loaded"
              value={(feed.market_count ?? 0).toString()}
              status={(feed.market_count ?? 0) > 0 ? "ok" : "warn"}
            />
            <View style={styles.divider} />
            <StatusRow
              label="Last Checked"
              value={fmtTime(feed.last_checked)}
              status="info"
            />
          </View>

          {/* ── Auto-Trade Engine ──────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="AUTO-TRADE ENGINE" icon="flash-outline" />
            <StatusRow
              label="Enabled"
              value={at.enabled ? "YES" : "NO"}
              status={at.enabled ? "ok" : "info"}
            />
            <View style={styles.divider} />
            <StatusRow
              label="Mode"
              value={at.paper_mode ? "PAPER" : "LIVE"}
              status={at.paper_mode ? "info" : "warn"}
            />
            <View style={styles.divider} />
            <StatusRow
              label="System Activated"
              value={at.system_activated ? "YES" : "NO"}
              status={at.system_activated ? "ok" : "warn"}
            />
            <View style={styles.divider} />
            <StatusRow
              label="Engine Version"
              value={`v${eng.version || "2.0.0"}`}
              status="info"
            />
          </View>

          {/* ── Position Sync ──────────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="POSITION SYNC" icon="briefcase-outline" />
            <StatusRow
              label="Open Positions"
              value={(pos.open_count ?? 0).toString()}
              status="info"
            />
            <View style={styles.divider} />
            <StatusRow
              label="Sync Status"
              value={pos.synced ? "In Sync" : "Out of Sync"}
              status={pos.synced ? "ok" : "error"}
            />
          </View>

          {/* ── Learning ───────────────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="LEARNING" icon="school-outline" />
            <StatusRow
              label="Learning Enabled"
              value={learn.enabled ? "YES" : "NO"}
              status={learn.enabled ? "ok" : "info"}
            />
          </View>

          {/* ── Scan Activity ──────────────────────────────────────── */}
          <View style={styles.card}>
            <SectionHeader title="SCAN ACTIVITY" icon="scan-outline" />
            <StatusRow
              label="Total Scans"
              value={(scans.total ?? 0).toString()}
              status="info"
            />
            {scans.last && (
              <>
                <View style={styles.divider} />
                <StatusRow
                  label="Last Scan At"
                  value={fmtTime(scans.last.started_at)}
                  status="info"
                />
                <View style={styles.divider} />
                <StatusRow
                  label="Markets Scanned"
                  value={(scans.last.markets_scanned ?? 0).toString()}
                  status="info"
                />
                <View style={styles.divider} />
                <StatusRow
                  label="Opportunities Found"
                  value={(scans.last.opportunities_found ?? 0).toString()}
                  status={(scans.last.opportunities_found ?? 0) > 0 ? "ok" : "info"}
                />
                <View style={styles.divider} />
                <StatusRow
                  label="Trades Executed"
                  value={(scans.last.trades_executed ?? 0).toString()}
                  status={(scans.last.trades_executed ?? 0) > 0 ? "ok" : "info"}
                />
                {scans.last.error && (
                  <>
                    <View style={styles.divider} />
                    <StatusRow
                      label="Last Error"
                      value={scans.last.error}
                      status="error"
                    />
                  </>
                )}
              </>
            )}
          </View>

          {/* ── Scan History ───────────────────────────────────────── */}
          {(scans.history || []).length > 0 && (
            <View style={styles.card}>
              <SectionHeader title="SCAN HISTORY (LAST 10)" icon="time-outline" />
              {scans.history.map((s: any, i: number) => (
                <React.Fragment key={s.id || i}>
                  {i > 0 && <View style={styles.divider} />}
                  <View style={styles.historyRow}>
                    <View style={styles.historyLeft}>
                      <Text style={styles.historyTime}>{fmtDate(s.started_at)}</Text>
                      <Text style={styles.historyDetail}>
                        {s.markets_scanned ?? 0} markets · {s.opportunities_found ?? 0} opps · {s.trades_executed ?? 0} trades
                      </Text>
                      {s.error && (
                        <Text style={styles.historyError}>{s.error}</Text>
                      )}
                    </View>
                    <View style={[
                      styles.historyDot,
                      { backgroundColor: s.error ? Colors.red : s.trades_executed > 0 ? Colors.green : Colors.gray },
                    ]} />
                  </View>
                </React.Fragment>
              ))}
            </View>
          )}

          {/* ── Timestamp ─────────────────────────────────────────── */}
          {d.timestamp && (
            <Text style={styles.timestamp}>
              Diagnostics generated at {fmtDate(d.timestamp)}
            </Text>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },

  nav: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, color: Colors.blue, fontWeight: "500" },
  navTitle: { fontSize: 17, fontWeight: "600", color: Colors.white },
  refreshBtn: { padding: 6 },

  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontSize: 14, color: Colors.gray },

  card: {
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.cardInner,
  },
  sectionHeaderText: {
    fontSize: 11, fontWeight: "700", color: Colors.gray, letterSpacing: 0.8,
  },
  divider: { height: 1, backgroundColor: Colors.border },
  statusRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 13,
  },
  statusLabel: { fontSize: 13, color: Colors.gray },
  statusValue: { fontSize: 13, fontWeight: "600", color: Colors.white, textAlign: "right", maxWidth: "55%" },

  historyRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  historyLeft: { flex: 1 },
  historyTime: { fontSize: 13, fontWeight: "500", color: Colors.white },
  historyDetail: { fontSize: 11, color: Colors.gray, marginTop: 2 },
  historyError: { fontSize: 11, color: Colors.red, marginTop: 2 },
  historyDot: { width: 8, height: 8, borderRadius: 4, marginLeft: 12 },

  timestamp: {
    fontSize: 11, color: Colors.grayDark,
    textAlign: "center", paddingBottom: 16,
  },
});
