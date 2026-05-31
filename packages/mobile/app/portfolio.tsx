import React from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../lib/colors";
import { api } from "../lib/api";
import Constants from "expo-constants";

const BASE_URL =
  (Constants.expoConfig?.extra?.apiUrl as string) ??
  process.env.EXPO_PUBLIC_API_URL ??
  "http://localhost:4200/";

export default function PortfolioScreen() {
  const router = useRouter();

  // Real Kalshi portfolio — token is stored server-side after login
  const { data: kalshiData, isLoading: kalshiLoading } = useQuery({
    queryKey: ["portfolio-kalshi"],
    queryFn: async () => {
      const res = await api.portfolio.$get();
      return res.json() as any;
    },
    refetchInterval: 10000,
  });

  // Open orders from Kalshi
  const { data: ordersData } = useQuery({
    queryKey: ["open-orders"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/orders`);
      return res.json() as any;
    },
    refetchInterval: 10000,
  });


  const kalshiConnected = kalshiData?.connected === true;
  const isLoading = kalshiLoading;
  const openOrders: any[] = ordersData?.orders || [];

  // Always live mode
  const showKalshi = kalshiConnected;
  const activeData = showKalshi ? kalshiData : null;
  const balance = activeData?.balance || null;
  const positions: any[] = activeData?.positions || [];

  const totalUnrealized = positions.reduce((a: number, p: any) => a + (p.unrealized_pnl || 0), 0);
  const positionValue = positions.reduce((a: number, p: any) => a + (p.total_cost || 0), 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {/* Nav */}
      <View style={styles.nav}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>Portfolio</Text>
        <TouchableOpacity onPress={() => router.push("/auto-trade")} style={styles.autoTradeNav}>
          <Text style={styles.autoTradeNavText}>Auto-Trade</Text>
          <Ionicons name="chevron-forward" size={14} color={Colors.blue} />
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>

          {/* ── Not Connected State ──────────────────────────────────── */}
          {!kalshiConnected && (
            <View style={styles.notConnectedCard}>
              <View style={styles.notConnectedIcon}>
                <Ionicons name="link-outline" size={32} color={Colors.gray} />
              </View>
              <Text style={styles.notConnectedTitle}>Kalshi Account Not Connected</Text>
              <Text style={styles.notConnectedSub}>
                Add your Kalshi API key and private key in Settings to see your real portfolio.
              </Text>
              <TouchableOpacity
                style={styles.connectBtn}
                onPress={() => router.push("/settings" as any)}
              >
                <Text style={styles.connectBtnText}>Go to Settings</Text>
                <Ionicons name="arrow-forward" size={14} color={Colors.white} />
              </TouchableOpacity>

            </View>
          )}

          {/* ── Mode Banner ───────────────────────────────────────────── */}
          {showKalshi && (
            <View style={styles.liveBanner}>
              <Ionicons name="radio-button-on" size={12} color={Colors.green} />
              <Text style={styles.liveBannerText}>LIVE — Kalshi account connected</Text>
            </View>
          )}

          {/* ── Balance Card ─────────────────────────────────────────── */}
          {showKalshi && (
            <View style={styles.balanceCard}>
              <Text style={styles.balanceLabel}>ACCOUNT BALANCE</Text>
              {balance ? (
                <View style={styles.balanceRow}>
                  <View style={styles.balanceCol}>
                    <Text style={styles.balanceValue}>${balance.balance?.toFixed(2)}</Text>
                    <Text style={styles.balanceSub}>Cash Available</Text>
                  </View>
                  <View style={styles.balanceDivider} />
                  <View style={styles.balanceCol}>
                    <Text style={styles.balanceValue}>${positionValue.toFixed(2)}</Text>
                    <Text style={styles.balanceSub}>Position Value</Text>
                  </View>
                  <View style={styles.balanceDivider} />
                  <View style={styles.balanceCol}>
                    <Text style={[styles.balanceValue, {
                      color: totalUnrealized >= 0 ? Colors.green : Colors.red
                    }]}>
                      {totalUnrealized >= 0 ? "+" : ""}{totalUnrealized.toFixed(1)}¢
                    </Text>
                    <Text style={styles.balanceSub}>Unrealized P&L</Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.noBalanceText}>No balance data available</Text>
              )}
            </View>
          )}

          {/* ── Open Positions ────────────────────────────────────────── */}
          {showKalshi && (
            <>
              <Text style={styles.positionsHeader}>
                OPEN POSITIONS ({positions.length})
              </Text>

              {positions.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>
                    {"No active positions."}
                  </Text>
                </View>
              ) : (
                positions.map((pos: any, i: number) => (
                  <TouchableOpacity
                    key={pos.ticker || i}
                    style={styles.positionCard}
                    onPress={() => router.push(`/market/${pos.ticker}` as any)}
                    activeOpacity={0.8}
                  >
                    <View style={styles.positionTop}>
                      <Text style={styles.positionTitle} numberOfLines={1}>
                        {pos.market_title}
                      </Text>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[styles.positionPnl, {
                          color: (pos.unrealized_pnl || 0) >= 0 ? Colors.green : Colors.red
                        }]}>
                          {(pos.unrealized_pnl || 0) >= 0 ? "+" : ""}
                          ${Math.abs(pos.unrealized_pnl || 0).toFixed(2)}
                        </Text>
                        {/* Profit % from entry */}
                        {pos.avg_entry_price > 0 && pos.current_price > 0 && (() => {
                          const pct = ((pos.current_price - pos.avg_entry_price) / pos.avg_entry_price) * 100;
                          return (
                            <Text style={{ fontSize: 11, color: pct >= 0 ? Colors.green : Colors.red, marginTop: 1 }}>
                              {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
                            </Text>
                          );
                        })()}
                      </View>
                    </View>
                    <View style={styles.positionMeta}>
                      <Text style={styles.positionMetaText}>
                        {pos.position > 0 ? "YES" : "NO"} · {Math.abs(pos.position || pos.count || 0)} contracts
                      </Text>
                      <Text style={styles.positionMetaText}>
                        {Math.round((pos.current_price || pos.avg_entry_price || 0) * 100)}¢ current
                      </Text>
                    </View>
                    <View style={styles.positionMeta}>
                      <Text style={styles.positionTicker}>{pos.ticker}</Text>
                      <Text style={styles.positionCost}>
                        Entry: {Math.round((pos.avg_entry_price || 0) * 100)}¢
                      </Text>
                    </View>
                    {/* Trailing Stop Indicator */}
                    {pos.trailing_stop_level != null && (
                      <View style={styles.trailingStopRow}>
                        <View style={styles.trailingStopDot} />
                        <Text style={styles.trailingStopText}>
                          Trailing stop: {Math.round(pos.trailing_stop_level * 100)}¢
                          {pos.peak_price ? ` · Peak: ${Math.round(pos.peak_price * 100)}¢` : ""}
                        </Text>
                      </View>
                    )}
                  </TouchableOpacity>
                ))
              )}
            </>
          )}

          {/* ── Open Orders ───────────────────────────────────────── */}
          {kalshiConnected && (
            <>
              <Text style={styles.positionsHeader}>
                OPEN ORDERS ({openOrders.length})
              </Text>
              {openOrders.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>No resting orders on Kalshi.</Text>
                </View>
              ) : (
                openOrders.map((order: any, i: number) => (
                  <View key={order.order_id || i} style={styles.positionCard}>
                    <View style={styles.positionTop}>
                      <Text style={styles.positionTitle} numberOfLines={1}>
                        {order.ticker}
                      </Text>
                      <View style={[styles.orderSideBadge, {
                        backgroundColor: order.side === "yes"
                          ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
                        borderColor: order.side === "yes"
                          ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
                      }]}>
                        <Text style={[styles.orderSideText, {
                          color: order.side === "yes" ? Colors.green : Colors.red,
                        }]}>
                          {(order.side || "").toUpperCase()}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.positionMeta}>
                      <Text style={styles.positionMetaText}>
                        {order.remaining_count ?? order.count ?? 0} contracts @ {Math.round((order.yes_price || order.no_price || 0) * 100)}¢
                      </Text>
                      <Text style={styles.positionMetaText}>
                        {order.action || "limit"} · {order.type || "resting"}
                      </Text>
                    </View>
                    {order.created_time && (
                      <Text style={styles.positionTicker}>
                        Placed {new Date(order.created_time).toLocaleString()}
                      </Text>
                    )}
                  </View>
                ))
              )}
            </>
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
  autoTradeNav: { flexDirection: "row", alignItems: "center", gap: 2 },
  autoTradeNavText: { fontSize: 14, color: Colors.blue, fontWeight: "500" },

  // Not connected
  notConnectedCard: {
    margin: 16, backgroundColor: Colors.card,
    borderRadius: 16, borderWidth: 1, borderColor: Colors.border,
    padding: 28, alignItems: "center",
  },
  notConnectedIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: Colors.cardInner, borderWidth: 1, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center", marginBottom: 16,
  },
  notConnectedTitle: {
    fontSize: 17, fontWeight: "700", color: Colors.white, marginBottom: 8, textAlign: "center",
  },
  notConnectedSub: {
    fontSize: 13, color: Colors.gray, textAlign: "center", lineHeight: 20, marginBottom: 20,
  },
  connectBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: Colors.purple, borderRadius: 10,
    paddingHorizontal: 20, paddingVertical: 12, marginBottom: 12,
  },
  connectBtnText: { fontSize: 14, fontWeight: "600", color: Colors.white },
  // Banners
  liveBanner: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: "rgba(34,197,94,0.1)",
    borderRadius: 8, borderWidth: 1, borderColor: "rgba(34,197,94,0.25)",
    paddingHorizontal: 12, paddingVertical: 7,
  },
  liveBannerText: { fontSize: 11, color: Colors.green, fontWeight: "700", letterSpacing: 0.8 },

  // Balance
  balanceCard: {
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: Colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, padding: 18,
  },
  balanceLabel: { fontSize: 10, color: Colors.gray, fontWeight: "600", letterSpacing: 1, marginBottom: 14 },
  balanceRow: { flexDirection: "row", alignItems: "center" },
  balanceCol: { flex: 1, alignItems: "center" },
  balanceDivider: { width: 1, height: 40, backgroundColor: Colors.border },
  balanceValue: { fontSize: 20, fontWeight: "700", color: Colors.white, marginBottom: 4 },
  balanceSub: { fontSize: 11, color: Colors.gray },
  noBalanceText: { fontSize: 13, color: Colors.gray },

  // Positions
  positionsHeader: {
    fontSize: 11, color: Colors.gray, fontWeight: "600",
    paddingHorizontal: 16, marginBottom: 8, letterSpacing: 0.8,
  },
  emptyCard: {
    marginHorizontal: 16, backgroundColor: Colors.card,
    borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    padding: 28, alignItems: "center",
  },
  emptyText: { fontSize: 13, color: Colors.gray, textAlign: "center", lineHeight: 20 },
  positionCard: {
    marginHorizontal: 16, marginBottom: 8,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 14,
  },
  positionTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  positionTitle: { fontSize: 13, fontWeight: "600", color: Colors.white, flex: 1, marginRight: 8 },
  positionPnl: { fontSize: 15, fontWeight: "700" },
  positionMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 },
  positionMetaText: { fontSize: 12, color: Colors.gray },
  positionTicker: { fontSize: 10, color: Colors.grayDark },
  positionCost: { fontSize: 11, color: Colors.gray },
  trailingStopRow: {
    flexDirection: "row", alignItems: "center",
    marginTop: 8, paddingTop: 7,
    borderTopWidth: 1, borderTopColor: Colors.border,
    gap: 6,
  },
  trailingStopDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: "#f59e0b",
  },
  trailingStopText: { fontSize: 11, color: "#f59e0b", fontWeight: "500" },

  // Open orders
  orderSideBadge: {
    borderRadius: 6, borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  orderSideText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
});
