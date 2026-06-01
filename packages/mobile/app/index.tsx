import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, FlatList, Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Colors } from "../lib/colors";
import { api, apiFetch } from "../lib/api";
import { Ionicons } from "@expo/vector-icons";

const { width: SW } = Dimensions.get("window");

// ─── Live countdown hook ──────────────────────────────────────────────────────
function useCountdown(closeTime?: string): string {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    if (!closeTime) { setDisplay(""); return; }
    const calc = () => {
      const diff = new Date(closeTime).getTime() - Date.now();
      if (diff <= 0) { setDisplay("Closed"); return; }
      const s = Math.floor(diff / 1000);
      if (s < 60) { setDisplay(`${s}s`); return; }
      const m = Math.floor(s / 60);
      const rs = s % 60;
      if (m < 60) { setDisplay(`${m}m ${rs.toString().padStart(2,"0")}s`); return; }
      const h = Math.floor(m / 60);
      const rm = m % 60;
      setDisplay(`${h}h ${rm}m ${rs.toString().padStart(2,"0")}s`);
    };
    calc();
    const t = setInterval(calc, 1000);
    return () => clearInterval(t);
  }, [closeTime]);
  return display;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function LiveDot({ color = Colors.red }: { color?: string }) {
  return <View style={[styles.liveDot, { backgroundColor: color }]} />;
}

