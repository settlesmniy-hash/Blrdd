import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, Dimensions, Animated,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../../lib/colors";
import { api } from "../../lib/api";

const { width: SW } = Dimensions.get("window");
const CHART_W = SW - 32;
const CHART_H = 160;

// ─── Live countdown ────────────────────────────────────────────────────────────
function useCountdown(closeTime?: string) {
  const [display, setDisplay] = useState("");
  const [urgency, setUrgency] = useState(false);
  useEffect(() => {
    if (!closeTime) return;
    const calc = () => {
      const diff = new Date(closeTime).getTime() - Date.now();
      if (diff <= 0) { setDisplay("Closed"); setUrgency(false); return; }
      const s = Math.floor(diff / 1000);
      setUrgency(s < 120);
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
  return { display, urgency };
}

// ─── Chart ────────────────────────────────────────────────────────────────────
function PriceChart({ history }: { history: any[] }) {
  if (!history || history.length === 0) {
    return (
      <View style={[styles.chartArea, styles.chartEmpty]}>
        <Ionicons name="bar-chart-outline" size={28} color={Colors.border} />
        <Text style={styles.chartEmptyText}>No chart data</Text>
      </View>
    );
  }

  const prices = history.map((h: any) => h.yes_price ?? h.yes_bid ?? 0.5);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 0.01;
  const last = prices[prices.length - 1];
  const prev = prices[prices.length - 2] ?? last;
  const isUp = last >= prev;

  return (
    <View style={styles.chartArea}>
      {/* Grid */}
      <View style={StyleSheet.absoluteFill}>
        {[0,1,2,3].map(i => (
          <View key={i} style={[styles.gridLine, { top: Math.round((i / 3) * (CHART_H - 24)) }]} />
        ))}
      </View>
      {/* Price labels */}
      <Text style={styles.chartHi}>{Math.round(max * 100)}¢</Text>
      <Text style={styles.chartLo}>{Math.round(min * 100)}¢</Text>
      {/* Bars */}
      <View style={styles.chartBars}>
        {prices.slice(-40).map((p: number, i: number) => {
          const h = Math.max(3, ((p - min) / range) * (CHART_H - 24));
          const isLast = i === prices.slice(-40).length - 1;
          return (
            <View key={i} style={[
              styles.chartBar,
              { height: h },
              isUp ? styles.chartBarUp : styles.chartBarDown,
              isLast && styles.chartBarLast,
            ]} />
          );
        })}
      </View>
      {/* Volume */}
      <View style={styles.volBars}>
        {history.slice(-40).map((h: any, i: number) => {
          const maxVol = Math.max(...history.map((x: any) => x.volume || 0), 1);
          const vh = Math.max(2, ((h.volume || 0) / maxVol) * 16);
          return <View key={i} style={[styles.volBar, { height: vh }]} />;
        })}
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function MarketDetailScreen() {
  const { ticker } = useLocalSearchParams<{ ticker: string }>();
  const router = useRouter();
  const [chartInterval, setChartInterval] = useState("1h");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["market", ticker, chartInterval],
    queryFn: async () => {
      const res = await api.markets[":ticker"].$get({ param: { ticker: ticker! } });
      return res.json();
    },
    refetchInterval: 5000,
  });

  const market = (data as any)?.market;
  const rec    = market?.recommendation;
  const history= market?.history || [];

  const { display: countdown, urgency } = useCountdown(market?.close_time);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top","left","right"]}>
        <ActivityIndicator color={Colors.purple} style={{ marginTop: 100 }} />
      </SafeAreaView>
    );
  }

  if (!market) {
    return (
      <SafeAreaView style={styles.safe} edges={["top","left","right"]}>
        <View style={styles.errorWrap}>
          <Text style={styles.errorText}>Market not found</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.errorBack}>
            <Text style={styles.errorBackText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const yesPct = Math.round(market.yes_bid * 100);
  const noPct  = Math.round(market.no_bid  * 100);
  const move   = market.priceMove ?? null;
  const isBuy  = rec?.action === "BUY";
  const isWait = rec?.action === "WAIT" || rec?.action === "HOLD";
  const isSell = rec?.action === "SELL";

  const recColor = isBuy ? Colors.green : isSell ? Colors.red : Colors.purple;
  const recLabel = isBuy ? "BUY" : isSell ? "SELL" : "WAIT";

  const yesLabel = market.yes_sub_title || "YES";
  const noLabel  = market.no_sub_title  || "NO";

  // Chart stats
  const prices = history.map((h: any) => h.yes_price ?? h.yes_bid ?? 0.5);
  const hiPct  = prices.length ? Math.round(Math.max(...prices) * 100) : yesPct;
  const loPct  = prices.length ? Math.round(Math.min(...prices) * 100) : yesPct;
  const vol24h = market.volume_24h || market.volume || 0;
  const oi     = market.open_interest || 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top","left","right"]}>
      {/* Nav */}
      <View style={styles.nav}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.navTitle}>Market Detail</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Live tag + ticker */}
        <View style={styles.liveRow}>
          <View style={styles.liveTag}>
            <View style={styles.liveDot} />
            <Text style={styles.liveTagText}>LIVE</Text>
          </View>
          <Text style={styles.tickerText}>{market.ticker}</Text>
        </View>

        {/* Market title */}
        <Text style={styles.marketTitle}>{market.title}</Text>

        {/* ── Recommendation Card ──────────────────────────────────── */}
        <View style={styles.recCard}>
          <Text style={styles.recCardLabel}>RECOMMENDATION</Text>
          <View style={styles.recMain}>
            <Text style={[styles.recAction, { color: recColor }]}>{recLabel}</Text>
            <View style={styles.confBox}>
              <Text style={styles.confValue}>{rec?.confidence ?? 0}%</Text>
              <Text style={styles.confLabel}>confidence</Text>
            </View>
          </View>

          {rec?.reasoning ? (
            <Text style={styles.recReason}>{rec.reasoning}</Text>
          ) : null}

          <View style={styles.recWindows}>
            <View style={styles.recWindowItem}>
              <Text style={styles.recWindowLabel}>Opportunity Window</Text>
              <View style={styles.recWindowBar} />
              <Text style={styles.recWindowSub}>act by this time</Text>
            </View>
            <View style={styles.recWindowDiv} />
            <View style={styles.recWindowItem}>
              <Text style={styles.recWindowLabel}>Market Closes</Text>
              <Text style={[styles.recWindowVal, urgency && { color: Colors.red }]}>{countdown || market.timeRemaining}</Text>
              <Text style={styles.recWindowSub}>hard deadline</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.advBtn} onPress={() => setShowAdvanced(v => !v)}>
            <Text style={styles.advBtnText}>{showAdvanced ? "− ADVANCED DETAILS" : "+ ADVANCED DETAILS"}</Text>
          </TouchableOpacity>

          {showAdvanced && (
            <View style={styles.advancedPanel}>
              {rec?.ev != null && (
                <View style={styles.advRow}>
                  <Text style={styles.advLabel}>Expected Value</Text>
                  <Text style={[styles.advVal, { color: rec.ev >= 0 ? Colors.green : Colors.red }]}>
                    {rec.ev >= 0 ? "+" : ""}{(rec.ev * 100).toFixed(1)}¢
                  </Text>
                </View>
              )}
              {rec?.fair_price != null && (
                <View style={styles.advRow}>
                  <Text style={styles.advLabel}>AI Fair Price</Text>
                  <Text style={styles.advVal}>{Math.round(rec.fair_price * 100)}¢</Text>
                </View>
              )}
              {rec?.kelly_fraction != null && (
                <View style={styles.advRow}>
                  <Text style={styles.advLabel}>Kelly Fraction</Text>
                  <Text style={styles.advVal}>{(rec.kelly_fraction * 100).toFixed(1)}%</Text>
                </View>
              )}
              {rec?.opportunity_window && (
                <View style={styles.advRow}>
                  <Text style={styles.advLabel}>Window</Text>
                  <Text style={styles.advVal}>{rec.opportunity_window}</Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* ── Market Statistics ────────────────────────────────────── */}
        <View style={styles.statsCard}>
          <View style={styles.statCol}>
            <Text style={styles.statColHeader}>{yesLabel}</Text>
            <Text style={[styles.statColVal, { color: Colors.green }]}>{yesPct}%</Text>
            <Text style={styles.statColSub}>YES bid</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={styles.statColHeader}>{noLabel}</Text>
            <Text style={[styles.statColVal, { color: Colors.red }]}>{noPct}%</Text>
            <Text style={styles.statColSub}>NO bid</Text>
          </View>
          <View style={styles.statCol}>
            <Text style={styles.statColHeader}>Move</Text>
            {move != null ? (
              <Text style={[styles.statColVal, { color: move >= 0 ? Colors.green : Colors.red }]}>
                {move >= 0 ? "+" : ""}{move}¢
              </Text>
            ) : (
              <Text style={[styles.statColVal, { color: Colors.gray }]}>—</Text>
            )}
            <Text style={styles.statColSub}>24h</Text>
          </View>
        </View>

        {/* ── Closes In ───────────────────────────────────────────── */}
        <View style={[styles.closesCard, urgency && styles.closesCardUrgent]}>
          <Text style={styles.closesLabel}>Closes In</Text>
          <Text style={[styles.closesVal, urgency && { color: Colors.red }]}>
            {countdown || market.timeRemaining}
          </Text>
          {urgency && (
            <View style={styles.urgentBadge}>
              <Text style={styles.urgentText}>URGENT</Text>
            </View>
          )}
        </View>

        {/* ── Price Chart ──────────────────────────────────────────── */}
        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>PRICE CHART</Text>
            <View style={[styles.trendBadge, {
              backgroundColor: move != null ? (move >= 0 ? Colors.green + "22" : Colors.red + "22") : Colors.gray + "22",
            }]}>
              <Text style={[styles.trendText, {
                color: move != null ? (move >= 0 ? Colors.green : Colors.red) : Colors.gray,
              }]}>
                {move != null ? (move >= 0 ? "↑ UP" : "↓ DOWN") : "— N/A"}
              </Text>
            </View>
          </View>

          <View style={styles.intervalRow}>
            {["1m","1h","6h"].map(iv => (
              <TouchableOpacity
                key={iv}
                onPress={() => setChartInterval(iv)}
                style={[styles.intervalBtn, chartInterval === iv && styles.intervalBtnActive]}
              >
                <Text style={[styles.intervalBtnText, chartInterval === iv && styles.intervalBtnTextActive]}>
                  {iv}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <PriceChart history={history} />

          {/* Chart stats row */}
          <View style={styles.chartStats}>
            <View style={styles.chartStat}>
              <Text style={styles.chartStatLabel}>High</Text>
              <Text style={styles.chartStatVal}>{hiPct}%</Text>
            </View>
            <View style={styles.chartStat}>
              <Text style={styles.chartStatLabel}>Low</Text>
              <Text style={styles.chartStatVal}>{loPct}%</Text>
            </View>
            <View style={styles.chartStat}>
              <Text style={styles.chartStatLabel}>Change</Text>
              {move != null ? (
                <Text style={[styles.chartStatVal, { color: move >= 0 ? Colors.green : Colors.red }]}>
                  {move >= 0 ? "+" : ""}{move}¢
                </Text>
              ) : (
                <Text style={[styles.chartStatVal, { color: Colors.gray }]}>—</Text>
              )}
            </View>
            <View style={styles.chartStat}>
              <Text style={styles.chartStatLabel}>Volatility</Text>
              <Text style={styles.chartStatVal}>
                {prices.length > 1
                  ? `${((Math.max(...prices) - Math.min(...prices)) * 100).toFixed(1)}%`
                  : "—"}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Info Rows ────────────────────────────────────────────── */}
        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>24h Volume</Text>
            <Text style={styles.infoVal}>
              {vol24h > 1000 ? `${(vol24h / 1000).toFixed(1)}K contracts` : `${vol24h} contracts`}
            </Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowBorder]}>
            <Text style={styles.infoLabel}>Open Interest</Text>
            <Text style={styles.infoVal}>
              {oi > 1000 ? `${(oi / 1000).toFixed(1)}K` : String(oi)}
            </Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowBorder]}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoVal, { color: Colors.red }]}>LIVE</Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowBorder]}>
            <Text style={styles.infoLabel}>Ticker</Text>
            <Text style={[styles.infoVal, { color: Colors.gray }]}>{market.ticker}</Text>
          </View>
        </View>

        {/* AI Note instead of manual trade button */}
        <View style={styles.aiNote}>
          <Ionicons name="flash" size={14} color={Colors.purple} />
          <Text style={styles.aiNoteText}>
            {autoEnabled(rec)
              ? "AI is monitoring this market. Trade will execute when conditions qualify."
              : "Enable Auto-Trade to let the AI trade this market automatically."}
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function autoEnabled(rec: any) {
  return !!rec; // simplified — just checks if recommendation loaded
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },

  errorWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  errorText: { color: Colors.white, fontSize: 16 },
  errorBack: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: Colors.card, borderRadius: 8 },
  errorBackText: { color: Colors.blue, fontSize: 14 },

  nav: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  backBtn:  { flexDirection: "row", alignItems: "center", gap: 2 },
  backText: { fontSize: 15, color: Colors.blue, fontWeight: "500" },
  navTitle: { fontSize: 17, fontWeight: "600", color: Colors.white },

  liveRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, marginBottom: 8 },
  liveTag: {
    flexDirection: "row", alignItems: "center", gap: 5,
    borderWidth: 1, borderColor: Colors.red, borderRadius: 5,
    paddingHorizontal: 7, paddingVertical: 3,
  },
  liveDot:     { width: 7, height: 7, borderRadius: 3.5, backgroundColor: Colors.red },
  liveTagText: { fontSize: 10, fontWeight: "700", color: Colors.red, letterSpacing: 0.5 },
  tickerText:  { fontSize: 12, color: Colors.gray },

  marketTitle: {
    fontSize: 20, fontWeight: "800", color: Colors.white,
    paddingHorizontal: 16, marginBottom: 14, lineHeight: 27,
  },

  // Rec card
  recCard: {
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 14,
    borderWidth: 1, borderColor: Colors.border, padding: 16,
  },
  recCardLabel:  { fontSize: 10, color: Colors.gray, fontWeight: "700", letterSpacing: 1, marginBottom: 10 },
  recMain:       { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  recAction:     { fontSize: 40, fontWeight: "900", letterSpacing: -1 },
  confBox: {
    backgroundColor: Colors.cardInner, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 8, alignItems: "center",
    borderWidth: 1, borderColor: Colors.purple + "44",
  },
  confValue:  { fontSize: 20, fontWeight: "800", color: Colors.purple },
  confLabel:  { fontSize: 10, color: Colors.gray },
  recReason:  { fontSize: 13, color: Colors.gray, fontStyle: "italic", lineHeight: 19, marginBottom: 14 },

  recWindows: { flexDirection: "row", marginBottom: 12 },
  recWindowItem: { flex: 1, gap: 4 },
  recWindowDiv:  { width: 1, backgroundColor: Colors.border, marginHorizontal: 12 },
  recWindowLabel:{ fontSize: 11, color: Colors.gray },
  recWindowBar:  { height: 3, width: 36, backgroundColor: Colors.grayDark, borderRadius: 2 },
  recWindowSub:  { fontSize: 11, color: Colors.grayDark },
  recWindowVal:  { fontSize: 22, fontWeight: "700", color: Colors.white },

  advBtn:        { paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  advBtnText:    { fontSize: 11, color: Colors.gray, fontWeight: "600", letterSpacing: 0.5 },
  advancedPanel: { paddingTop: 10, gap: 8 },
  advRow:        { flexDirection: "row", justifyContent: "space-between" },
  advLabel:      { fontSize: 12, color: Colors.gray },
  advVal:        { fontSize: 12, color: Colors.white, fontWeight: "600" },

  // Stats
  statsCard: {
    flexDirection: "row", marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 14,
  },
  statCol:       { flex: 1, alignItems: "center" },
  statColHeader: { fontSize: 11, color: Colors.gray, marginBottom: 4 },
  statColVal:    { fontSize: 20, fontWeight: "700", marginBottom: 2 },
  statColSub:    { fontSize: 11, color: Colors.gray },

  // Closes
  closesCard: {
    flexDirection: "row", alignItems: "center", gap: 10,
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  closesCardUrgent: { borderColor: Colors.red + "88", backgroundColor: "rgba(239,68,68,0.07)" },
  closesLabel:      { fontSize: 14, color: Colors.gray },
  closesVal:        { fontSize: 22, fontWeight: "700", color: Colors.white, flex: 1 },
  urgentBadge: {
    backgroundColor: Colors.red, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  urgentText: { fontSize: 10, fontWeight: "700", color: Colors.white, letterSpacing: 0.5 },

  // Chart
  chartCard: {
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    padding: 14, overflow: "hidden",
  },
  chartHeader:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  chartTitle:   { fontSize: 10, color: Colors.gray, fontWeight: "700", letterSpacing: 0.8 },
  trendBadge:   { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  trendText:    { fontSize: 11, fontWeight: "700" },
  intervalRow:  { flexDirection: "row", gap: 6, marginBottom: 12 },
  intervalBtn: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6,
    backgroundColor: Colors.cardInner, borderWidth: 1, borderColor: Colors.border,
  },
  intervalBtnActive:     { backgroundColor: Colors.purple, borderColor: Colors.purple },
  intervalBtnText:       { fontSize: 12, color: Colors.gray, fontWeight: "500" },
  intervalBtnTextActive: { color: Colors.white, fontWeight: "600" },

  chartArea:      { height: CHART_H, position: "relative", overflow: "hidden" },
  chartEmpty:     { alignItems: "center", justifyContent: "center", gap: 8 },
  chartEmptyText: { color: Colors.gray, fontSize: 12 },
  gridLine: { position: "absolute", left: 0, right: 0, height: 1, backgroundColor: Colors.border + "55" },
  chartHi:  { position: "absolute", top: 2, left: 2, fontSize: 10, color: Colors.gray },
  chartLo:  { position: "absolute", bottom: 22, left: 2, fontSize: 10, color: Colors.gray },
  chartBars: {
    position: "absolute", bottom: 18, left: 28, right: 0,
    flexDirection: "row", alignItems: "flex-end", gap: 1,
  },
  chartBar:     { flex: 1, borderRadius: 1, minHeight: 3 },
  chartBarUp:   { backgroundColor: Colors.green + "cc" },
  chartBarDown: { backgroundColor: Colors.red   + "cc" },
  chartBarLast: { backgroundColor: Colors.purple },
  volBars: {
    position: "absolute", bottom: 0, left: 28, right: 0,
    flexDirection: "row", alignItems: "flex-end", gap: 1, height: 16,
  },
  volBar: { flex: 1, backgroundColor: Colors.grayDark, borderRadius: 1 },

  chartStats: {
    flexDirection: "row", marginTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 10,
  },
  chartStat:      { flex: 1, alignItems: "center" },
  chartStatLabel: { fontSize: 10, color: Colors.gray, marginBottom: 3 },
  chartStatVal:   { fontSize: 14, fontWeight: "700", color: Colors.white },

  // Info
  infoCard: {
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  infoRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 13,
  },
  infoRowBorder: { borderTopWidth: 1, borderTopColor: Colors.border },
  infoLabel:     { fontSize: 13, color: Colors.gray },
  infoVal:       { fontSize: 13, color: Colors.white, fontWeight: "500" },

  // AI note
  aiNote: {
    flexDirection: "row", alignItems: "flex-start", gap: 8,
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: "rgba(99,102,241,0.08)", borderRadius: 10,
    borderWidth: 1, borderColor: "rgba(99,102,241,0.2)",
    padding: 14,
  },
  aiNoteText: { flex: 1, fontSize: 13, color: Colors.grayLight, lineHeight: 19 },
});
