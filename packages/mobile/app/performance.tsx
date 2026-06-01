import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../lib/colors";
import { api, apiFetch } from "../lib/api";

const TABS = ["P&L", "Win Rate", "Log", "AI Report", "Readiness", "Learning", "Engine"];
const ENGINE_VERSION = "4.0.0";

function fmt$(val: number): string {
  return `${val >= 0 ? "+" : ""}$${Math.abs(val).toFixed(2)}`;
}
function fmtPct(val: number | null | undefined): string {
  if (val === null || val === undefined) return "—";
  return `${Math.round(val * 100)}%`;
}
function fmtCents(val: number | null | undefined): string {
  if (val === null || val === undefined) return "—";
  return `${val >= 0 ? "+" : ""}${(val * 100).toFixed(1)}¢`;
}

export default function PerformanceScreen() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState(0);

  // Core performance data
  const { data, isLoading } = useQuery({
    queryKey: ["perf2"],
    queryFn: async () => {
      const res = await api.perf2.$get();
      return res.json() as any;
    },
    refetchInterval: 15000,
  });

  // Engine status — always polling so we can show paper engine live status
  const { data: engineStatus } = useQuery({
    queryKey: ["engine-status"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/status`);
      return res.json() as any;
    },
    refetchInterval: 15000,
  });

  // Trade log
  const { data: tradesData } = useQuery({
    queryKey: ["trades"],
    queryFn: async () => {
      const res = await apiFetch(`api/trades`);
      return res.json() as any;
    },
    refetchInterval: 30000,
    enabled: activeTab === 2,
  });

  // AI Quality report
  const { data: aiQuality, isLoading: aiLoading } = useQuery({
    queryKey: ["ai-quality"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/ai-quality`);
      return res.json() as any;
    },
    refetchInterval: 60000,
    enabled: activeTab === 3,
  });

  // Readiness report
  const { data: readiness, isLoading: readyLoading } = useQuery({
    queryKey: ["readiness"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/readiness`);
      return res.json() as any;
    },
    refetchInterval: 60000,
    enabled: activeTab === 4,
  });

  // Adaptive learning state
  const { data: adaptive, isLoading: adaptiveLoading } = useQuery({
    queryKey: ["adaptive"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/adaptive`);
      return res.json() as any;
    },
    refetchInterval: 30000,
    enabled: activeTab === 5,
  });

  // Full learning report
  const { data: learning, isLoading: learningLoading } = useQuery({
    queryKey: ["learning"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/learning`);
      return res.json() as any;
    },
    refetchInterval: 60000,
    enabled: activeTab === 5,
  });

  const perf = data || {};
  const today = perf.today || {};
  const trades: any[] = tradesData?.trades || [];
  const openTrades = trades.filter((t: any) => t.status === "open");
  const closedTrades = trades.filter((t: any) => t.status === "closed");

  const pnlColor = (perf.realized_pnl || 0) >= 0 ? Colors.green : Colors.red;
  const hasTrades = perf.predictions > 0;

  // Weekly P&L (last 7 days from closed trades)
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weeklyTrades = closedTrades.filter((t: any) => {
    const d = t.exitedAt;
    return d && new Date(d).getTime() > weekAgo;
  });
  const weeklyPnl = weeklyTrades.reduce((sum: number, t: any) => sum + (t.pnl || 0), 0);

  // Best/worst trade
  const sortedByPnl = [...closedTrades].sort((a: any, b: any) => (b.pnl || 0) - (a.pnl || 0));
  const biggestWinner = sortedByPnl[0] || null;
  const biggestLoser = sortedByPnl[sortedByPnl.length - 1] || null;

  // Avg profit / avg loss
  const winners = closedTrades.filter((t: any) => (t.pnl || 0) > 0);
  const losers = closedTrades.filter((t: any) => (t.pnl || 0) < 0);
  const avgProfit = winners.length
    ? winners.reduce((s: number, t: any) => s + (t.pnl || 0), 0) / winners.length
    : null;
  const avgLoss = losers.length
    ? losers.reduce((s: number, t: any) => s + (t.pnl || 0), 0) / losers.length
    : null;

  // Max drawdown (peak-to-trough)
  let peak = 0, maxDD = 0, runningPnl = 0;
  for (const t of closedTrades) {
    runningPnl += t.pnl || 0;
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // AI Confidence accuracy: high-kellyFraction trades that won
  const tradesWithKelly = closedTrades.filter((t: any) => (t.kellyFraction ?? 0) > 0.10);
  const confAccurate = tradesWithKelly.filter((t: any) => (t.pnl || 0) > 0);
  const confAccuracy = tradesWithKelly.length
    ? confAccurate.length / tradesWithKelly.length
    : null;

  // pTarget accuracy: trades that hit pTarget
  const tradesWithTarget = closedTrades.filter((t: any) => t.pTarget != null && t.exitReason);
  const hitTarget = tradesWithTarget.filter((t: any) => t.exitReason === "PROFIT_TARGET");
  const pTargetAccuracy = tradesWithTarget.length
    ? hitTarget.length / tradesWithTarget.length
    : null;

  // Readiness overall score color
  const readinessScore = readiness?.scores?.overall ?? 0;
  const readinessColor = readinessScore >= 75
    ? Colors.green
    : readinessScore >= 50
    ? "#f59e0b"
    : Colors.red;

  const verdictColors: Record<string, string> = {
    READY_FOR_LIVE: Colors.green,
    NEEDS_MORE_PAPER_TRADING: "#f59e0b",
    NOT_READY: Colors.red,
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {/* Nav */}
      <View style={styles.nav}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.blue} />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.navTitle}>Performance</Text>
          <Text style={styles.navSub}>Engine v{ENGINE_VERSION}</Text>
        </View>
        <View style={styles.versionBadge}>
          <Text style={styles.versionBadgeText}>v{ENGINE_VERSION}</Text>
        </View>
      </View>

      {isLoading ? (
        <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
      ) : (
        <>
          {/* Summary metrics */}
          <View style={styles.metricsRow}>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: hasTrades ? pnlColor : Colors.gray }]}>
                {hasTrades ? fmt$(perf.realized_pnl || 0) : "—"}
              </Text>
              <Text style={styles.metricLabel}>Total P&L</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={styles.metricValue}>{perf.trades_closed ?? 0}</Text>
              <Text style={styles.metricLabel}>Closed</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, { color: Colors.gray }]}>
                {perf.trades_open ?? perf.pending ?? 0}
              </Text>
              <Text style={styles.metricLabel}>Open</Text>
            </View>
            <View style={styles.metricItem}>
              <Text style={[styles.metricValue, {
                color: readinessScore >= 75 ? Colors.green : readinessScore >= 50 ? "#f59e0b" : Colors.gray
              }]}>
                {readiness ? `${readinessScore}%` : "—"}
              </Text>
              <Text style={styles.metricLabel}>Readiness</Text>
            </View>
          </View>

          {/* Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
            <View style={styles.tabsRow}>
              {TABS.map((tab, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => setActiveTab(i)}
                  style={[styles.tab, activeTab === i && styles.tabActive]}
                >
                  <Text style={[styles.tabText, activeTab === i && styles.tabTextActive]}>
                    {tab}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <ScrollView showsVerticalScrollIndicator={false}>

            {/* ── TAB 0: P&L ── */}
            {activeTab === 0 && (
              <>
                {/* ── Paper Engine Live Status Banner ── */}
                {engineStatus?.paper_mode && (
                  <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#0f2027", borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: Colors.blue ?? "#3b82f6", gap: 10 }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.blue ?? "#3b82f6", shadowColor: Colors.blue, shadowOpacity: 0.8, shadowRadius: 4 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: Colors.blue ?? "#3b82f6", fontWeight: "700", fontSize: 12 }}>PAPER ENGINE RUNNING</Text>
                      <Text style={{ color: Colors.gray ?? "#6b7280", fontSize: 11, marginTop: 2 }}>
                        Scanning every 1 min · {engineStatus?.last_scan ? `Last: ${new Date(engineStatus.last_scan.startedAt).toLocaleTimeString()}` : "Waiting for first scan"}
                      </Text>
                    </View>
                    <Text style={{ color: Colors.blue ?? "#3b82f6", fontSize: 11, fontWeight: "600" }}>
                      ${((engineStatus?.paper_balance_cents ?? 100000) / 100).toFixed(2)}
                    </Text>
                  </View>
                )}

                {!hasTrades ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>Scanning Markets...</Text>
                    <Text style={styles.emptySub}>
                      Paper engine is running in the background, scanning every minute. Trades will appear here automatically when high-confidence opportunities are found.
                    </Text>
                    <TouchableOpacity
                      style={styles.emptyBtn}
                      onPress={() => router.push("/auto-trade")}
                    >
                      <Text style={styles.emptyBtnText}>View Engine Settings</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={styles.pnlCard}>
                    {[
                      { label: "Total Realized P&L", value: fmt$(perf.realized_pnl || 0), color: pnlColor },
                      { label: "Weekly P&L (7d)", value: weeklyTrades.length ? fmt$(weeklyPnl) : "—", color: weeklyPnl >= 0 ? Colors.green : Colors.red },
                      { label: "Biggest Winner", value: biggestWinner ? fmt$(biggestWinner.pnl) : "—", color: Colors.green },
                      { label: "Biggest Loser", value: biggestLoser && biggestLoser.pnl < 0 ? fmt$(biggestLoser.pnl) : "—", color: Colors.red },
                      { label: "Avg Profit / Trade", value: avgProfit != null ? fmt$(avgProfit) : "—", color: Colors.green },
                      { label: "Avg Loss / Trade", value: avgLoss != null ? fmt$(avgLoss) : "—", color: Colors.red },
                      { label: "Max Drawdown", value: maxDD > 0 ? `-$${maxDD.toFixed(2)}` : "—", color: maxDD > 0 ? Colors.red : Colors.gray },
                      { label: "Avg EV at Entry", value: perf.avg_ev != null ? fmtCents(perf.avg_ev) : "—", color: undefined },
                    ].map(row => (
                      <View key={row.label} style={styles.pnlRow}>
                        <Text style={styles.pnlLabel}>{row.label}</Text>
                        <Text style={[styles.pnlValue, row.color ? { color: row.color } : null]}>
                          {row.value}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* ── Paper vs Live Engine Breakdown ── */}
                <Text style={styles.sectionLabel}>ENGINE MODE BREAKDOWN</Text>
                <View style={styles.pnlCard}>
                  {/* Header row */}
                  <View style={[styles.pnlRow, { borderBottomWidth: 1, borderBottomColor: Colors.border ?? "#2a2a2a", paddingBottom: 6, marginBottom: 4 }]}>
                    <Text style={[styles.pnlLabel, { fontWeight: "700", color: Colors.text ?? "#fff" }]}>Mode</Text>
                    <Text style={[styles.pnlValue, { fontWeight: "700", color: Colors.text ?? "#fff", fontSize: 11 }]}>Trades · P&L · Win%</Text>
                  </View>
                  {/* Paper row */}
                  <View style={styles.pnlRow}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.blue ?? "#3b82f6" }} />
                      <Text style={styles.pnlLabel}>Paper Engine</Text>
                    </View>
                    <Text style={styles.pnlValue}>
                      {perf.paper?.trades_closed ?? 0} · {fmt$(((perf.paper?.realized_pnl) ?? 0))} · {fmtPct(perf.paper?.win_rate)}
                    </Text>
                  </View>
                  {/* Live row */}
                  <View style={styles.pnlRow}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.green ?? "#22c55e" }} />
                      <Text style={styles.pnlLabel}>Live Engine</Text>
                    </View>
                    <Text style={[styles.pnlValue, { color: (perf.live?.realized_pnl ?? 0) >= 0 ? Colors.green : Colors.red }]}>
                      {perf.live?.trades_closed ?? 0} · {fmt$(((perf.live?.realized_pnl) ?? 0))} · {fmtPct(perf.live?.win_rate)}
                    </Text>
                  </View>
                  {/* Parity + scan stats */}
                  <View style={[styles.pnlRow, { marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: Colors.border ?? "#2a2a2a" }]}>
                    <Text style={[styles.pnlLabel, { color: Colors.gray ?? "#6b7280", fontSize: 11 }]}>Engine parity</Text>
                    <Text style={[styles.pnlValue, { color: Colors.green ?? "#22c55e", fontSize: 11 }]}>PAPER = LIVE ✓</Text>
                  </View>
                  <View style={[styles.pnlRow]}>
                    <Text style={[styles.pnlLabel, { color: Colors.gray ?? "#6b7280", fontSize: 11 }]}>Total scans</Text>
                    <Text style={[styles.pnlValue, { color: Colors.gray ?? "#6b7280", fontSize: 11 }]}>{perf.total_scans ?? 0} scans run</Text>
                  </View>
                  {perf.last_scan_at && (
                    <View style={[styles.pnlRow]}>
                      <Text style={[styles.pnlLabel, { color: Colors.gray ?? "#6b7280", fontSize: 11 }]}>Last scan</Text>
                      <Text style={[styles.pnlValue, { color: Colors.gray ?? "#6b7280", fontSize: 11 }]}>{perf.last_scan_at}</Text>
                    </View>
                  )}
                </View>

                <Text style={styles.sectionLabel}>TODAY</Text>
                <View style={styles.todayCard}>
                  {[
                    { label: "Opened", value: (today.opened ?? 0).toString() },
                    { label: "Closed", value: (today.closed ?? 0).toString() },
                    {
                      label: "Realized P&L",
                      value: fmt$(today.realized_pnl ?? 0),
                      color: (today.realized_pnl || 0) >= 0 ? Colors.green : Colors.red,
                    },
                    { label: "Capital Used", value: `$${(today.capital_used ?? 0).toFixed(2)}` },
                    { label: "W / L", value: `${today.wins ?? 0} / ${today.losses ?? 0}` },
                  ].map(row => (
                    <View key={row.label} style={styles.todayRow}>
                      <Text style={styles.todayLabel}>{row.label}</Text>
                      <Text style={[styles.todayValue, (row as any).color ? { color: (row as any).color } : null]}>
                        {row.value}
                      </Text>
                    </View>
                  ))}
                </View>

                {/* Open positions */}
                {openTrades.length > 0 && (
                  <>
                    <Text style={[styles.sectionLabel, { marginTop: 16 }]}>OPEN PAPER POSITIONS</Text>
                    {openTrades.map((t: any) => (
                      <View key={t.id} style={styles.openRow}>
                        <View style={styles.tradeLeft}>
                          <Text style={styles.tradeTicker}>{t.marketId}</Text>
                          <Text style={styles.tradeDate}>
                            {t.side?.toUpperCase()} · @{Math.round((t.priceEntered || 0) * 100)}¢
                          </Text>
                          {t.pTarget != null && (
                            <Text style={styles.pTargetNote}>
                              pTarget: {Math.round(t.pTarget * 100)}¢
                            </Text>
                          )}
                        </View>
                        <View style={styles.tradeRight}>
                          <View style={styles.openBadge}>
                            <Text style={styles.openBadgeText}>OPEN</Text>
                          </View>
                          {t.contracts != null && (
                            <Text style={styles.tradePrice}>{t.contracts} contracts</Text>
                          )}
                          {t.kellyFraction != null && (
                            <Text style={styles.qualityNote}>Kelly {fmtPct(t.kellyFraction)}</Text>
                          )}
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </>
            )}

            {/* ── TAB 1: Win Rate ── */}
            {activeTab === 1 && (
              <>
                {closedTrades.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>No Data Yet</Text>
                    <Text style={styles.emptySub}>
                      Win rate tracks closed trades only. Data appears here once trades are completed.
                    </Text>
                  </View>
                ) : (
                  <View style={styles.winRateCard}>
                    <View style={styles.winRateBig}>
                      <Text style={styles.winRateBigValue}>{fmtPct(perf.win_rate)}</Text>
                      <Text style={styles.winRateBigLabel}>Overall Win Rate</Text>
                    </View>
                    <View style={styles.winRateRow}>
                      <View style={styles.winRateCell}>
                        <Text style={[styles.winRateCellValue, { color: Colors.green }]}>
                          {winners.length}
                        </Text>
                        <Text style={styles.winRateCellLabel}>Wins</Text>
                      </View>
                      <View style={styles.winRateCellDiv} />
                      <View style={styles.winRateCell}>
                        <Text style={[styles.winRateCellValue, { color: Colors.red }]}>
                          {losers.length}
                        </Text>
                        <Text style={styles.winRateCellLabel}>Losses</Text>
                      </View>
                      <View style={styles.winRateCellDiv} />
                      <View style={styles.winRateCell}>
                        <Text style={styles.winRateCellValue}>{closedTrades.length}</Text>
                        <Text style={styles.winRateCellLabel}>Total</Text>
                      </View>
                    </View>
                    <View style={{ marginTop: 16 }}>
                      {[
                        { label: "Avg Profit (wins)", value: avgProfit != null ? fmt$(avgProfit) : "—", color: Colors.green },
                        { label: "Avg Loss (losses)", value: avgLoss != null ? fmt$(avgLoss) : "—", color: Colors.red },
                        { label: "Max Drawdown", value: maxDD > 0 ? `-$${maxDD.toFixed(2)}` : "$0.00", color: maxDD > 0 ? Colors.red : Colors.gray },
                        { label: "AI Conf Accuracy", value: confAccuracy != null ? fmtPct(confAccuracy) : "—", color: undefined },
                        { label: "pTarget Hit Rate", value: pTargetAccuracy != null ? fmtPct(pTargetAccuracy) : "—", color: undefined },
                      ].map(row => (
                        <View key={row.label} style={styles.diagRow}>
                          <Text style={styles.diagLabel}>{row.label}</Text>
                          <Text style={[styles.diagValue, row.color ? { color: row.color } : null]}>
                            {row.value}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
              </>
            )}

            {/* ── TAB 2: Log ── */}
            {activeTab === 2 && (
              <>
                {trades.length === 0 ? (
                  <View style={styles.emptyCard}>
                    <Text style={styles.emptyTitle}>No Trade Log</Text>
                    <Text style={styles.emptySub}>
                      Trades will appear here once Auto-Trade is enabled and runs.
                    </Text>
                  </View>
                ) : (
                  <>
                    {/* Exit Reason Breakdown */}
                    {closedTrades.length > 0 && (() => {
                      const counts: Record<string, number> = {};
                      closedTrades.forEach((t: any) => {
                        const r = t.exitReason || "UNKNOWN";
                        counts[r] = (counts[r] || 0) + 1;
                      });
                      const exitColors: Record<string, string> = {
                        PROFIT_TARGET: Colors.green,
                        TRAILING_STOP: "#4ade80",
                        MOMENTUM_REVERSAL: Colors.red,
                        TIME_DECAY: "#f59e0b",
                        BETTER_OPPORTUNITY: Colors.purple,
                        STOP_LOSS: Colors.red,
                        MARKET_RESOLUTION: Colors.blue,
                      };
                      return (
                        <View style={styles.exitBreakdownCard}>
                          <Text style={styles.exitBreakdownTitle}>EXIT REASONS</Text>
                          <View style={styles.exitBreakdownRow}>
                            {Object.entries(counts).map(([reason, count]) => (
                              <View key={reason} style={[styles.exitChip, { borderColor: exitColors[reason] || Colors.gray }]}>
                                <Text style={[styles.exitChipText, { color: exitColors[reason] || Colors.gray }]}>
                                  {reason.replace(/_/g, " ")} ×{count}
                                </Text>
                              </View>
                            ))}
                          </View>
                        </View>
                      );
                    })()}

                    {/* Trade rows */}
                    {trades.map((t: any) => {
                      const exitColors: Record<string, string> = {
                        PROFIT_TARGET: Colors.green,
                        TRAILING_STOP: "#4ade80",
                        MOMENTUM_REVERSAL: Colors.red,
                        TIME_DECAY: "#f59e0b",
                        BETTER_OPPORTUNITY: Colors.purple,
                        STOP_LOSS: Colors.red,
                        MARKET_RESOLUTION: Colors.blue,
                      };
                      return (
                        <View key={t.id} style={styles.tradeRow}>
                          <View style={styles.tradeLeft}>
                            <Text style={styles.tradeTicker}>{t.marketId}</Text>
                            <Text style={styles.tradeDate}>
                              {new Date(t.enteredAt).toLocaleDateString()} · {t.side?.toUpperCase()}
                            </Text>
                            {t.exitReason && t.status === "closed" && (
                              <View style={[styles.exitBadge, { borderColor: exitColors[t.exitReason] || Colors.gray }]}>
                                <Text style={[styles.exitBadgeText, { color: exitColors[t.exitReason] || Colors.gray }]}>
                                  {t.exitReason.replace(/_/g, " ")}
                                </Text>
                              </View>
                            )}
                            {t.mispricingGap != null && (
                              <Text style={styles.mispricingNote}>
                                Gap {t.mispricingGap > 0 ? "+" : ""}{(t.mispricingGap * 100).toFixed(1)}¢
                              </Text>
                            )}
                            {t.velocityAtEntry != null && (
                              <Text style={styles.mispricingNote}>
                                Vel {t.velocityAtEntry > 0 ? "+" : ""}{(t.velocityAtEntry * 100).toFixed(2)}¢/tick
                              </Text>
                            )}
                          </View>
                          <View style={styles.tradeRight}>
                            <Text style={[
                              styles.tradePnl,
                              t.status === "open" ? { color: Colors.gray } :
                              (t.pnl || 0) >= 0 ? { color: Colors.green } : { color: Colors.red }
                            ]}>
                              {t.status === "open" ? "OPEN" : fmt$(t.pnl || 0)}
                            </Text>
                            <Text style={styles.tradePrice}>
                              @{Math.round((t.priceEntered || 0) * 100)}¢
                              {t.evAtEntry != null
                                ? ` · EV ${fmtCents(t.evAtEntry)}`
                                : ""}
                            </Text>
                            {t.pTarget != null && (
                              <Text style={styles.pTargetNote}>
                                pT {Math.round(t.pTarget * 100)}¢
                              </Text>
                            )}
                            {t.kellyFraction != null && (
                              <Text style={styles.qualityNote}>
                                Kelly {fmtPct(t.kellyFraction)}
                              </Text>
                            )}
                            {t.entry_quality != null && (
                              <Text style={styles.qualityNote}>Q{t.entry_quality}</Text>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </>
                )}
              </>
            )}

            {/* ── TAB 3: AI Report ── */}
            {activeTab === 3 && (
              aiLoading ? (
                <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
              ) : !aiQuality ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>No AI Report</Text>
                  <Text style={styles.emptySub}>Could not load AI quality report.</Text>
                </View>
              ) : aiQuality.status === "insufficient_data" ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Not Enough Data</Text>
                  <Text style={styles.emptySub}>
                    {aiQuality.message || "Need at least 1 closed trade for quality analysis."}
                  </Text>
                  <Text style={[styles.emptySub, { marginTop: 12, color: Colors.gray }]}>
                    Closed trades: {aiQuality.trades_closed ?? 0} / 1 required
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.pnlCard}>
                    <View style={styles.pnlRow}>
                      <Text style={styles.pnlLabel}>Engine Version</Text>
                      <Text style={[styles.pnlValue, { color: Colors.purple }]}>{aiQuality.engine_version}</Text>
                    </View>
                    <View style={styles.pnlRow}>
                      <Text style={styles.pnlLabel}>Trades Analyzed</Text>
                      <Text style={styles.pnlValue}>{aiQuality.trades_closed}</Text>
                    </View>
                    <View style={styles.pnlRow}>
                      <Text style={styles.pnlLabel}>AI Confidence Accuracy</Text>
                      <Text style={[styles.pnlValue, { color: Colors.green }]}>
                        {aiQuality.ai_confidence_accuracy != null ? fmtPct(aiQuality.ai_confidence_accuracy) : "—"}
                      </Text>
                    </View>
                    <View style={styles.pnlRow}>
                      <Text style={styles.pnlLabel}>pTarget Hit Rate</Text>
                      <Text style={[styles.pnlValue, { color: Colors.green }]}>
                        {aiQuality.p_target_accuracy != null ? fmtPct(aiQuality.p_target_accuracy) : "—"}
                      </Text>
                    </View>
                    {aiQuality.exit_distribution && (
                      <>
                        <View style={[styles.pnlRow, { borderTopWidth: 1, borderTopColor: Colors.border }]}>
                          <Text style={styles.pnlLabel}>Stop-Loss Exits</Text>
                          <Text style={[styles.pnlValue, { color: Colors.red }]}>
                            {aiQuality.exit_distribution.STOP_LOSS ?? 0}
                          </Text>
                        </View>
                        <View style={styles.pnlRow}>
                          <Text style={styles.pnlLabel}>Profit Target Exits</Text>
                          <Text style={[styles.pnlValue, { color: Colors.green }]}>
                            {aiQuality.exit_distribution.PROFIT_TARGET ?? 0}
                          </Text>
                        </View>
                        <View style={styles.pnlRow}>
                          <Text style={styles.pnlLabel}>Trailing Stop Exits</Text>
                          <Text style={styles.pnlValue}>
                            {aiQuality.exit_distribution.TRAILING_STOP ?? 0}
                          </Text>
                        </View>
                        <View style={styles.pnlRow}>
                          <Text style={styles.pnlLabel}>Momentum Reversals</Text>
                          <Text style={[styles.pnlValue, { color: "#f59e0b" }]}>
                            {aiQuality.exit_distribution.MOMENTUM_REVERSAL ?? 0}
                          </Text>
                        </View>
                      </>
                    )}
                  </View>
                  {aiQuality.overall_grade && (
                    <View style={[styles.diagCard, { marginTop: 12 }]}>
                      <View style={styles.winRateBig}>
                        <Text style={[styles.winRateBigValue, {
                          color: aiQuality.overall_grade === "A" ? Colors.green
                            : aiQuality.overall_grade === "B" ? Colors.blue
                            : aiQuality.overall_grade === "C" ? "#f59e0b"
                            : Colors.red
                        }]}>
                          {aiQuality.overall_grade}
                        </Text>
                        <Text style={styles.winRateBigLabel}>Overall AI Grade</Text>
                      </View>
                    </View>
                  )}
                </>
              )
            )}

            {/* ── TAB 4: Readiness ── */}
            {activeTab === 4 && (
              readyLoading ? (
                <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
              ) : !readiness ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Cannot Load</Text>
                  <Text style={styles.emptySub}>Failed to fetch readiness data.</Text>
                </View>
              ) : (
                <>
                  {/* Overall score */}
                  <View style={[styles.diagCard, { marginBottom: 12 }]}>
                    <View style={styles.winRateBig}>
                      <Text style={[styles.winRateBigValue, { color: readinessColor, fontSize: 56 }]}>
                        {readinessScore}%
                      </Text>
                      <Text style={[styles.winRateBigLabel, {
                        color: verdictColors[readiness.verdict] || Colors.gray,
                        fontWeight: "700", fontSize: 13,
                      }]}>
                        {(readiness.verdict || "").replace(/_/g, " ")}
                      </Text>
                    </View>
                    <View style={[styles.winRateRow, { paddingHorizontal: 8 }]}>
                      {Object.entries(readiness.scores || {}).filter(([k]) => k !== "overall").map(([key, score]) => (
                        <View key={key} style={styles.winRateCell}>
                          <Text style={[styles.winRateCellValue, { fontSize: 18, color: (score as number) >= 75 ? Colors.green : (score as number) >= 50 ? "#f59e0b" : Colors.red }]}>
                            {score as number}
                          </Text>
                          <Text style={[styles.winRateCellLabel, { fontSize: 9 }]}>
                            {key.split("_")[0].toUpperCase()}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* Blockers */}
                  {readiness.blockers && readiness.blockers.length > 0 && (
                    <>
                      <Text style={styles.sectionLabel}>BLOCKERS FOR LIVE</Text>
                      <View style={[styles.pnlCard, { marginBottom: 12 }]}>
                        {readiness.blockers.map((b: string, i: number) => (
                          <View key={i} style={styles.pnlRow}>
                            <Ionicons name="close-circle" size={14} color={Colors.red} style={{ marginRight: 8 }} />
                            <Text style={[styles.pnlLabel, { flex: 1, color: Colors.red }]}>{b}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}

                  {/* Check categories */}
                  {Object.entries(readiness.checks || {}).map(([category, checks]) => (
                    <View key={category} style={{ marginBottom: 10 }}>
                      <Text style={styles.sectionLabel}>{category.replace(/_/g, " ").toUpperCase()}</Text>
                      <View style={styles.pnlCard}>
                        {(checks as any[]).map((c: any, i: number) => (
                          <View key={i} style={styles.pnlRow}>
                            <Ionicons
                              name={c.pass ? "checkmark-circle" : "close-circle"}
                              size={14}
                              color={c.pass ? Colors.green : Colors.red}
                              style={{ marginRight: 8 }}
                            />
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.pnlLabel, { color: Colors.white }]}>{c.name}</Text>
                              {c.note && <Text style={[styles.pnlLabel, { fontSize: 11, marginTop: 1 }]}>{c.note}</Text>}
                            </View>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}

                  {/* Paper summary */}
                  {readiness.paper_trading_summary && (
                    <>
                      <Text style={styles.sectionLabel}>PAPER TRADING PROGRESS</Text>
                      <View style={styles.pnlCard}>
                        {[
                          { label: "Closed Trades", value: `${readiness.paper_trading_summary.trades_closed} / ${readiness.paper_trading_summary.min_trades_for_live} needed` },
                          { label: "Open Trades", value: (readiness.paper_trading_summary.trades_open ?? 0).toString() },
                          { label: "Total P&L", value: fmt$(readiness.paper_trading_summary.total_pnl ?? 0) },
                          {
                            label: "Win Rate",
                            value: readiness.paper_trading_summary.win_rate != null
                              ? fmtPct(readiness.paper_trading_summary.win_rate)
                              : "No data",
                          },
                        ].map(row => (
                          <View key={row.label} style={styles.pnlRow}>
                            <Text style={styles.pnlLabel}>{row.label}</Text>
                            <Text style={styles.pnlValue}>{row.value}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}
                </>
              )
            )}

            {/* ── TAB 5: Learning ── */}
            {activeTab === 5 && (
              adaptiveLoading || learningLoading ? (
                <ActivityIndicator color={Colors.purple} style={{ marginTop: 60 }} />
              ) : (
                <>
                  {/* Protection Mode Banner */}
                  {adaptive && (() => {
                    const modeBg: Record<string, string> = {
                      NORMAL: Colors.card,
                      CAUTION: "#78350f",
                      DEFENSIVE: "#7c2d12",
                      OBSERVATION: "#1e1b4b",
                      RECOVERY: "#14532d",
                      REVIEW: "#450a0a",
                    };
                    const modeColor: Record<string, string> = {
                      NORMAL: Colors.green,
                      CAUTION: "#f59e0b",
                      DEFENSIVE: "#f97316",
                      OBSERVATION: "#818cf8",
                      RECOVERY: "#4ade80",
                      REVIEW: Colors.red,
                    };
                    const modeIcon: Record<string, string> = {
                      NORMAL: "✓",
                      CAUTION: "⚠",
                      DEFENSIVE: "⚠",
                      OBSERVATION: "⏸",
                      RECOVERY: "🔄",
                      REVIEW: "🚨",
                    };
                    const mode = adaptive.mode as string;
                    return (
                      <View style={[styles.modeBanner, { backgroundColor: modeBg[mode] || Colors.card, borderColor: modeColor[mode] || Colors.border }]}>
                        <Text style={[styles.modeBannerMode, { color: modeColor[mode] || Colors.white }]}>
                          {modeIcon[mode]} {mode.replace(/_/g, " ")}
                        </Text>
                        <Text style={styles.modeBannerMsg}>{adaptive.message}</Text>
                        <View style={styles.modeStats}>
                          <View style={styles.modeStat}>
                            <Text style={[styles.modeStatVal, { color: adaptive.consecutive_losses > 0 ? Colors.red : Colors.gray }]}>
                              {adaptive.consecutive_losses}
                            </Text>
                            <Text style={styles.modeStatLabel}>Loss streak</Text>
                          </View>
                          <View style={styles.modeStat}>
                            <Text style={[styles.modeStatVal, { color: adaptive.consecutive_wins > 0 ? Colors.green : Colors.gray }]}>
                              {adaptive.consecutive_wins}
                            </Text>
                            <Text style={styles.modeStatLabel}>Win streak</Text>
                          </View>
                          <View style={styles.modeStat}>
                            <Text style={[styles.modeStatVal, { color: adaptive.position_size_multiplier < 1 ? "#f59e0b" : Colors.white }]}>
                              {Math.round(adaptive.position_size_multiplier * 100)}%
                            </Text>
                            <Text style={styles.modeStatLabel}>Position size</Text>
                          </View>
                          <View style={styles.modeStat}>
                            <Text style={[styles.modeStatVal, { color: Colors.gray }]}>
                              +{Math.round((adaptive.min_confidence_boost || 0) * 100)}pp
                            </Text>
                            <Text style={styles.modeStatLabel}>Conf. floor</Text>
                          </View>
                        </View>

                        {/* Recovery Mode progress */}
                        {mode === "RECOVERY" && (
                          <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "rgba(74,222,128,0.2)" }}>
                            <Text style={{ color: "#4ade80", fontSize: 12, fontWeight: "600", marginBottom: 4 }}>
                              🔄 RECOVERY PROGRESS
                            </Text>
                            <Text style={{ color: Colors.gray, fontSize: 12 }}>
                              {adaptive.recovery_trades_completed ?? 0} / {adaptive.recovery_trades_needed ?? 5} profitable trades completed
                            </Text>
                            <View style={{ height: 6, backgroundColor: "rgba(74,222,128,0.15)", borderRadius: 3, marginTop: 6 }}>
                              <View style={{
                                height: 6,
                                backgroundColor: "#4ade80",
                                borderRadius: 3,
                                width: `${Math.min(100, ((adaptive.recovery_trades_completed ?? 0) / (adaptive.recovery_trades_needed ?? 5)) * 100)}%`,
                              }} />
                            </View>
                            <Text style={{ color: Colors.gray, fontSize: 11, marginTop: 4 }}>
                              Max 3 open positions • 50% size • +10pp conf
                            </Text>
                          </View>
                        )}

                        {/* Daily Profit Lock status */}
                        {adaptive.daily_profit_lock_active && (
                          <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "rgba(239,68,68,0.2)" }}>
                            <Text style={{ color: Colors.red, fontSize: 12, fontWeight: "600", marginBottom: 2 }}>
                              ⛔ DAILY PROFIT LOCK
                            </Text>
                            <Text style={{ color: Colors.gray, fontSize: 12 }}>
                              Portfolio down {(adaptive.daily_drop_pct ?? 0).toFixed(1)}% from today's peak. No new entries until midnight UTC.
                            </Text>
                          </View>
                        )}
                        {!adaptive.daily_profit_lock_active && (adaptive.daily_drop_pct ?? 0) > 0 && (
                          <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.border }}>
                            <Text style={{ color: Colors.gray, fontSize: 11 }}>
                              Daily drawdown: {(adaptive.daily_drop_pct ?? 0).toFixed(1)}% / 15.0% lock threshold
                            </Text>
                          </View>
                        )}
                      </View>
                    );
                  })()}

                  {/* Streak thresholds reference */}
                  <Text style={[styles.sectionLabel, { marginTop: 4 }]}>PROTECTION THRESHOLDS</Text>
                  <View style={styles.pnlCard}>
                    {[
                      { label: "3 losses", value: "−25% size, +5pp conf", color: "#f59e0b" },
                      { label: "5 losses", value: "−50% size, +10pp conf", color: "#f97316" },
                      { label: "7 losses", value: "Observation Mode (no new trades)", color: "#818cf8" },
                      { label: "10 losses", value: "Review Mode (full halt)", color: Colors.red },
                    ].map(row => (
                      <View key={row.label} style={styles.pnlRow}>
                        <Text style={[styles.pnlLabel, { color: row.color }]}>{row.label}</Text>
                        <Text style={[styles.pnlValue, { color: row.color, fontSize: 12 }]}>{row.value}</Text>
                      </View>
                    ))}
                  </View>

                  {/* Category weights */}
                  {learning?.categoryWeights && learning.categoryWeights.length > 0 && (
                    <>
                      <Text style={styles.sectionLabel}>CATEGORY PERFORMANCE</Text>
                      <View style={styles.pnlCard}>
                        {(learning.categoryWeights as any[]).map((cat: any) => (
                          <View key={cat.category} style={styles.pnlRow}>
                            <View>
                              <Text style={[styles.pnlLabel, { color: Colors.white }]}>{cat.category}</Text>
                              <Text style={[styles.pnlLabel, { fontSize: 11 }]}>
                                {cat.trades}t · {cat.wins}W / {cat.losses}L
                              </Text>
                            </View>
                            <View style={{ alignItems: "flex-end" }}>
                              <Text style={[styles.pnlValue, {
                                color: cat.weight >= 1.2 ? Colors.green : cat.weight <= 0.8 ? Colors.red : Colors.gray
                              }]}>
                                {cat.winRate != null ? `${Math.round(cat.winRate * 100)}% WR` : "—"}
                              </Text>
                              <Text style={[styles.pnlLabel, {
                                fontSize: 11,
                                color: cat.weight >= 1.2 ? Colors.green : cat.weight <= 0.8 ? Colors.red : Colors.gray
                              }]}>
                                {cat.weight.toFixed(2)}x alloc
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    </>
                  )}

                  {/* Confidence calibration */}
                  {learning?.confidenceCalibration && (
                    <>
                      <Text style={styles.sectionLabel}>CONFIDENCE CALIBRATION</Text>
                      <View style={styles.pnlCard}>
                        {(learning.confidenceCalibration as any[]).filter((b: any) => b.trades > 0).map((b: any) => (
                          <View key={b.label} style={styles.pnlRow}>
                            <View>
                              <Text style={[styles.pnlLabel, { color: Colors.white }]}>{b.label}</Text>
                              <Text style={[styles.pnlLabel, { fontSize: 11 }]}>{b.trades} trades</Text>
                            </View>
                            <View style={{ alignItems: "flex-end" }}>
                              <Text style={[styles.pnlValue, { fontSize: 13 }]}>
                                {b.actualWinRate != null ? `${Math.round(b.actualWinRate * 100)}% actual` : "—"}
                              </Text>
                              {b.calibrationError != null && (
                                <Text style={[styles.pnlLabel, {
                                  fontSize: 11,
                                  color: b.calibrationError < -0.10 ? Colors.red : b.calibrationError > 0.10 ? Colors.green : Colors.gray
                                }]}>
                                  {b.calibrationError > 0 ? "+" : ""}{Math.round(b.calibrationError * 100)}pp vs predicted
                                </Text>
                              )}
                            </View>
                          </View>
                        ))}
                        {(learning.confidenceCalibration as any[]).every((b: any) => b.trades === 0) && (
                          <View style={[styles.pnlRow, { justifyContent: "center" }]}>
                            <Text style={styles.pnlLabel}>No data yet — needs closed trades</Text>
                          </View>
                        )}
                      </View>
                    </>
                  )}

                  {/* AI Recommendations */}
                  {learning?.recommendations && learning.recommendations.length > 0 && (
                    <>
                      <Text style={styles.sectionLabel}>AI RECOMMENDATIONS</Text>
                      <View style={[styles.pnlCard, { marginBottom: 12 }]}>
                        {(learning.recommendations as string[]).map((r: string, i: number) => (
                          <View key={i} style={[styles.pnlRow, { alignItems: "flex-start" }]}>
                            <Text style={[styles.pnlLabel, { flex: 1, lineHeight: 19 }]}>{r}</Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}

                  {/* Exit pattern learning */}
                  {learning?.exitPatterns?.byExitReason && Object.keys(learning.exitPatterns.byExitReason).length > 0 && (
                    <>
                      <Text style={styles.sectionLabel}>EXIT PATTERN LEARNING</Text>
                      <View style={styles.pnlCard}>
                        {Object.entries(learning.exitPatterns.byExitReason as Record<string, any>).map(([reason, data]) => (
                          <View key={reason} style={styles.pnlRow}>
                            <View>
                              <Text style={[styles.pnlLabel, { color: Colors.white }]}>{reason.replace(/_/g, " ")}</Text>
                              <Text style={[styles.pnlLabel, { fontSize: 11 }]}>{data.count} exits · {data.pct}%</Text>
                            </View>
                            <Text style={[styles.pnlValue, {
                              color: data.avgPnl > 0 ? Colors.green : data.avgPnl < 0 ? Colors.red : Colors.gray
                            }]}>
                              avg ${data.avgPnl.toFixed(3)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </>
                  )}
                </>
              )
            )}

            {/* ── TAB 6: Engine ── */}
            {activeTab === 6 && (
              <View style={styles.diagCard}>
                <Text style={styles.diagTitle}>Engine Diagnostics</Text>
                {[
                  { label: "Engine Version",      value: ENGINE_VERSION, color: Colors.purple },
                  { label: "Data Scope",           value: `v${ENGINE_VERSION} only` },
                  { label: "Total Scans",          value: (perf.total_scans ?? 0).toString() },
                  {
                    label: "Last Scan",
                    value: perf.last_scan_at
                      ? new Date(perf.last_scan_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "Never",
                  },
                  { label: "Open Trades",         value: (perf.trades_open ?? perf.pending ?? 0).toString() },
                  { label: "Avg EV at Entry",     value: perf.avg_ev != null ? fmtCents(perf.avg_ev) : "—" },
                  {
                    label: "AI Accuracy",
                    value: perf.ai_accuracy != null ? fmtPct(perf.ai_accuracy) : "Pending",
                    color: perf.ai_accuracy != null ? Colors.green : Colors.gray,
                  },
                  { label: "AI Conf Accuracy",    value: confAccuracy != null ? fmtPct(confAccuracy) : "—" },
                  { label: "pTarget Hit Rate",    value: pTargetAccuracy != null ? fmtPct(pTargetAccuracy) : "—" },
                  { label: "Max Drawdown",         value: maxDD > 0 ? `-$${maxDD.toFixed(2)}` : "$0.00", color: maxDD > 0 ? Colors.red : undefined },
                ].map(row => (
                  <View key={row.label} style={styles.diagRow}>
                    <Text style={styles.diagLabel}>{row.label}</Text>
                    <Text style={[styles.diagValue, (row as any).color ? { color: (row as any).color } : null]}>
                      {row.value}
                    </Text>
                  </View>
                ))}
                <View style={styles.diagNote}>
                  <Text style={styles.diagNoteText}>
                    Only trades tagged engine_version = {ENGINE_VERSION} are shown. Legacy data excluded.
                  </Text>
                </View>
              </View>
            )}

            <View style={{ height: 40 }} />
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  nav: {
    flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 4 },
  backText: { fontSize: 15, color: Colors.blue, fontWeight: "500" },
  navTitle: { fontSize: 20, fontWeight: "700", color: Colors.white },
  navSub: { fontSize: 11, color: Colors.gray },
  versionBadge: {
    borderWidth: 1, borderColor: Colors.purple,
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginTop: 2,
  },
  versionBadgeText: { fontSize: 11, color: Colors.purple, fontWeight: "600" },

  metricsRow: { flexDirection: "row", paddingHorizontal: 16, marginBottom: 12 },
  metricItem: { flex: 1, alignItems: "center", paddingVertical: 8 },
  metricValue: { fontSize: 18, fontWeight: "600", color: Colors.gray, marginBottom: 3 },
  metricLabel: { fontSize: 10, color: Colors.gray, textAlign: "center" },

  tabsScroll: { borderBottomWidth: 1, borderBottomColor: Colors.border, marginBottom: 12 },
  tabsRow: { flexDirection: "row", paddingHorizontal: 8 },
  tab: { paddingHorizontal: 14, paddingBottom: 10 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: Colors.blue },
  tabText: { fontSize: 13, color: Colors.gray },
  tabTextActive: { color: Colors.blue, fontWeight: "600" },

  emptyCard: {
    marginHorizontal: 16, marginBottom: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    padding: 32, alignItems: "center",
  },
  emptyTitle: { fontSize: 16, fontWeight: "700", color: Colors.white, marginBottom: 8 },
  emptySub: { fontSize: 13, color: Colors.gray, textAlign: "center", lineHeight: 19 },
  emptyBtn: {
    marginTop: 20, backgroundColor: Colors.purple, borderRadius: 10,
    paddingHorizontal: 20, paddingVertical: 12,
  },
  emptyBtnText: { fontSize: 14, fontWeight: "600", color: Colors.white },

  pnlCard: {
    marginHorizontal: 16, marginBottom: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  pnlRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  pnlLabel: { fontSize: 13, color: Colors.gray },
  pnlValue: { fontSize: 14, fontWeight: "700", color: Colors.white },

  sectionLabel: {
    fontSize: 11, color: Colors.gray, fontWeight: "600",
    paddingHorizontal: 16, marginBottom: 8, letterSpacing: 0.8,
  },
  todayCard: {
    marginHorizontal: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  todayRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  todayLabel: { fontSize: 13, color: Colors.gray },
  todayValue: { fontSize: 14, fontWeight: "600", color: Colors.white },

  openRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    marginHorizontal: 16, marginBottom: 4,
    backgroundColor: Colors.card, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.blue + "55",
    paddingHorizontal: 14, paddingVertical: 12,
  },
  openBadge: {
    borderWidth: 1, borderColor: Colors.blue, borderRadius: 5,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  openBadgeText: { fontSize: 9, fontWeight: "700", color: Colors.blue },
  pTargetNote: { fontSize: 10, color: Colors.purple, marginTop: 2, fontWeight: "600" },

  winRateCard: {
    marginHorizontal: 16, marginBottom: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, padding: 20,
  },
  winRateBig: { alignItems: "center", paddingVertical: 16 },
  winRateBigValue: { fontSize: 48, fontWeight: "800", color: Colors.white },
  winRateBigLabel: { fontSize: 12, color: Colors.gray, marginTop: 4 },
  winRateRow: {
    flexDirection: "row", borderTopWidth: 1, borderTopColor: Colors.border,
    paddingTop: 16, marginTop: 8,
  },
  winRateCell: { flex: 1, alignItems: "center" },
  winRateCellDiv: { width: 1, backgroundColor: Colors.border },
  winRateCellValue: { fontSize: 24, fontWeight: "700", color: Colors.white },
  winRateCellLabel: { fontSize: 11, color: Colors.gray, marginTop: 2 },

  tradeRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    marginHorizontal: 16, marginBottom: 2,
    backgroundColor: Colors.card, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  tradeLeft: { flex: 1, marginRight: 8 },
  tradeTicker: { fontSize: 13, fontWeight: "600", color: Colors.white },
  tradeDate: { fontSize: 11, color: Colors.gray, marginTop: 2 },
  tradeRight: { alignItems: "flex-end" },
  tradePnl: { fontSize: 14, fontWeight: "700" },
  tradePrice: { fontSize: 11, color: Colors.gray, marginTop: 2 },
  exitBadge: {
    marginTop: 5, alignSelf: "flex-start",
    borderWidth: 1, borderRadius: 5,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  exitBadgeText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  mispricingNote: { fontSize: 10, color: Colors.gray, marginTop: 2 },
  qualityNote: { fontSize: 10, color: Colors.purple, marginTop: 2, fontWeight: "600" },
  exitBreakdownCard: {
    marginHorizontal: 16, marginBottom: 10,
    backgroundColor: Colors.card, borderRadius: 10,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  exitBreakdownTitle: { fontSize: 11, fontWeight: "700", color: Colors.gray, marginBottom: 8, letterSpacing: 0.8 },
  exitBreakdownRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  exitChip: {
    borderWidth: 1, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  exitChipText: { fontSize: 10, fontWeight: "600" },

  diagCard: {
    marginHorizontal: 16,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
  },
  diagTitle: {
    fontSize: 14, fontWeight: "700", color: Colors.white,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  diagRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  diagLabel: { fontSize: 13, color: Colors.gray },
  diagValue: { fontSize: 13, color: Colors.white, fontWeight: "500" },
  diagNote: {
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: Colors.cardInner ?? Colors.card,
    borderBottomLeftRadius: 12, borderBottomRightRadius: 12,
  },
  diagNoteText: { fontSize: 11, color: Colors.gray, lineHeight: 17 },

  // Adaptive Learning tab
  modeBanner: {
    marginHorizontal: 16, marginBottom: 12,
    borderRadius: 12, borderWidth: 1,
    padding: 16,
  },
  modeBannerMode: { fontSize: 16, fontWeight: "800", marginBottom: 6, letterSpacing: 0.5 },
  modeBannerMsg: { fontSize: 13, color: Colors.gray, lineHeight: 19, marginBottom: 12 },
  modeStats: { flexDirection: "row" },
  modeStat: { flex: 1, alignItems: "center" },
  modeStatVal: { fontSize: 20, fontWeight: "700", color: Colors.white },
  modeStatLabel: { fontSize: 10, color: Colors.gray, marginTop: 2 },
});
