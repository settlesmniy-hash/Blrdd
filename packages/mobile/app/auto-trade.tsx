import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Switch,
  StyleSheet, ActivityIndicator, TextInput, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "../lib/colors";
import { api, apiFetch } from "../lib/api";

const TRADE_SIZE_PRESETS = ["0.01", "0.05", "0.10", "0.25", "0.50", "1.00"];
const MAX_POSITIONS_OPTIONS = ["1", "2", "3", "5", "10"];

const RISK_LEVELS = [
  { key: "conservative", label: "Conservative", sub: "Fewer trades, tighter filters" },
  { key: "balanced",     label: "Balanced",     sub: "Recommended" },
  { key: "aggressive",   label: "Aggressive",   sub: "More trades, higher risk" },
];

const CATEGORIES = [
  { key: "basketball", label: "Basketball" },
  { key: "baseball",   label: "Baseball" },
  { key: "crypto15m",  label: "Crypto 15m" },
  { key: "crypto1h",   label: "Crypto Hourly" },
];

function Divider() {
  return <View style={styles.divider} />;
}

export default function AutoTradeScreen() {
  const router = useRouter();
  const qc = useQueryClient();

  const [autoEnabled,    setAutoEnabled]    = useState(false);
  const [paperMode,      setPaperMode]      = useState(true);
  const [tradeSize,      setTradeSize]      = useState("0.25");
  const [dailyBudget,    setDailyBudget]    = useState("5.00");
  const [maxPositions,   setMaxPositions]   = useState("3");
  const [riskLevel,      setRiskLevel]      = useState("balanced");
  const [categories,     setCategories]     = useState<string[]>(["basketball","baseball","crypto15m","crypto1h"]);
  const [dirty,          setDirty]          = useState(false);

  const mark = () => setDirty(true);

  const { data: settingsData, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.settings.$get();
      return res.json() as any;
    },
  });

  const { data: statusData } = useQuery({
    queryKey: ["engine-status"],
    queryFn: async () => {
      const res = await apiFetch(`api/trade-engine/status`);
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

  useEffect(() => {
    if (!settingsData?.settings) return;
    const s = settingsData.settings;
    setAutoEnabled(s.auto_trade_enabled === "true");
    setPaperMode(s.paper_trading_enabled !== "false");
    if (s.fixed_position_size) setTradeSize(s.fixed_position_size);
    if (s.max_daily_capital)   setDailyBudget(s.max_daily_capital);
    if (s.max_open_positions)  setMaxPositions(s.max_open_positions);
    if (s.trade_mode)          setRiskLevel(s.trade_mode);
    if (s.market_filter_categories) {
      try { setCategories(JSON.parse(s.market_filter_categories)); } catch {}
    }
    setDirty(false);
  }, [settingsData]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pairs: [string, string][] = [
        ["auto_trade_enabled",         autoEnabled ? "true" : "false"],
        ["paper_trading_enabled",      paperMode ? "true" : "false"],
        ["fixed_position_size",        tradeSize],
        ["position_size_mode",         "fixed_amount"],
        ["max_daily_capital",          dailyBudget],
        ["max_open_positions",         maxPositions],
        ["trade_mode",                 riskLevel],
        ["market_filter_categories",   JSON.stringify(categories)],
        // derived from risk level
        ["min_confidence_pct",         riskLevel === "conservative" ? "70" : riskLevel === "aggressive" ? "50" : "60"],
        ["daily_loss_limit",           String(parseFloat(dailyBudget) * 0.8)],
      ];
      await Promise.all(pairs.map(([key, value]) => api.settings.$post({ json: { key, value } })));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["engine-status"] });
      setDirty(false);
      Alert.alert("Saved", "Auto-trade settings updated.");
    },
    onError: () => Alert.alert("Error", "Failed to save settings."),
  });

  const status   = statusData || {};
  const today    = perfData?.today || {};
  const lastScan = status.last_scan;

  const toggleCategory = (key: string) => {
    setCategories(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    mark();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top","left","right"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={Colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Auto-Trade</Text>
        {dirty ? (
          <TouchableOpacity
            style={styles.saveBtn}
            onPress={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending
              ? <ActivityIndicator size="small" color={Colors.white} />
              : <Text style={styles.saveBtnText}>Save</Text>}
          </TouchableOpacity>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      {isLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={Colors.purple} />
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          {/* ── AI Status Card ──────────────────────────────────────── */}
          <View style={[styles.statusCard, autoEnabled ? styles.statusCardOn : styles.statusCardOff]}>
            <View style={styles.statusCardTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.statusCardTitle}>AI Trading Engine</Text>
                <Text style={styles.statusCardSub}>
                  {autoEnabled
                    ? paperMode
                      ? "Paper mode — AI testing with simulated money"
                      : "Live — AI scanning markets with real money"
                    : "Enable to start AI scanning markets"}
                </Text>
              </View>
              <Switch
                value={autoEnabled}
                onValueChange={v => { setAutoEnabled(v); mark(); }}
                trackColor={{ false: Colors.grayDark, true: Colors.purpleDim }}
                thumbColor={autoEnabled ? Colors.purple : Colors.gray}
                ios_backgroundColor={Colors.grayDark}
              />
            </View>

            {autoEnabled && (
              <View style={styles.statusStats}>
                <View style={styles.statusStat}>
                  <Text style={styles.statusStatVal}>{status.trades_today ?? 0}</Text>
                  <Text style={styles.statusStatLabel}>Trades Today</Text>
                </View>
                <View style={styles.statusStatDiv} />
                <View style={styles.statusStat}>
                  <Text style={[styles.statusStatVal, { color: (today.realized_pnl || 0) >= 0 ? Colors.green : Colors.red }]}>
                    {(today.realized_pnl || 0) >= 0 ? "+" : ""}${((today.realized_pnl || 0)).toFixed(2)}
                  </Text>
                  <Text style={styles.statusStatLabel}>Today P&L</Text>
                </View>
                <View style={styles.statusStatDiv} />
                <View style={styles.statusStat}>
                  <Text style={styles.statusStatVal}>
                    {status.open_positions ?? 0}/{maxPositions}
                  </Text>
                  <Text style={styles.statusStatLabel}>Positions</Text>
                </View>
                <View style={styles.statusStatDiv} />
                <View style={styles.statusStat}>
                  <Text style={[styles.statusStatVal, { fontSize: 14 }]}>
                    {(status.personality || "neutral").charAt(0).toUpperCase() + (status.personality || "neutral").slice(1)}
                  </Text>
                  <Text style={styles.statusStatLabel}>AI Mode</Text>
                </View>
              </View>
            )}

            {autoEnabled && lastScan && (
              <Text style={styles.lastScanText}>
                Last scan: {lastScan.markets_scanned} markets · {lastScan.trades_executed} executed
              </Text>
            )}

            {/* Paper balance */}
            {autoEnabled && paperMode && (
              <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 6 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#3b82f6" }} />
                <Text style={{ color: "#3b82f6", fontSize: 12, fontWeight: "600" }}>
                  PAPER MODE — Balance: ${((status.paper_balance_cents ?? 100000) / 100).toFixed(2)}
                </Text>
              </View>
            )}

            {/* Live warning — only shown when NOT in paper mode */}
            {autoEnabled && !paperMode && (
              <View style={styles.liveWarning}>
                <Ionicons name="warning" size={13} color={Colors.orange} />
                <Text style={styles.liveWarningText}>LIVE mode — real money on Kalshi</Text>
              </View>
            )}
          </View>

          {/* ── Paper / Live Mode Toggle ─────────────────────────────── */}
          <Text style={styles.sectionLabel}>TRADING MODE</Text>
          <View style={styles.card}>
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <Text style={styles.settingLabel}>Paper Mode</Text>
                <Text style={styles.settingSubLabel}>
                  {paperMode
                    ? "Simulated trades — testing AI performance"
                    : "OFF — engine will place real Kalshi orders"}
                </Text>
              </View>
              <Switch
                value={paperMode}
                onValueChange={v => { setPaperMode(v); mark(); }}
                trackColor={{ false: Colors.grayDark, true: "#1e3a5f" }}
                thumbColor={paperMode ? "#3b82f6" : Colors.gray}
                ios_backgroundColor={Colors.grayDark}
              />
            </View>
            {!paperMode && (
              <View style={[styles.liveWarning, { marginTop: 8, marginBottom: 0 }]}>
                <Ionicons name="warning" size={13} color={Colors.orange} />
                <Text style={styles.liveWarningText}>Real orders will be sent to Kalshi</Text>
              </View>
            )}
          </View>

          {/* ── Trade Size ──────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>TRADE SIZE</Text>
          <View style={styles.card}>
            <View style={styles.presetsRow}>
              {TRADE_SIZE_PRESETS.map(p => (
                <TouchableOpacity
                  key={p}
                  style={[styles.presetChip, tradeSize === p && styles.presetChipActive]}
                  onPress={() => { setTradeSize(p); mark(); }}
                >
                  <Text style={[styles.presetChipText, tradeSize === p && styles.presetChipTextActive]}>
                    ${p}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <Divider />
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>Custom Amount</Text>
              <View style={styles.inputWrap}>
                <Text style={styles.inputPrefix}>$</Text>
                <TextInput
                  style={styles.input}
                  value={tradeSize}
                  onChangeText={v => { setTradeSize(v); mark(); }}
                  keyboardType="decimal-pad"
                  placeholderTextColor={Colors.gray}
                  selectionColor={Colors.purple}
                />
              </View>
            </View>
            <View style={styles.sizeNote}>
              <Ionicons name="information-circle-outline" size={12} color={Colors.gray} />
              <Text style={styles.sizeNoteText}>AI places every trade at exactly this amount. No rounding.</Text>
            </View>
          </View>

          {/* ── Daily Budget ────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>DAILY BUDGET</Text>
          <View style={styles.card}>
            <View style={styles.settingRow}>
              <View style={styles.settingLeft}>
                <Text style={styles.settingLabel}>Daily Limit</Text>
                <Text style={styles.settingSubLabel}>Stop trading when limit is reached</Text>
              </View>
              <View style={styles.inputWrap}>
                <Text style={styles.inputPrefix}>$</Text>
                <TextInput
                  style={styles.input}
                  value={dailyBudget}
                  onChangeText={v => { setDailyBudget(v); mark(); }}
                  keyboardType="decimal-pad"
                  placeholderTextColor={Colors.gray}
                  selectionColor={Colors.purple}
                />
              </View>
            </View>
            {parseFloat(tradeSize) > 0 && parseFloat(dailyBudget) > 0 && (
              <View style={styles.budgetNote}>
                <Text style={styles.budgetNoteText}>
                  Up to {Math.floor(parseFloat(dailyBudget) / parseFloat(tradeSize))} trades at ${tradeSize} each
                </Text>
              </View>
            )}
          </View>

          {/* ── Max Open Positions ──────────────────────────────────── */}
          <Text style={styles.sectionLabel}>MAX OPEN POSITIONS</Text>
          <View style={styles.card}>
            <View style={styles.posRow}>
              {MAX_POSITIONS_OPTIONS.map(n => (
                <TouchableOpacity
                  key={n}
                  style={[styles.posChip, maxPositions === n && styles.posChipActive]}
                  onPress={() => { setMaxPositions(n); mark(); }}
                >
                  <Text style={[styles.posChipText, maxPositions === n && styles.posChipTextActive]}>{n}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {autoEnabled && (
              <>
                <View style={styles.posBarWrap}>
                  <View style={[
                    styles.posBar,
                    { width: `${Math.min(100, ((status.open_positions ?? 0) / parseInt(maxPositions || "1")) * 100)}%` },
                    (status.open_positions ?? 0) >= parseInt(maxPositions) && { backgroundColor: Colors.red },
                  ]} />
                </View>
                <Text style={styles.posNote}>
                  {(status.open_positions ?? 0) >= parseInt(maxPositions)
                    ? "Limit reached — waiting for positions to close"
                    : `${status.open_positions ?? 0} open · ${parseInt(maxPositions) - (status.open_positions ?? 0)} slot${parseInt(maxPositions) - (status.open_positions ?? 0) !== 1 ? "s" : ""} available`}
                </Text>
              </>
            )}
          </View>

          {/* ── Risk Level ──────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>RISK LEVEL</Text>
          <View style={styles.card}>
            {RISK_LEVELS.map((r, i) => (
              <React.Fragment key={r.key}>
                {i > 0 && <Divider />}
                <TouchableOpacity
                  style={styles.settingRow}
                  onPress={() => { setRiskLevel(r.key); mark(); }}
                >
                  <View style={styles.settingLeft}>
                    <Text style={styles.settingLabel}>{r.label}</Text>
                    <Text style={styles.settingSubLabel}>{r.sub}</Text>
                  </View>
                  <View style={[styles.radio, riskLevel === r.key && styles.radioActive]}>
                    {riskLevel === r.key && <View style={styles.radioDot} />}
                  </View>
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>

          {/* ── Categories ──────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>CATEGORIES</Text>
          <View style={styles.catsGrid}>
            {CATEGORIES.map(cat => {
              const active = categories.includes(cat.key);
              return (
                <TouchableOpacity
                  key={cat.key}
                  style={[styles.catChip, active && styles.catChipActive]}
                  onPress={() => toggleCategory(cat.key)}
                >
                  {active && <Ionicons name="checkmark" size={13} color={Colors.purple} />}
                  <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                    {cat.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {categories.length === 0 && (
            <Text style={styles.catWarning}>No categories selected — AI won't find any markets</Text>
          )}

          {/* ── How It Works ────────────────────────────────────────── */}
          <Text style={styles.sectionLabel}>HOW IT WORKS</Text>
          <View style={styles.infoCard}>
            {[
              { icon: "flash-outline",           text: "Turn on Auto-Trade. The AI handles everything — scanning, entering, managing, and exiting." },
              { icon: "analytics-outline",       text: "Every trade must have positive expected value. Low-confidence signals are skipped automatically." },
              { icon: "layers-outline",          text: "Max Open Positions caps your simultaneous exposure. New trades pause when the limit is reached." },
              { icon: "shield-checkmark-outline",text: "Daily budget enforced. AI stops trading once the limit is hit, regardless of opportunities." },
              { icon: "pulse-outline",           text: "AI adapts: more aggressive when win rate is high, more conservative when it dips." },
            ].map(({ icon, text }, i) => (
              <View key={i} style={styles.infoRow}>
                <Ionicons name={icon as any} size={15} color={Colors.purple} style={styles.infoIcon} />
                <Text style={styles.infoText}>{text}</Text>
              </View>
            ))}
          </View>

          <View style={{ height: 48 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: Colors.bg },
  scroll:        { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  loadingWrap:   { flex: 1, alignItems: "center", justifyContent: "center" },

  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 8,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: Colors.white },
  saveBtn: {
    paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: Colors.purple, borderRadius: 8, alignItems: "center",
  },
  saveBtnText: { color: Colors.white, fontWeight: "600", fontSize: 14 },

  // Status card
  statusCard: {
    margin: 16, borderRadius: 14,
    borderWidth: 1, padding: 16,
  },
  statusCardOn:  { backgroundColor: "#0a1a12", borderColor: "#166534" },
  statusCardOff: { backgroundColor: Colors.card, borderColor: Colors.border },
  statusCardTop: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    marginBottom: 4,
  },
  statusCardTitle: { fontSize: 15, fontWeight: "700", color: Colors.white },
  statusCardSub:   { fontSize: 12, color: Colors.gray, marginTop: 2 },
  statusStats: {
    flexDirection: "row", alignItems: "center",
    marginTop: 14, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  statusStat:      { flex: 1, alignItems: "center" },
  statusStatVal:   { fontSize: 17, fontWeight: "700", color: Colors.white },
  statusStatLabel: { fontSize: 10, color: Colors.gray, marginTop: 2, textAlign: "center" },
  statusStatDiv:   { width: 1, height: 32, backgroundColor: Colors.border },
  lastScanText: { fontSize: 11, color: Colors.gray, marginTop: 10 },
  liveWarning: {
    flexDirection: "row", alignItems: "center", gap: 5,
    marginTop: 10, backgroundColor: "rgba(249,115,22,0.1)",
    borderRadius: 6, padding: 8,
  },
  liveWarningText: { fontSize: 11, color: Colors.orange, fontWeight: "500" },

  // Generic card
  card: {
    marginHorizontal: 16, marginBottom: 12,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, overflow: "hidden",
  },
  divider: { height: 1, backgroundColor: Colors.border },

  sectionLabel: {
    fontSize: 10, fontWeight: "700", color: Colors.gray,
    letterSpacing: 1, paddingHorizontal: 16, marginTop: 8, marginBottom: 6,
  },

  settingRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 14, gap: 12,
  },
  settingLeft:    { flex: 1 },
  settingLabel:   { fontSize: 14, fontWeight: "500", color: Colors.white },
  settingSubLabel:{ fontSize: 11, color: Colors.gray, marginTop: 2 },

  // Input
  inputWrap: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.cardInner, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  inputPrefix: { color: Colors.gray, fontSize: 15, marginRight: 3 },
  input: { color: Colors.white, fontSize: 16, fontWeight: "600", minWidth: 50, textAlign: "right" },

  // Presets
  presetsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: 14 },
  presetChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 8, backgroundColor: Colors.cardInner,
    borderWidth: 1, borderColor: Colors.border,
  },
  presetChipActive:     { backgroundColor: Colors.purpleDim, borderColor: Colors.purple },
  presetChipText:       { fontSize: 14, fontWeight: "600", color: Colors.gray },
  presetChipTextActive: { color: Colors.purple },

  sizeNote: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  sizeNoteText: { fontSize: 11, color: Colors.gray },

  budgetNote: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  budgetNoteText: { fontSize: 11, color: Colors.grayLight },

  // Positions
  posRow: {
    flexDirection: "row", justifyContent: "space-around",
    padding: 14,
  },
  posChip: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: Colors.cardInner, borderWidth: 1.5, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center",
  },
  posChipActive:     { backgroundColor: Colors.purpleDim, borderColor: Colors.purple },
  posChipText:       { fontSize: 17, fontWeight: "700", color: Colors.gray },
  posChipTextActive: { color: Colors.purple },
  posBarWrap: {
    height: 5, backgroundColor: Colors.cardInner,
    borderRadius: 3, marginHorizontal: 14, marginBottom: 6, overflow: "hidden",
  },
  posBar: { height: 5, backgroundColor: Colors.purple, borderRadius: 3, minWidth: 4 },
  posNote: { fontSize: 11, color: Colors.gray, textAlign: "center", paddingBottom: 12 },

  // Radio
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center",
  },
  radioActive: { borderColor: Colors.purple },
  radioDot:    { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.purple },

  // Categories
  catsGrid: {
    flexDirection: "row", flexWrap: "wrap", gap: 10,
    paddingHorizontal: 16, marginBottom: 8,
  },
  catChip: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 20, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  catChipActive:     { borderColor: Colors.purple, backgroundColor: "rgba(99,102,241,0.12)" },
  catChipText:       { fontSize: 13, color: Colors.gray, fontWeight: "500" },
  catChipTextActive: { color: Colors.purple, fontWeight: "600" },
  catWarning:        { fontSize: 12, color: Colors.orange, paddingHorizontal: 16, marginBottom: 8 },

  // Info card
  infoCard: {
    marginHorizontal: 16, marginBottom: 4,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    padding: 14, gap: 12,
  },
  infoRow:  { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  infoIcon: { marginTop: 1 },
  infoText: { flex: 1, fontSize: 13, color: Colors.grayLight, lineHeight: 19 },
});