// ─── Recommendation Card ──────────────────────────────────────────────────────
function RecommendationCard({ market, onPress }: { market: any; onPress: () => void }) {
  const rec = market.recommendation;
  const isBuy = rec?.action === "BUY";
  const yesPct = Math.round((market.yes_bid || 0) * 100);
  const noPct  = Math.round((market.no_bid  || 0) * 100);
  const countdown = useCountdown(market.close_time);

  return (
    <TouchableOpacity onPress={onPress} style={styles.recCard} activeOpacity={0.85}>
      <View style={styles.recTop}>
        <View style={[styles.recAction, isBuy ? styles.recActionBuy : styles.recActionWait]}>
          <Text style={[styles.recActionText, { color: isBuy ? Colors.white : Colors.blue }]}>
            {isBuy ? (market.buyLabel || "BUY") : "WAIT"}
          </Text>
        </View>
      </View>

      <Text style={styles.recTitle} numberOfLines={2}>{market.title}</Text>
      <Text style={styles.recReason} numberOfLines={2}>{rec?.reasoning}</Text>

      <View style={styles.recStats}>
        <View style={styles.recStatBox}>
          <Text style={styles.recStatLabel}>YES</Text>
          <Text style={[styles.recStatVal, { color: Colors.green }]}>{yesPct}%</Text>
        </View>
        <View style={styles.recStatBox}>
          <Text style={styles.recStatLabel}>NO</Text>
          <Text style={[styles.recStatVal, { color: Colors.red }]}>{noPct}%</Text>
        </View>
      </View>

      <View style={styles.recFooter}>
        <View style={styles.liveTag}>
          <LiveDot />
          <Text style={styles.liveTagText}>LIVE</Text>
        </View>
        {countdown ? (
          <Text style={styles.recCountdown}>Closes {countdown}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

// ─── Market Row ───────────────────────────────────────────────────────────────
function MarketRow({ market, onPress }: { market: any; onPress: () => void }) {
  const rec = market.recommendation;
  const isBuy = rec?.action === "BUY";
  const conf  = rec?.confidence ?? 0;
  const yesPct = Math.round((market.yes_bid || 0) * 100);
  const noPct  = Math.round((market.no_bid  || 0) * 100);
  const countdown = useCountdown(market.close_time);

  return (
    <TouchableOpacity onPress={onPress} style={styles.row} activeOpacity={0.8}>
      <View style={styles.rowLeft}>
        <View style={styles.rowTitleRow}>
          <LiveDot />
          <Text style={styles.rowTitle} numberOfLines={1}>{market.title}</Text>
        </View>
        <View style={styles.rowPrices}>
          <Text style={[styles.rowYes]}>YES <Text style={{ color: Colors.green }}>{yesPct}%</Text></Text>
          <Text style={styles.rowNo}>  NO <Text style={{ color: Colors.red }}>{noPct}%</Text></Text>
        </View>
        {countdown ? (
          <Text style={styles.rowCountdown}>{countdown}</Text>
        ) : null}
      </View>
      <View style={styles.rowRight}>
        <View style={[styles.rowBadge, isBuy ? styles.rowBadgeBuy : styles.rowBadgeWait]}>
          <Text style={[styles.rowBadgeText, { color: isBuy ? Colors.white : Colors.blue }]}>
            {isBuy ? (market.buyLabel || "BUY") : "WAIT"}
          </Text>
        </View>

      </View>
    </TouchableOpacity>
  );
}

// ─── Section Header ───────────────────────────────────────────────────────────
function SectionHeader({ title, color, subtitle }: { title: string; color: string; subtitle?: string }) {
  return (
    <View style={styles.sectionHeaderWrap}>
      <View style={styles.sectionHeaderRow}>
        <View style={[styles.sectionDot, { backgroundColor: color }]} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {subtitle && <Text style={styles.sectionSub}>{subtitle}</Text>}
    </View>
  );
}

function SubLabel({ label }: { label: string }) {
  return <Text style={styles.subLabel}>{label}</Text>;
}

// ─── Home Screen ──────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const router = useRouter();

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["markets-structured"],
    queryFn: async () => {
      const res = await apiFetch(`api/markets/structured`);
      return res.json();
    },
    refetchInterval: 10000,
  });

  const { data: statusData } = useQuery({
    queryKey: ["engine-status"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/status`);
      return res.json() as any;
    },
    refetchInterval: 10000,
  });

  const { data: kalshiPortfolio } = useQuery({
    queryKey: ["portfolio-kalshi"],
    queryFn: async () => {
      const res = await apiFetch(`api/portfolio`);
      return res.json() as any;
    },
    refetchInterval: 10000,
  });

  const { data: perfData } = useQuery({
    queryKey: ["perf2"],
    queryFn: async () => {
      const res = await api.perf2.$get();
      return res.json() as any;
    },
    refetchInterval: 30000,
  });

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.settings.$get();
      return res.json() as any;
    },
  });

  const d: any = data || {};
  const recommendations: any[] = d.recommendations   || [];
  const crypto15m: any[]        = d.crypto15m         || [];
  const cryptoHourly: any[]     = d.cryptoHourly      || [];
  const basketball: any[]        = d.basketball        || [];
  const baseball: any[]          = d.baseball          || [];
  const upcomingBasketball: any[]= d.upcomingBasketball|| [];
  const upcomingBaseball: any[]  = d.upcomingBaseball  || [];

  const totalMarkets = crypto15m.length + cryptoHourly.length + basketball.length + baseball.length + upcomingBasketball.length + upcomingBaseball.length;

  const status  = statusData  || {};
  const today   = perfData?.today || {};
  const s       = settingsData?.settings || {};
  const kalshiBalance = kalshiPortfolio?.balance?.balance ?? null;
  const kalshiConnected = kalshiPortfolio?.connected === true;

  const autoEnabled = s.auto_trade_enabled === "true";
  const isPaper     = false;

  const pnl = today.realized_pnl || 0;

  const go = (ticker: string) => router.push(`/market/${ticker}`);

  return (
    <SafeAreaView style={styles.safe} edges={["top","left","right"]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.logo}>PulseTrade</Text>
          <View style={styles.logoSubRow}>
            <LiveDot color={Colors.green} />
            <Text style={styles.logoSub}>AI Trading · {autoEnabled ? "ACTIVE" : "PAUSED"}</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity onPress={() => router.push("/portfolio")} style={styles.headerIcon}>
            <Ionicons name="briefcase-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/performance")} style={styles.headerIcon}>
            <Ionicons name="bar-chart-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push("/settings")} style={styles.headerIcon}>
            <Ionicons name="settings-outline" size={20} color={Colors.white} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={Colors.purple} />
        }
      >
        {/* ── Dashboard Strip ──────────────────────────────────────────────── */}
        <View style={styles.dashStrip}>
          {/* Balance */}
          <TouchableOpacity style={styles.dashTile} onPress={() => router.push("/portfolio")}>
            <Text style={styles.dashTileLabel}>BALANCE</Text>
            <Text style={styles.dashTileVal}>
              {kalshiBalance != null ? `${kalshiBalance.toFixed(2)}` : "—"}
            </Text>
            <Text style={styles.dashTileSub}>{kalshiConnected ? "live" : "—"}</Text>
          </TouchableOpacity>

          <View style={styles.dashDivider} />

          {/* Today P&L */}
          <View style={styles.dashTile}>
            <Text style={styles.dashTileLabel}>TODAY P&L</Text>
            <Text style={[styles.dashTileVal, { color: pnl >= 0 ? Colors.green : Colors.red }]}>
              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
            </Text>
            <Text style={styles.dashTileSub}>{today.closed ?? 0} trades closed</Text>
          </View>

          <View style={styles.dashDivider} />

          {/* Auto Trade */}
          <TouchableOpacity style={styles.dashTile} onPress={() => router.push("/auto-trade")}>
            <Text style={styles.dashTileLabel}>AUTO TRADE</Text>
            <View style={styles.dashAutoRow}>
              <View style={[styles.dashAutoDot, { backgroundColor: autoEnabled ? Colors.green : Colors.gray }]} />
              <Text style={[styles.dashTileVal, { color: autoEnabled ? Colors.green : Colors.gray }]}>
                {autoEnabled ? "ON" : "OFF"}
              </Text>
            </View>
            <Text style={styles.dashTileSub}>
              {autoEnabled ? `${status.open_positions ?? 0} positions` : "tap to enable"}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── AI Status Bar ────────────────────────────────────────────────── */}
        {autoEnabled && (
          <View style={styles.aiBar}>
            <LiveDot color={Colors.green} />
            <Text style={styles.aiBarText}>
              {status.open_positions > 0
                ? `Monitoring ${status.open_positions} active position${status.open_positions !== 1 ? "s" : ""}`
                : "Scanning markets for qualified opportunities"}
            </Text>
          </View>
        )}
        {!autoEnabled && (
          <TouchableOpacity style={styles.enableBar} onPress={() => router.push("/auto-trade")} activeOpacity={0.8}>
            <Ionicons name="flash-outline" size={14} color={Colors.purple} />
            <Text style={styles.enableBarText}>Enable Auto Trade to begin AI trading</Text>
            <Ionicons name="chevron-forward" size={14} color={Colors.purple} />
          </TouchableOpacity>
        )}

        {isLoading ? (
          <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
        ) : totalMarkets === 0 && recommendations.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="pulse-outline" size={40} color={Colors.gray} />
            <Text style={styles.emptyTitle}>AI Scanning Markets</Text>
            <Text style={styles.emptySub}>Waiting for qualified opportunities. Pull to refresh.</Text>
          </View>
        ) : (
          <>
            {/* RECOMMENDATIONS */}
            {recommendations.length > 0 && (
              <>
                <SectionHeader title="Recommendations" color={Colors.green} subtitle="Highest-confidence opportunities now" />
                <FlatList
                  horizontal
                  data={recommendations}
                  keyExtractor={(item: any) => item.ticker}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.recList}
                  renderItem={({ item }) => (
                    <RecommendationCard market={item} onPress={() => go(item.ticker)} />
                  )}
                />
              </>
            )}

            {/* LIVE CRYPTO */}
            {(crypto15m.length > 0 || cryptoHourly.length > 0) && (
              <>
                <SectionHeader title="Live Crypto" color={Colors.orange} subtitle="15-minute and hourly markets" />
                {crypto15m.length > 0 && (
                  <><SubLabel label="15-MINUTE" />{crypto15m.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
                {cryptoHourly.length > 0 && (
                  <><SubLabel label="HOURLY" />{cryptoHourly.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
              </>
            )}

            {/* LIVE SPORTS */}
            {(basketball.length > 0 || baseball.length > 0) && (
              <>
                <SectionHeader title="Live Sports" color={Colors.red} subtitle="Games in progress" />
                {basketball.length > 0 && (
                  <><SubLabel label="BASKETBALL" />{basketball.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
                {baseball.length > 0 && (
                  <><SubLabel label="BASEBALL" />{baseball.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
              </>
            )}

            {/* UPCOMING */}
            {(upcomingBasketball.length > 0 || upcomingBaseball.length > 0) && (
              <>
                <SectionHeader title="Upcoming" color={Colors.blue} subtitle="Scheduled markets" />
                {upcomingBasketball.length > 0 && (
                  <><SubLabel label="BASKETBALL" />{upcomingBasketball.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
                {upcomingBaseball.length > 0 && (
                  <><SubLabel label="BASEBALL" />{upcomingBaseball.map((m: any) => <MarketRow key={m.ticker} market={m} onPress={() => go(m.ticker)} />)}</>
                )}
              </>
            )}

            <View style={{ height: 48 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  scroll: { flex: 1 },

  // Header
  header: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
  },
  logo:       { fontSize: 26, fontWeight: "800", color: Colors.white, letterSpacing: -0.5 },
  logoSubRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  logoSub:    { fontSize: 11, color: Colors.gray },
  headerRight:{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  headerIcon: {
    width: 34, height: 34, borderRadius: 8,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center",
  },

  liveDot: { width: 7, height: 7, borderRadius: 3.5 },

  // Dashboard strip
  dashStrip: {
    flexDirection: "row", alignItems: "stretch",
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: Colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border,
    overflow: "hidden",
  },
  dashTile: { flex: 1, padding: 14, alignItems: "center" },
  dashTileLabel: { fontSize: 9, fontWeight: "700", color: Colors.gray, letterSpacing: 0.8, marginBottom: 6 },
  dashTileVal:   { fontSize: 19, fontWeight: "800", color: Colors.white },
  dashTileSub:   { fontSize: 10, color: Colors.gray, marginTop: 3 },
  dashDivider:   { width: 1, backgroundColor: Colors.border, marginVertical: 10 },
  dashAutoRow:   { flexDirection: "row", alignItems: "center", gap: 5 },
  dashAutoDot:   { width: 7, height: 7, borderRadius: 3.5 },

  // AI status bar
  aiBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 14,
    backgroundColor: "rgba(34,197,94,0.08)",
    borderRadius: 8, borderWidth: 1, borderColor: "rgba(34,197,94,0.2)",
    paddingHorizontal: 12, paddingVertical: 9,
  },
  aiBarText: { fontSize: 12, color: Colors.green, flex: 1 },
  enableBar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 16, marginBottom: 14,
    backgroundColor: Colors.card, borderRadius: 8, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  enableBarText: { fontSize: 13, color: Colors.purple, flex: 1, fontWeight: "500" },

  // Empty state
  emptyState: { marginHorizontal: 16, marginTop: 50, alignItems: "center", gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.white, textAlign: "center" },
  emptySub:   { fontSize: 13, color: Colors.gray, textAlign: "center", lineHeight: 20 },

  // Section headers
  sectionHeaderWrap: { paddingHorizontal: 16, marginTop: 22, marginBottom: 4 },
  sectionHeaderRow:  { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  sectionDot:        { width: 8, height: 8, borderRadius: 4 },
  sectionTitle:      { fontSize: 19, fontWeight: "700", color: Colors.white },
  sectionSub:        { fontSize: 11, color: Colors.gray },
  subLabel: {
    fontSize: 10, color: Colors.gray, fontWeight: "700",
    paddingHorizontal: 16, marginTop: 10, marginBottom: 4, letterSpacing: 0.8,
  },

  // Recommendation cards (horizontal)
  recList: { paddingLeft: 16, paddingRight: 8, gap: 10, paddingBottom: 4 },
  recCard: {
    width: SW * 0.78, backgroundColor: Colors.card,
    borderRadius: 14, borderWidth: 1, borderColor: Colors.border, padding: 16,
  },
  recTop:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  recAction:   { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1 },
  recActionBuy:  { backgroundColor: Colors.red, borderColor: Colors.red },
  recActionWait: { backgroundColor: "transparent", borderColor: Colors.blue },
  recActionText: { fontSize: 12, fontWeight: "700" },
  confBadge:   { backgroundColor: Colors.cardInner, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: Colors.border },
  confBadgeText: { fontSize: 14, fontWeight: "700", color: Colors.purple },
  recTitle:    { fontSize: 14, fontWeight: "700", color: Colors.white, marginBottom: 5 },
  recReason:   { fontSize: 12, color: Colors.gray, lineHeight: 17, marginBottom: 10 },
  recStats:    { flexDirection: "row", gap: 6, marginBottom: 10 },
  recStatBox:  { flex: 1, backgroundColor: Colors.cardInner, borderRadius: 7, padding: 8, alignItems: "center", borderWidth: 1, borderColor: Colors.border },
  recStatLabel:{ fontSize: 10, color: Colors.gray, marginBottom: 2 },
  recStatVal:  { fontSize: 15, fontWeight: "700", color: Colors.white },
  recFooter:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  liveTag:     { flexDirection: "row", alignItems: "center", gap: 4 },
  liveTagText: { fontSize: 10, fontWeight: "600", color: Colors.gray },
  recCountdown:{ fontSize: 11, color: Colors.white, fontWeight: "600" },
  recTicker:   { fontSize: 10, color: Colors.grayDark },

  // Market rows
  row: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginHorizontal: 16, marginBottom: 7,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 14,
  },
  rowLeft:        { flex: 1, marginRight: 12 },
  rowTitleRow:    { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  rowTitle:       { fontSize: 13, fontWeight: "500", color: Colors.white, flex: 1 },
  rowPrices:      { flexDirection: "row", marginBottom: 3 },
  rowYes:         { fontSize: 13, color: Colors.gray },
  rowNo:          { fontSize: 13, color: Colors.gray },
  rowCountdown:   { fontSize: 11, color: Colors.grayLight, fontWeight: "500" },
  rowRight:       { alignItems: "flex-end", gap: 5 },
  rowBadge:       { borderRadius: 6, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1 },
  rowBadgeBuy:    { backgroundColor: Colors.red, borderColor: Colors.red },
  rowBadgeWait:   { backgroundColor: "transparent", borderColor: Colors.blue },
  rowBadgeText:   { fontSize: 11, fontWeight: "700" },
  rowConf:        { fontSize: 11, color: Colors.gray },
});
